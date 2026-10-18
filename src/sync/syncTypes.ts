import { Track, trackKey } from '../core/types';

/**
 * Sync Play: shared constants, wire types and validation.
 *
 * Everything that arrives from another device is UNTRUSTED: it goes through the
 * parse* functions here before anything else touches it. Nothing is stored in
 * a database -- a room only exists in the memory of the devices inside it.
 */

export const SYNC = {
  MAX_TRACKS: 10,
  MAX_MEMBERS: 4,
  CODE_LENGTH: 6,
  /** No 0/O, 1/I/L: codes are read aloud and typed by hand. */
  CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  NAME_MAX: 20,

  /** A dropped device keeps its seat for this long; an empty room closes after it. */
  GRACE_MS: 10 * 60 * 1000,

  /** How far in the future a "go" is scheduled, so every device can be ready. */
  START_LEAD_MS: 2500,
  RESUME_LEAD_MS: 1200,
  ENDED_LEAD_MS: 1500,

  /** Playback is pulled back only when a device is this far (s) off the room. */
  DRIFT_SEEK_S: 1.0,
  DRIFT_CHECK_MS: 2500,
  DRIFT_MIN_GAP_MS: 5000,
  /** After any play/seek/load, leave the player alone for this long. */
  SETTLE_MS: 3000,
  /** Ignore two commands from this device closer together than this. */
  COMMAND_GAP_MS: 500,

  JOIN_TIMEOUT_MS: 9000,
  NOT_FOUND_AFTER_MS: 3500,
  CONNECT_MIN_BAR_MS: 4500,
  CONNECT_MAX_MS: 25000,

  FLAG_POLL_MS: 60_000,
  CLOCK_SAMPLES: 5,
  CLOCK_REFRESH_MS: 5 * 60_000,

  /** Incoming messages beyond this rate (per second, all senders) are dropped. */
  MAX_MSG_PER_SEC: 40,
} as const;

/** The only fields of a song that travel between devices. No URLs, no ids of ours. */
export type SyncTrack = {
  sourceId: string;
  title: string;
  artist: string;
  image: string;
  duration: number;
  album?: string;
};

/**
 * The shared timeline. Whoever issues a command bumps `rev` and broadcasts the
 * whole thing; the highest (rev, by) wins everywhere, so every device lands on
 * the same state no matter what order messages arrive in.
 *
 * `pos` is the song position (ms) at server time `at` (ms). While playing, the
 * live position is pos + (serverNow - at). If `at` is in the future, playback
 * starts then: that is how all devices start together.
 */
export type RoomState = {
  rev: number;
  by: string;
  idx: number;
  playing: boolean;
  pos: number;
  at: number;
};

/** What each device announces about itself through Presence. */
export type MemberPresence = {
  id: string;
  name: string;
  joinedAt: number;
  /** Index of the song this device has loaded and is ready to play, or -1. */
  loadedIdx: number;
  /** True when this device could not load the current song. */
  err: boolean;
};

export type StateMsg = { s: RoomState; pl?: SyncTrack[] };

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < SYNC.CODE_LENGTH; i++) {
    out += SYNC.CODE_ALPHABET[Math.floor(Math.random() * SYNC.CODE_ALPHABET.length)];
  }
  return out;
}

/** Uppercase, drop spaces/dashes; returns null if it can not be a valid code. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== SYNC.CODE_LENGTH) return null;
  for (const ch of code) if (!SYNC.CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function generateDeviceId(): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // Strip control characters and collapse whitespace.
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Guest').slice(0, SYNC.NAME_MAX);
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;

/** Local Track -> wire song. Null if it can not be synced (not a YouTube song). */
export function toSyncTrack(track: Track): SyncTrack | null {
  if (track.provider !== 'youtube' || !VIDEO_ID.test(track.sourceId)) return null;
  const image = track.albumImageUrl && /^https:\/\//.test(track.albumImageUrl)
    ? track.albumImageUrl.slice(0, 300)
    : '';
  const duration = Number.isFinite(track.duration) && track.duration > 0
    ? Math.min(Math.round(track.duration), 6 * 3600)
    : 0;
  return {
    sourceId: track.sourceId,
    title: (track.title || 'Unknown').slice(0, 120),
    artist: (track.artist?.name || 'Unknown artist').slice(0, 80),
    image,
    duration,
    album: track.album ? track.album.slice(0, 80) : undefined,
  };
}

