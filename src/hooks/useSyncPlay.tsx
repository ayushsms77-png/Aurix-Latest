import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { Track } from '../core/types';
import { playbackEngine } from '../playback/PlaybackEngine';
import { progressClock } from '../playback/progressClock';
import { syncBridge } from '../sync/syncBridge';
import { allReady as everyoneReady, driftDecision, livePositionMs, sameTimeline } from '../sync/syncLogic';
import {
  Connection,
  RosterEntry,
  SessionHandlers,
  SyncError,
  SyncSession,
} from '../sync/SyncSession';
import {
  fetchSyncFlag,
  measureClock,
  serverNow,
  syncConfig,
} from '../sync/syncServer';
import {
  cleanName,
  fromSyncTrack,
  generateCode,
  generateDeviceId,
  normalizeCode,
  prepareTracks,
  RoomState,
  SYNC,
  toSyncTrack,
  SyncTrack,
} from '../sync/syncTypes';
import { usePlayer } from './usePlayer';

/**
 * Sync Play controller.
 *
 * Owns the room (SyncSession) and turns the shared state into actions on the
 * normal player: load the right song, start it at the scheduled moment, pause,
 * and gently pull this device back if it drifts. It only ever touches the
 * player while a room is open (syncBridge.active); otherwise it is idle.
 */

export type SyncPhase = 'idle' | 'connecting' | 'room';
export type SyncHealth = 'live' | 'syncing' | 'offline';

export type FlagInfo = { checked: boolean; checking: boolean; enabled: boolean; message: string };

type SyncContextType = {
  flag: FlagInfo;
  /** Re-read the on/off switch. Resolves to whether Sync Play is available. */
  refreshFlag: () => Promise<boolean>;

  phase: SyncPhase;
  /** What the connecting screen is doing right now. */
  step: string;
  /** Why the last attempt failed or the last room ended (null when none). */
  error: string | null;
  clearError: () => void;

  code: string | null;
  roster: RosterEntry[];
  tracks: Track[];
  roomState: RoomState | null;
  connection: Connection;
  health: SyncHealth;
  /** Every device that can load the song has loaded it. */
  canPlay: boolean;
  /** Bumps whenever another device joins (drives the "syncing" overlay). */
  joinPulse: number;
  myId: string;

  createRoom: (source: Track[], name: string) => void;
  joinRoom: (code: string, name: string) => void;
  leaveRoom: () => void;

  togglePlay: () => void;
  next: () => void;
  previous: () => void;
};

