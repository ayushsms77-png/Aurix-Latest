import { MemberPresence, RoomState, SYNC } from './syncTypes';

/**
 * Pure Sync Play decisions. No React Native, no network, no timers: everything
 * here is a function of its arguments, so it can be tested on its own.
 */

/** Total order on states: higher rev wins; equal rev falls back to the sender id. */
export function compareStates(a: RoomState, b: RoomState): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.by === b.by) return 0;
  return a.by > b.by ? 1 : -1;
}

/** True when `incoming` should replace `current`. */
export function isNewer(incoming: RoomState, current: RoomState | null): boolean {
  return !current || compareStates(incoming, current) > 0;
}

/**
 * Where the shared song should be (ms) at server time `nowServer`.
 * Before a scheduled start this is negative (a countdown); while paused it is
 * the frozen position.
 */
export function livePositionMs(s: RoomState, nowServer: number): number {
  return s.playing ? s.pos + (nowServer - s.at) : s.pos;
}

/**
 * Two states describe the same timeline when they would have every device doing
 * the same thing. A newer rev that only differs by a few ms of "at" (two devices
 * both noticing the same song ended) must not restart anyone's audio.
 */
export function sameTimeline(a: RoomState, b: RoomState, nowServer: number): boolean {
  if (a.idx !== b.idx || a.playing !== b.playing) return false;
  return Math.abs(livePositionMs(a, nowServer) - livePositionMs(b, nowServer)) < 400;
}

/** Seats in join order. Ties (same joinedAt) are broken by id so every device agrees. */
export function sortMembers<T extends { joinedAt: number; id: string }>(members: T[]): T[] {
  return [...members].sort((x, y) =>
    x.joinedAt !== y.joinedAt ? x.joinedAt - y.joinedAt : x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  );
}

/** Whether `myId` holds one of the first MAX_MEMBERS seats. */
export function hasSeat(present: MemberPresence[], myId: string): boolean {
  const seats = sortMembers(present).slice(0, SYNC.MAX_MEMBERS);
  return seats.some((m) => m.id === myId);
}

/** Every device that can load the song has loaded it (devices that failed do not block). */
export function allReady(present: MemberPresence[], idx: number): boolean {
  if (present.length === 0) return false;
  return present.every((m) => m.err || m.loadedIdx === idx);
}

export type DriftInput = {
  state: RoomState;
  nowServer: number;
  localPosS: number;
  /** ms since this device last played / paused / seeked / loaded. */
  sinceActionMs: number;
  /** ms since the last drift correction. */
  sinceCorrectionMs: number;
  loaded: boolean;
  busy: boolean; // loading or buffering
  localPlaying: boolean;
};

export type DriftDecision =
  | { kind: 'none' }
  | { kind: 'seek'; toS: number; driftS: number }
  | { kind: 'measure'; driftS: number };

/**
 * Decide whether this device should be pulled back to the room timeline.
 * Corrections are deliberately rare (threshold + minimum gap), because every
 * seek is itself audible and the position reading is only good to ~0.3s.
 */
export function driftDecision(i: DriftInput): DriftDecision {
  const s = i.state;
  if (!s.playing || !i.loaded || i.busy || !i.localPlaying) return { kind: 'none' };
  if (i.nowServer < s.at + 1000) return { kind: 'none' }; // still counting in
  if (i.sinceActionMs < SYNC.SETTLE_MS) return { kind: 'none' };

  const expectedS = livePositionMs(s, i.nowServer) / 1000;
  const driftS = i.localPosS - expectedS;
  if (Math.abs(driftS) <= SYNC.DRIFT_SEEK_S) return { kind: 'measure', driftS };
  if (i.sinceCorrectionMs < SYNC.DRIFT_MIN_GAP_MS) return { kind: 'measure', driftS };
  return { kind: 'seek', toS: Math.max(0, expectedS), driftS };
}

/** Clock offset from one round trip: server time at the midpoint of the request. */
export function clockSample(t0: number, t1: number, serverMs: number): { offset: number; rtt: number } {
  return { offset: serverMs - (t0 + t1) / 2, rtt: t1 - t0 };
}

/** The sample with the smallest round trip is the most trustworthy one. */
export function bestClockSample(
  samples: { offset: number; rtt: number }[]
): { offset: number; rtt: number } | null {
  let best: { offset: number; rtt: number } | null = null;
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s;
  return best;
}

/** Simple per-second message budget. Returns false when the message should be dropped. */
export class RateGate {
  private windowStart = 0;
  private count = 0;
  constructor(private readonly perSecond: number) {}
  allow(nowMs: number): boolean {
    if (nowMs - this.windowStart >= 1000) {
      this.windowStart = nowMs;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.perSecond;
  }
}
