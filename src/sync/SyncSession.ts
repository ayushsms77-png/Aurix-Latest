import { RealtimeClient } from '@supabase/realtime-js';
import type { RealtimeChannel } from '@supabase/realtime-js';
import { URL as PolyURL, URLSearchParams as PolyURLSearchParams } from 'react-native-url-polyfill';
import { compareStates, hasSeat, isNewer, RateGate, sortMembers } from './syncLogic';
import { serverNow, type SyncConfig } from './syncServer';
import {
  MemberPresence,
  parsePlaylist,
  parsePresence,
  parseState,
  RoomState,
  SYNC,
  SyncTrack,
} from './syncTypes';

/**
 * One Sync Play room, from this device's point of view.
 *
 * A room is a Supabase Realtime channel (Broadcast for commands, Presence for
 * who is here). Nothing is stored anywhere: the room lives in the memory of the
 * devices inside it, which is also what lets a device that dropped out catch up
 * again -- any device still in the room can hand it the current state.
 *
 * This class knows nothing about audio. It tells its owner (useSyncPlay) when
 * the shared state changes, and sends the owner's commands to everyone else.
 */

export type Connection = 'connecting' | 'online' | 'offline';

export type RosterEntry = MemberPresence & { me: boolean; offline: boolean };

export type SessionHandlers = {
  /** Roster or connection changed. */
  onChange: () => void;
  /** The shared state changed. `forced`: apply it even if it looks unchanged (rejoin / first state). */
  onState: (s: RoomState, local: boolean, forced: boolean) => void;
  /** The room can not continue. */
  onFatal: (message: string) => void;
  /** Someone else joined after we did. */
  onMemberJoined: (m: MemberPresence) => void;
};

export type SyncErrorKind = 'not_found' | 'full' | 'collision' | 'connect';

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  constructor(kind: SyncErrorKind, message: string) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * realtime-js reads/writes URL fields that React Native's built-in URL does not
 * support. Give it a spec-compliant URL ONLY while it is being constructed, so
 * nothing else in the app sees a different global.
 */
function withUrlPolyfill<T>(fn: () => T): T {
  const g = globalThis as unknown as { URL: unknown; URLSearchParams: unknown };
  const savedUrl = g.URL;
  const savedParams = g.URLSearchParams;
  g.URL = PolyURL;
  g.URLSearchParams = PolyURLSearchParams;
  try {
    return fn();
  } finally {
    g.URL = savedUrl;
    g.URLSearchParams = savedParams;
  }
}

type Ghost = { member: MemberPresence; leftAt: number };

export class SyncSession {
  readonly code: string;
  readonly me: { id: string; name: string; joinedAt: number };

  playlist: SyncTrack[] | null;
  state: RoomState | null;
  connection: Connection = 'connecting';

  private readonly cfg: SyncConfig;
  private readonly handlers: SessionHandlers;

  private client: RealtimeClient | null = null;
  private channel: RealtimeChannel | null = null;
  private closed = false;
  private subscribedOnce = false;

  private myPresence: MemberPresence;
  private present: MemberPresence[] = [];
  private lastPresent = new Map<string, MemberPresence>();
  private ghosts = new Map<string, Ghost>();
  private gone = new Set<string>(); // left on purpose (said "bye")
  private presenceSynced = false;

  private offlineSince = 0;
  private aloneSince = 0;
  private resyncUntil = 0;
  private lastRebuildAt = 0;
  private stateRecvCount = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rate = new RateGate(SYNC.MAX_MSG_PER_SEC);

  constructor(args: {
    code: string;
    deviceId: string;
    name: string;
    cfg: SyncConfig;
    handlers: SessionHandlers;
    /** Host only: the playlist and starting state. */
    seed?: { playlist: SyncTrack[]; state: RoomState };
  }) {
    this.code = args.code;
    this.cfg = args.cfg;
    this.handlers = args.handlers;
    this.me = { id: args.deviceId, name: args.name, joinedAt: serverNow() };
    this.myPresence = {
      id: this.me.id,
      name: this.me.name,
      joinedAt: this.me.joinedAt,
      loadedIdx: -1,
      err: false,
    };
    this.playlist = args.seed?.playlist ?? null;
    this.state = args.seed?.state ?? null;
  }