const SyncContext = createContext<SyncContextType | undefined>(undefined);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const SyncPlayProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const player = usePlayer();
  const playerRef = useRef(player);
  playerRef.current = player;

  // ---- UI state ----------------------------------------------------------
  const [flag, setFlag] = useState<FlagInfo>({
    checked: false,
    checking: false,
    enabled: false,
    message: '',
  });
  const [phase, setPhaseState] = useState<SyncPhase>('idle');
  const [step, setStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [health, setHealth] = useState<SyncHealth>('syncing');
  const [canPlay, setCanPlay] = useState(false);
  const [joinPulse, setJoinPulse] = useState(0);

  // ---- engine state (refs: read from timers and callbacks) ---------------
  const deviceId = useRef(generateDeviceId()).current;
  const phaseRef = useRef<SyncPhase>('idle');
  const sessionRef = useRef<SyncSession | null>(null);
  const tracksRef = useRef<Track[]>([]);
  const stateRef = useRef<RoomState | null>(null);
  const liveRef = useRef(false); // true once the room is wired up and states may be applied
  const targetIdxRef = useRef(-1); // the song this device is loading / has loaded
  const loadedIdxRef = useRef(-1); // the song that is loaded and ready
  const failedRef = useRef(false);
  const scheduleToken = useRef(0);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActionAt = useRef(0);
  const lastCorrectionAt = useRef(0);
  const lastCommandAt = useRef(0);
  const stateChangedAt = useRef(0);
  const bufferingSince = useRef(0);
  const connectingRef = useRef(false);
  /** Bumped when the user cancels / leaves, so an attempt still in flight stands down. */
  const genRef = useRef(0);

  const setPhase = useCallback((p: SyncPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const clearPlayTimer = useCallback(() => {
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
  }, []);

  // ---- snapshot of the room for the UI -----------------------------------
  const refreshUi = useCallback(() => {
    const sess = sessionRef.current;
    if (!sess) return;
    const s = stateRef.current;
    setRoster(sess.roster());
    setConnection(sess.connection);
    if (s) {
      const ready = everyoneReady(sess.presentMembers(), s.idx);
      const waitedLong = Date.now() - stateChangedAt.current > 12_000;
      setCanPlay(ready || waitedLong);
    }
  }, []);

  // ---- starting / pausing audio from the shared state --------------------
  const schedulePlayback = useCallback(
    (s: RoomState) => {
      clearPlayTimer();
      const token = ++scheduleToken.current;
      if (loadedIdxRef.current !== s.idx) return;

      const seekIfOff = (targetS: number, tolerance: number) => {
        if (Math.abs(progressClock.now() - targetS) > tolerance) {
          void playbackEngine.seekTo(Math.max(0, targetS));
        }
      };
      lastActionAt.current = Date.now();

      if (!s.playing) {
        playbackEngine.pause();
        seekIfOff(s.pos / 1000, 0.6);
        return;
      }

      const now = serverNow();
      const startIn = s.at - now;
      if (startIn > 40) {
        // Everyone waits for the same moment, then starts together.
        playbackEngine.pause();
        seekIfOff(s.pos / 1000, 0.6);
        playTimer.current = setTimeout(() => {
          playTimer.current = null;
          if (token !== scheduleToken.current) return;
          const target = (s.pos + Math.max(0, serverNow() - s.at)) / 1000;
          seekIfOff(target, 0.5);
          playbackEngine.play();
          lastActionAt.current = Date.now();
        }, startIn);
        return;
      }

      // The start moment has already passed (late joiner, slow song): catch up.
      seekIfOff((s.pos + (now - s.at)) / 1000, 0.5);
      playbackEngine.play();
    },
    [clearPlayTimer]
  );

  const beginLoad = useCallback(
    (idx: number) => {
      targetIdxRef.current = idx;
      loadedIdxRef.current = -1;
      failedRef.current = false;
      bufferingSince.current = 0;
      clearPlayTimer();
      scheduleToken.current += 1;
      // Without this the previous song keeps playing while the new one resolves.
      playbackEngine.pause();
      sessionRef.current?.setPresence({ loadedIdx: -1, err: false });
      lastActionAt.current = Date.now();
      playerRef.current.loadForSync(tracksRef.current, idx, { autoPlay: false });
    },
    [clearPlayTimer]
  );

  const applyState = useCallback(
    (s: RoomState, _local: boolean, forced: boolean) => {
      if (!liveRef.current) return;
      const prev = stateRef.current;
      stateRef.current = s;
      stateChangedAt.current = Date.now();
      setRoomState(s);

      if (!forced && prev && sameTimeline(s, prev, serverNow())) {
        refreshUi();
        return;
      }
      if (targetIdxRef.current !== s.idx) {
        beginLoad(s.idx);
      } else if (loadedIdxRef.current === s.idx) {
        schedulePlayback(s);
      }
      // else: still loading the right song; markLoaded() schedules playback.
      refreshUi();
    },
    [beginLoad, refreshUi, schedulePlayback]
  );

  const markLoaded = useCallback(
    (idx: number) => {
      loadedIdxRef.current = idx;
      failedRef.current = false;
      sessionRef.current?.setPresence({ loadedIdx: idx, err: false });
      const s = stateRef.current;
      if (s && s.idx === idx) schedulePlayback(s);
      refreshUi();
    },
    [refreshUi, schedulePlayback]
  );

  const markFailed = useCallback(
    (idx: number) => {
      loadedIdxRef.current = -1;
      failedRef.current = true;
      sessionRef.current?.setPresence({ loadedIdx: -1, err: true });
      refreshUi();
    },
    [refreshUi]
  );

  // Watch the player to find out when the requested song is ready (or failed).
  useEffect(() => {
    if (phaseRef.current === 'idle' || !liveRef.current) return;
    const idx = targetIdxRef.current;
    const track = tracksRef.current[idx];
    if (idx < 0 || !track || loadedIdxRef.current === idx) return;
    if (player.currentTrack?.id !== track.id) return;
    if (player.isLoading) return;
    if (player.error) {
      markFailed(idx);
      return;
    }
    if (!player.isBuffering) {
      markLoaded(idx);
      return;
    }
    // Buffering normally ends quickly; do not wait on it forever.
    const t = setTimeout(() => {
      if (targetIdxRef.current === idx && loadedIdxRef.current !== idx && !failedRef.current) {
        markLoaded(idx);
      }
    }, 6000);
    return () => clearTimeout(t);
  }, [player.currentTrack?.id, player.isLoading, player.isBuffering, player.error, markLoaded, markFailed]);

  // ---- commands from this device -----------------------------------------
  const commandAllowed = useCallback((): { sess: SyncSession; s: RoomState } | null => {
    const sess = sessionRef.current;
    const s = stateRef.current;
    if (!sess || !s || phaseRef.current !== 'room' || sess.connection !== 'online') return null;
    const now = Date.now();
    if (now - lastCommandAt.current < SYNC.COMMAND_GAP_MS) return null;
    lastCommandAt.current = now;
    return { sess, s };
  }, []);

  const togglePlay = useCallback(() => {
    const ctx = commandAllowed();
    if (!ctx) return;
    const { sess, s } = ctx;
    if (s.playing) {
      sess.commit({
        playing: false,
        pos: Math.max(0, Math.round(livePositionMs(s, serverNow()))),
        at: serverNow(),
      });
      return;
    }
    const ready =
      everyoneReady(sess.presentMembers(), s.idx) || Date.now() - stateChangedAt.current > 12_000;
    if (!ready) return;
    sess.commit({
      playing: true,
      pos: s.pos,
      at: serverNow() + (s.pos === 0 ? SYNC.START_LEAD_MS : SYNC.RESUME_LEAD_MS),
    });
  }, [commandAllowed]);

  const next = useCallback(() => {
    const ctx = commandAllowed();
    if (!ctx) return;
    const { sess, s } = ctx;
    if (s.idx >= tracksRef.current.length - 1) return;
    sess.commit({ idx: s.idx + 1, playing: true, pos: 0, at: serverNow() + SYNC.START_LEAD_MS });
  }, [commandAllowed]);

  const previous = useCallback(() => {
    const ctx = commandAllowed();
    if (!ctx) return;
    const { sess, s } = ctx;
    const posMs = livePositionMs(s, serverNow());
    if (posMs > 3000 || s.idx === 0) {
      sess.commit({ playing: true, pos: 0, at: serverNow() + SYNC.RESUME_LEAD_MS });
    } else {
      sess.commit({ idx: s.idx - 1, playing: true, pos: 0, at: serverNow() + SYNC.START_LEAD_MS });
    }
  }, [commandAllowed]);

  const trackEnded = useCallback(() => {
    const sess = sessionRef.current;
    const s = stateRef.current;
    if (!sess || !s || phaseRef.current !== 'room') return;
    if (loadedIdxRef.current !== s.idx || !s.playing) return;
    if (sess.connection !== 'online') {
      // Not connected: wait for the room instead of moving on alone.
      playbackEngine.pause();
      return;
    }
    if (s.idx < tracksRef.current.length - 1) {
      sess.commit({ idx: s.idx + 1, playing: true, pos: 0, at: serverNow() + SYNC.ENDED_LEAD_MS });
    } else {
      sess.commit({ idx: 0, playing: false, pos: 0, at: serverNow() });
    }
  }, []);

  // Someone pressed pause/play outside the app (lock screen, notification,
  // headset). If it sticks, it becomes a room command like any other.
  useEffect(() => {
    if (phase !== 'room') return;
    const t = setTimeout(() => {
      const sess = sessionRef.current;
      const s = stateRef.current;
      const p = playerRef.current;
      if (!sess || !s || sess.connection !== 'online') return;
      if (loadedIdxRef.current !== s.idx || p.isLoading || p.isBuffering) return;
      if (Date.now() - lastActionAt.current < SYNC.SETTLE_MS || playTimer.current) return;
      if (s.playing && !p.isPlaying && serverNow() > s.at + 500) {
        togglePlay();
      } else if (!s.playing && p.isPlaying) {
        playbackEngine.pause(); // resume goes through the room so everyone starts together
        togglePlay();
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [player.isPlaying, phase, togglePlay]);

  // ---- leaving / ending ---------------------------------------------------
  const teardown = useCallback(
    (intentional: boolean) => {
      liveRef.current = false;
      clearPlayTimer();
      scheduleToken.current += 1;
      const sess = sessionRef.current;
      sessionRef.current = null;
      sess?.close(intentional);
      syncBridge.active = false;
      syncBridge.onNext = undefined;
      syncBridge.onPrevious = undefined;
      syncBridge.onTogglePlay = undefined;
      syncBridge.onTrackEnded = undefined;
      syncBridge.onLoadFailed = undefined;
      playbackEngine.pause();
      targetIdxRef.current = -1;
      loadedIdxRef.current = -1;
      failedRef.current = false;
      stateRef.current = null;
      tracksRef.current = [];
      setCode(null);
      setRoster([]);
      setTracks([]);
      setRoomState(null);
      setCanPlay(false);
      setConnection('connecting');
      setHealth('syncing');
      setStep('');
    },
    [clearPlayTimer]
  );

  const endRoom = useCallback(
    (message: string | null) => {
      teardown(message === null);
      setError(message);
      setPhase('idle');
    },
    [setPhase, teardown]
  );

  const leaveRoom = useCallback(() => {
    genRef.current += 1;
    connectingRef.current = false;
    endRoom(null);
  }, [endRoom]);

  // ---- opening a room ------------------------------------------------------
  const handlers = useMemo<SessionHandlers>(
    () => ({
      onChange: () => refreshUi(),
      onState: (s, local, forced) => applyState(s, local, forced),
      onFatal: (message) => endRoom(message),
      onMemberJoined: () => setJoinPulse((n) => n + 1),
    }),
    [applyState, endRoom, refreshUi]
  );
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // The session holds one stable handler object that always calls the latest ones.
  const stableHandlers = useRef<SessionHandlers>({
    onChange: () => handlersRef.current.onChange(),
    onState: (s, l, f) => handlersRef.current.onState(s, l, f),
    onFatal: (m) => handlersRef.current.onFatal(m),
    onMemberJoined: (m) => handlersRef.current.onMemberJoined(m),
  }).current;

  const enterRoom = useCallback(
    async (session: SyncSession, roomTracks: Track[]) => {
      sessionRef.current = session;
      tracksRef.current = roomTracks;
      setTracks(roomTracks);
      setCode(session.code);

      syncBridge.active = true;
      syncBridge.onNext = () => next();
      syncBridge.onPrevious = () => previous();
      syncBridge.onTogglePlay = () => togglePlay();
      syncBridge.onTrackEnded = () => trackEnded();
      syncBridge.onLoadFailed = () => undefined;

      const s = session.state as RoomState;
      liveRef.current = true;
      setStep('Syncing playlist…');
      applyState(s, false, true);

      // Wait until the first song is ready on this device (or has failed).
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        if (!sessionRef.current) return; // left meanwhile
        const idx = stateRef.current?.idx ?? 0;
        if (loadedIdxRef.current === idx || failedRef.current) break;
        await sleep(150);
      }
      refreshUi();
      setPhase('room');
    },
    [applyState, next, previous, refreshUi, setPhase, togglePlay, trackEnded]
  );

  const start = useCallback(
    async (
      role: 'host' | 'guest',
      args: { name: string; source?: Track[]; code?: string }
    ) => {
      if (connectingRef.current || phaseRef.current !== 'idle') return;
      connectingRef.current = true;
      const gen = ++genRef.current;
      const cancelled = () => gen !== genRef.current;
      setError(null);
      setPhase('connecting');
      setStep('Checking Sync Play…');

      let opened: SyncSession | null = null;
      try {
        const cfg = syncConfig();
        if (!cfg) throw new SyncError('connect', 'Sync Play is not set up in this build.');

        const f = await fetchSyncFlag();
        if (cancelled()) return;
        if (!f.ok) throw new SyncError('connect', f.message);
        if (!f.enabled) {
          setFlag({ checked: true, checking: false, enabled: false, message: f.message });
          throw new SyncError('connect', f.message);
        }

        setStep('Syncing clocks…');
        const clockOk = await measureClock();
        if (cancelled()) return;
        if (!clockOk) {
          throw new SyncError('connect', "Couldn't sync clocks with the server. Check your connection.");
        }

        setStep('Connecting devices…');
        const name = cleanName(args.name);
        let roomTracks: Track[];

        if (role === 'host') {
          const prepared = prepareTracks(args.source ?? []);
          if (!prepared.ok) throw new SyncError('connect', prepared.reason);
          roomTracks = prepared.tracks;
          const playlist = roomTracks.map(toSyncTrack).filter((t): t is SyncTrack => t !== null);

          for (let attempt = 0; attempt < 4 && !opened; attempt++) {
            const candidate = new SyncSession({
              code: generateCode(),
              deviceId,
              name,
              cfg,
              handlers: stableHandlers,
              seed: {
                playlist,
                state: { rev: 0, by: deviceId, idx: 0, playing: false, pos: 0, at: serverNow() },
              },
            });
            try {
              await candidate.host();
              opened = candidate;
            } catch (e) {
              if (cancelled()) return;
              if (e instanceof SyncError && e.kind === 'collision' && attempt < 3) continue;
              throw e;
            }
          }
          if (!opened) throw new SyncError('connect', "Couldn't create a room. Try again.");
        } else {
          const normalized = normalizeCode(args.code ?? '');
          if (!normalized) throw new SyncError('not_found', 'Enter the 6-character room code.');
          const guest = new SyncSession({
            code: normalized,
            deviceId,
            name,
            cfg,
            handlers: stableHandlers,
          });
          await guest.join();
          opened = guest;
          roomTracks = (guest.playlist ?? []).map(fromSyncTrack);
        }

        if (cancelled()) {
          opened.close(false);
          return;
        }
        await enterRoom(opened, roomTracks);
      } catch (e) {
        if (cancelled()) {
          opened?.close(false);
          return;
        }
        teardown(false);
        setError(e instanceof Error ? e.message : "Couldn't start Sync Play.");
        setPhase('idle');
      } finally {
        if (!cancelled()) connectingRef.current = false;
      }
    },
    [deviceId, enterRoom, setPhase, stableHandlers, teardown]
  );

  const createRoom = useCallback(
    (source: Track[], name: string) => void start('host', { name, source }),
    [start]
  );
  const joinRoom = useCallback(
    (roomCode: string, name: string) => void start('guest', { name, code: roomCode }),
    [start]
  );

  // ---- the on/off switch --------------------------------------------------
  const refreshFlag = useCallback(async (): Promise<boolean> => {
    setFlag((f) => ({ ...f, checking: true }));
    const r = await fetchSyncFlag();
    const enabled = r.ok && r.enabled;
    setFlag({ checked: true, checking: false, enabled, message: r.ok ? r.message : r.message });
    return enabled;
  }, []);

  // While a room is open: watch the switch (OFF ends the room with a maintenance
  // message), keep the clock fresh, and keep this device in step with the room.
  useEffect(() => {
    if (phase !== 'room') return;

    const flagTimer = setInterval(async () => {
      const r = await fetchSyncFlag();
      if (r.ok && !r.enabled) {
        setFlag({ checked: true, checking: false, enabled: false, message: r.message });
        endRoom(r.message);
      }
    }, SYNC.FLAG_POLL_MS);

    const clockTimer = setInterval(() => void measureClock(), SYNC.CLOCK_REFRESH_MS);

    const uiTimer = setInterval(() => refreshUi(), 1000);

    const driftTimer = setInterval(() => {
      const sess = sessionRef.current;
      const s = stateRef.current;
      if (!sess || !s) return;
      if (sess.connection !== 'online') {
        setHealth('offline');
        return;
      }
      const p = playerRef.current;
      const loaded = loadedIdxRef.current === s.idx;
      const busy = p.isLoading || p.isBuffering;
      const d = driftDecision({
        state: s,
        nowServer: serverNow(),
        localPosS: progressClock.now(),
        sinceActionMs: Date.now() - lastActionAt.current,
        sinceCorrectionMs: Date.now() - lastCorrectionAt.current,
        loaded,
        busy,
        localPlaying: p.isPlaying,
      });
      if (d.kind === 'seek') {
        void playbackEngine.seekTo(d.toS);
        lastCorrectionAt.current = Date.now();
        lastActionAt.current = Date.now();
        setHealth('syncing');
      } else if (d.kind === 'measure') {
        setHealth(Math.abs(d.driftS) > SYNC.DRIFT_SEEK_S ? 'syncing' : 'live');
      } else {
        setHealth(!loaded || busy ? 'syncing' : 'live');
      }
    }, SYNC.DRIFT_CHECK_MS);

    const appSub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      sessionRef.current?.ensureAlive();
      void measureClock();
    });

    return () => {
      clearInterval(flagTimer);
      clearInterval(clockTimer);
      clearInterval(uiTimer);
      clearInterval(driftTimer);
      appSub.remove();
    };
  }, [phase, endRoom, refreshUi]);

  // Leaving the app entirely (provider unmount) must not leave a room open.
  useEffect(
    () => () => {
      if (sessionRef.current) teardown(true);
    },
    [teardown]
  );

  const value = useMemo<SyncContextType>(
    () => ({
      flag,
      refreshFlag,
      phase,
      step,
      error,
      clearError: () => setError(null),
      code,
      roster,
      tracks,
      roomState,
      connection,
      health,
      canPlay,
      joinPulse,
      myId: deviceId,
      createRoom,
      joinRoom,
      leaveRoom,
      togglePlay,
      next,
      previous,
    }),
    [
      flag,
      refreshFlag,
      phase,
      step,
      error,
      code,
      roster,
      tracks,
      roomState,
      connection,
      health,
      canPlay,
      joinPulse,
      deviceId,
      createRoom,
      joinRoom,
      leaveRoom,
      togglePlay,
      next,
      previous,
    ]
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSyncPlay = () => {
  const ctx = useContext(SyncContext);
  if (ctx === undefined) throw new Error('useSyncPlay must be used within a SyncPlayProvider');
  return ctx;
};