/** Wire song -> local Track. The id is always derived here, never taken from the sender. */
export function fromSyncTrack(t: SyncTrack): Track {
  return {
    id: trackKey('youtube', t.sourceId),
    title: t.title,
    artist: { id: `sync:${t.artist}`, name: t.artist },
    albumImageUrl: t.image,
    duration: t.duration,
    provider: 'youtube',
    sourceId: t.sourceId,
    album: t.album,
  };
}

export function parseSyncTrack(raw: unknown): SyncTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sourceId = str(r.sourceId, 11);
  const title = str(r.title, 120);
  const artist = str(r.artist, 80);
  const image = str(r.image, 300);
  if (!sourceId || !VIDEO_ID.test(sourceId) || title === null || artist === null || image === null) {
    return null;
  }
  if (image !== '' && !/^https:\/\//.test(image)) return null;
  const duration = typeof r.duration === 'number' && Number.isFinite(r.duration)
    ? Math.max(0, Math.min(r.duration, 6 * 3600))
    : 0;
  const album = typeof r.album === 'string' && r.album.length <= 80 ? r.album : undefined;
  return { sourceId, title, artist, image, duration, album };
}

/** A playlist is accepted whole or not at all. */
export function parsePlaylist(raw: unknown): SyncTrack[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SYNC.MAX_TRACKS) return null;
  const out: SyncTrack[] = [];
  for (const item of raw) {
    const t = parseSyncTrack(item);
    if (!t) return null;
    out.push(t);
  }
  return out;
}

/**
 * Turn a local playlist into what can be synced: duplicates removed (the player
 * queue de-duplicates too, and indices must line up), 1..MAX_TRACKS songs, all
 * of them syncable. Returns the reason when it can not be used.
 */
export function prepareTracks(
  tracks: Track[]
): { ok: true; tracks: Track[] } | { ok: false; reason: string } {
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const t of tracks) {
    if (seen.has(t.sourceId)) continue;
    seen.add(t.sourceId);
    unique.push(t);
  }
  if (unique.length === 0) return { ok: false, reason: 'This playlist is empty' };
  if (unique.length > SYNC.MAX_TRACKS) {
    return { ok: false, reason: `Too many songs (max ${SYNC.MAX_TRACKS})` };
  }
  const out: Track[] = [];
  for (const t of unique) {
    const s = toSyncTrack(t);
    if (!s) return { ok: false, reason: 'Contains songs that can not be synced' };
    out.push(fromSyncTrack(s));
  }
  return { ok: true, tracks: out };
}

// ---------------------------------------------------------------------------
// State / presence
// ---------------------------------------------------------------------------

const MAX_REV = 1_000_000_000;
const MAX_POS_MS = 6 * 3600 * 1000;

export function parseState(raw: unknown, trackCount: number): RoomState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const by = str(r.by, 40);
  const { rev, idx, pos, at } = r as Record<string, unknown>;
  if (
    by === null ||
    typeof r.playing !== 'boolean' ||
    typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || rev > MAX_REV ||
    typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= trackCount ||
    typeof pos !== 'number' || !Number.isFinite(pos) || pos < 0 || pos > MAX_POS_MS ||
    typeof at !== 'number' || !Number.isFinite(at) || at < 0
  ) {
    return null;
  }
  return { rev, by, idx, playing: r.playing, pos: Math.round(pos), at: Math.round(at) };
}

export function parsePresence(raw: unknown): MemberPresence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40);
  const name = str(r.name, 60);
  if (!id || name === null) return null;
  const joinedAt = typeof r.joinedAt === 'number' && Number.isFinite(r.joinedAt) ? r.joinedAt : 0;
  const loadedIdx =
    typeof r.loadedIdx === 'number' && Number.isInteger(r.loadedIdx) ? r.loadedIdx : -1;
  return { id, name: cleanName(name), joinedAt, loadedIdx, err: r.err === true };
}