  // ---- public ------------------------------------------------------------

  /** Host: open the room. Throws SyncError('collision') if the code is already in use. */
  async host(): Promise<void> {
    try {
      await this.connectTransport();
      await this.waitForPresenceSync(1800);
      const others = this.present.filter((m) => m.id !== this.me.id);
      if (others.length > 0) {
        throw new SyncError('collision', 'That room code is already in use.');
      }
      this.startTicking();
    } catch (e) {
      this.close(true); // no half-open connection, and no "reconnecting" ghost on the others
      throw e;
    }
  }

  /** Guest: join a room that someone else opened. */
  async join(): Promise<void> {
    try {
      await this.connectTransport();
      const started = Date.now();
      let lastHello = 0;
      for (;;) {
        if (this.closed) throw new SyncError('connect', 'Cancelled.');
        if (this.playlist && this.state) break;
        const elapsed = Date.now() - started;
        if (Date.now() - lastHello > 1500) {
          lastHello = Date.now();
          this.send('hello', { id: this.me.id });
        }
        const others = this.present.filter((m) => m.id !== this.me.id);
        if (elapsed > SYNC.NOT_FOUND_AFTER_MS && this.presenceSynced && others.length === 0) {
          throw new SyncError('not_found', 'Room not found. Check the code and try again.');
        }
        if (elapsed > SYNC.JOIN_TIMEOUT_MS) {
          throw new SyncError('not_found', 'Could not join that room. Check the code and try again.');
        }
        await sleep(120);
      }

      // Seats go to the first MAX_MEMBERS devices by join time. A device that
      // turns out to be 5th leaves again.
      const everyone = this.present.some((m) => m.id === this.me.id)
        ? this.present
        : [...this.present, this.myPresence];
      if (!hasSeat(everyone, this.me.id)) {
        throw new SyncError('full', `This room is full (max ${SYNC.MAX_MEMBERS} devices).`);
      }
      this.startTicking();
    } catch (e) {
      // Say goodbye so the others never show this refused/failed device as "reconnecting".
      this.close(true);
      throw e;
    }
  }

  /** The shared timeline, changed by this device (play, pause, next, previous). */
  commit(patch: Partial<Pick<RoomState, 'idx' | 'playing' | 'pos' | 'at'>>): RoomState | null {
    if (!this.state || this.connection !== 'online') return null;
    const s: RoomState = { ...this.state, ...patch, rev: this.state.rev + 1, by: this.me.id };
    this.state = s;
    this.send('state', { s });
    this.handlers.onState(s, true, false);
    return s;
  }

  /** Tell the others which song this device has loaded (or failed to load). */
  setPresence(patch: Partial<Pick<MemberPresence, 'loadedIdx' | 'err'>>): void {
    const next = { ...this.myPresence, ...patch };
    if (next.loadedIdx === this.myPresence.loadedIdx && next.err === this.myPresence.err) return;
    this.myPresence = next;
    this.trackPresence();
    this.refreshPresent(); // our own view updates immediately
  }

  roster(): RosterEntry[] {
    const list: RosterEntry[] = [];
    const seen = new Set<string>();
    for (const m of this.present) {
      seen.add(m.id);
      list.push({ ...m, me: m.id === this.me.id, offline: false });
    }
    if (!seen.has(this.me.id)) {
      list.push({ ...this.myPresence, me: true, offline: this.connection === 'offline' });
    }
    for (const g of this.ghosts.values()) {
      if (!seen.has(g.member.id)) list.push({ ...g.member, me: false, offline: true });
    }
    return sortMembers(list);
  }

  /** Present devices (not ghosts), including this one. */
  presentMembers(): MemberPresence[] {
    return this.present.some((m) => m.id === this.me.id)
      ? this.present
      : [...this.present, this.myPresence];
  }

  /** Call when the app returns to the foreground. */
  ensureAlive(): void {
    if (this.closed || this.connection === 'online') return;
    this.rebuild();
  }

  close(intentional: boolean): void {
    if (this.closed) return;
    if (intentional) this.send('bye', { id: this.me.id });
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.teardownTransport();
  }

  // ---- transport ---------------------------------------------------------

  private connectTransport(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => done(new SyncError('connect', "Couldn't connect to Sync Play. Check your connection.")),
        10_000
      );

      try {
        const wsUrl = this.cfg.url.replace(/^http/i, 'ws') + '/realtime/v1';
        const { client, channel } = withUrlPolyfill(() => {
          const c = new RealtimeClient(wsUrl, {
            params: { apikey: this.cfg.key },
            heartbeatIntervalMs: 20_000,
            timeout: 10_000,
          });
          const ch = c.channel(`sync:${this.code}`, {
            config: {
              broadcast: { self: false, ack: false },
              presence: { key: this.me.id, enabled: true },
            },
          });
          return { client: c, channel: ch };
        });
        this.client = client;
        this.channel = channel;

        channel.on('broadcast', { event: 'state' }, (msg: { payload?: unknown }) =>
          this.onStateMsg(msg.payload)
        );
        channel.on('broadcast', { event: 'hello' }, (msg: { payload?: unknown }) =>
          this.onHello(msg.payload)
        );
        channel.on('broadcast', { event: 'bye' }, (msg: { payload?: unknown }) =>
          this.onBye(msg.payload)
        );
        channel.on('presence', { event: 'sync' }, () => this.refreshPresent());

        channel.subscribe((status: string) => {
          if (this.closed || channel !== this.channel) return;
          if (status === 'SUBSCRIBED') {
            this.onSubscribed();
            done();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            this.setConnection('offline');
            done(new SyncError('connect', "Couldn't connect to Sync Play. Check your connection."));
          }
        });
      } catch (e) {
        done(new SyncError('connect', "Couldn't connect to Sync Play."));
      }
    });
  }

  private onSubscribed(): void {
    const reconnect = this.subscribedOnce;
    this.subscribedOnce = true;
    this.setConnection('online');
    this.trackPresence();
    if (reconnect) {
      // We may have missed commands while away: accept the room's state as the truth.
      this.resyncUntil = Date.now() + 8000;
      this.send('hello', { id: this.me.id });
    }
  }

  private teardownTransport(): void {
    const client = this.client;
    const channel = this.channel;
    this.client = null;
    this.channel = null;
    try {
      if (channel) {
        void channel.untrack().catch(() => undefined);
        void channel.unsubscribe();
      }
    } catch {
      /* already gone */
    }
    try {
      if (client) {
        if (channel) void client.removeChannel(channel);
        void client.disconnect();
      }
    } catch {
      /* already gone */
    }
  }

  /** Replace a transport that did not come back by itself. State is kept. */
  private rebuild(): void {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastRebuildAt < 15_000) return;
    this.lastRebuildAt = now;
    this.teardownTransport();
    this.setConnection('connecting');
    this.connectTransport().catch(() => this.setConnection('offline'));
  }

  private setConnection(c: Connection): void {
    if (this.connection === c) return;
    this.connection = c;
    if (c === 'offline') {
      if (!this.offlineSince) this.offlineSince = Date.now();
    } else if (c === 'online') {
      this.offlineSince = 0;
    }
    this.handlers.onChange();
  }

  private send(event: string, payload: unknown): boolean {
    const ch = this.channel;
    // Never use the library's HTTP fallback: only send over a joined channel.
    if (!ch || ch.state !== 'joined') return false;
    try {
      void ch.send({ type: 'broadcast', event, payload }).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  private trackPresence(): void {
    const ch = this.channel;
    if (!ch || ch.state !== 'joined') return;
    try {
      void ch.track({ ...this.myPresence }).catch(() => undefined);
    } catch {
      /* retried on the next change */
    }
  }

  // ---- presence ----------------------------------------------------------

  private waitForPresenceSync(maxMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const started = Date.now();
      const check = () => {
        if (this.presenceSynced || Date.now() - started > maxMs || this.closed) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  private refreshPresent(): void {
    const ch = this.channel;
    if (!ch) return;
    let raw: Record<string, unknown[]> = {};
    try {
      raw = ch.presenceState() as unknown as Record<string, unknown[]>;
    } catch {
      return;
    }
    const map = new Map<string, MemberPresence>();
    for (const key of Object.keys(raw)) {
      const entries = Array.isArray(raw[key]) ? raw[key] : [];
      for (const entry of entries) {
        const m = parsePresence(entry);
        if (m) map.set(m.id, m);
      }
      if (map.size > 16) break; // a sane room never has this many
    }
    // Our own latest values win over the echo of an older track().
    if (map.has(this.me.id)) map.set(this.me.id, { ...this.myPresence });

    const now = Date.now();
    const wasSynced = this.presenceSynced;

    // Anyone who was here and is not any more (and did not say goodbye) is
    // "reconnecting" for the grace period.
    for (const [id, member] of this.lastPresent) {
      if (!map.has(id) && !this.gone.has(id) && id !== this.me.id) {
        if (!this.ghosts.has(id)) this.ghosts.set(id, { member, leftAt: now });
      }
    }
    for (const [id, member] of map) {
      this.ghosts.delete(id);
      this.gone.delete(id);
      if (wasSynced && id !== this.me.id && !this.lastPresent.has(id)) {
        this.handlers.onMemberJoined(member);
      }
    }

    this.lastPresent = map;
    this.present = sortMembers([...map.values()]);
    this.presenceSynced = true;

    const others = this.present.filter((m) => m.id !== this.me.id).length;
    if (others === 0) {
      if (!this.aloneSince) this.aloneSince = now;
    } else {
      this.aloneSince = 0;
    }
    this.handlers.onChange();
  }

  // ---- messages ----------------------------------------------------------

  private onStateMsg(payload: unknown): void {
    if (this.closed || !this.rate.allow(Date.now())) return;
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { s?: unknown; pl?: unknown };

    let playlist = this.playlist;
    const first = !playlist;
    if (!playlist) {
      playlist = parsePlaylist(p.pl);
      if (!playlist) return;
    }
    const s = parseState(p.s, playlist.length);
    if (!s || s.by === this.me.id) return;
    if (this.state && s.rev > this.state.rev + 1000) return; // absurd jump

    this.stateRecvCount += 1;
    if (first) this.playlist = playlist;

    const resync = Date.now() < this.resyncUntil;
    const forced = first || (resync && (!this.state || compareStates(s, this.state) >= 0));
    if (forced || isNewer(s, this.state)) {
      if (resync && forced) this.resyncUntil = 0;
      this.state = s;
      this.handlers.onState(s, false, forced);
    }
  }

  private onHello(payload: unknown): void {
    if (this.closed || !this.rate.allow(Date.now())) return;
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === this.me.id || id.length > 40) return;
    if (!this.state || !this.playlist) return;
    // Several devices may hear this; the first to answer wins, the rest stay quiet.
    const seen = this.stateRecvCount;
    setTimeout(() => {
      if (this.closed || !this.state || !this.playlist) return;
      if (this.stateRecvCount !== seen) return;
      this.send('state', { s: this.state, pl: this.playlist });
    }, 40 + Math.random() * 260);
  }

  private onBye(payload: unknown): void {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === this.me.id || id.length > 40) return;
    this.gone.add(id);
    this.ghosts.delete(id);
    this.lastPresent.delete(id);
    this.present = this.present.filter((m) => m.id !== id);
    this.handlers.onChange();
  }

  // ---- housekeeping ------------------------------------------------------

  private startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 5000);
  }

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();

    let changed = false;
    for (const [id, g] of this.ghosts) {
      if (now - g.leftAt > SYNC.GRACE_MS) {
        this.ghosts.delete(id);
        changed = true;
      }
    }

    if (this.offlineSince && now - this.offlineSince > SYNC.GRACE_MS) {
      this.handlers.onFatal(
        'You were disconnected for more than 10 minutes, so the room has expired.'
      );
      return;
    }
    if (this.connection === 'online' && this.aloneSince && now - this.aloneSince > SYNC.GRACE_MS) {
      this.handlers.onFatal('The room has closed because nobody was in it for 10 minutes.');
      return;
    }

    // The library normally reconnects by itself; if it has not after a while, start over.
    if (this.connection !== 'online' && this.offlineSince && now - this.offlineSince > 20_000) {
      this.rebuild();
    }
    if (changed) this.handlers.onChange();
  }
}
