/**
 * Pure rules for the Video view: which video belongs to a song, how far to
 * shift it, and when to nudge it back into step with the audio. No React, no
 * network: everything here is unit-tested.
 */

export const VIDEO = {
  /** Same-length tolerance: a video this close to the audio needs no shift. */
  SAME_LENGTH_S: 4,
  /** A video longer than the audio by up to this much may have an intro to skip. */
  MAX_EXTRA_S: 60,
  /** Video may drift this far from the audio before it is nudged. */
  DRIFT_S: 0.4,
  /** Never seek the video more often than this. */
  MIN_SEEK_GAP_MS: 1500,
  SYNC_TICK_MS: 500,
  /** Give up on a video that shows no picture after this long. */
  FIRST_FRAME_TIMEOUT_MS: 15000,
  FAIL_MESSAGE_MS: 1800,
  MAX_HEIGHT: 720,
  FLAG_KEY: 'video_play',
} as const;

export const VIDEO_FAIL_TEXT = 'Sorry yawr we failed to fetch video!';

// ---------------------------------------------------------------------------
// Matching a song to its music video
// ---------------------------------------------------------------------------

/** Lower-case, no brackets, no "feat.", no punctuation. */
export function normalizeTitle(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b\.?.*$/, ' ')
    // ASCII + general punctuation only: no Unicode property escapes (not safe on every JS engine).
    .replace(/[!-\/:-@\[-`{-~\u2010-\u2027\u2030-\u205E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words that mark a video as NOT the real music video (unless the song itself says so). */
const BAD_WORDS = [
  'lyric',
  'lyrics',
  'audio',
  'visualizer',
  'visualiser',
  'reaction',
  'cover',
  'karaoke',
  'slowed',
  'reverb',
  '8d',
  'instrumental',
  'live',
  'tutorial',
  'remix',
  'mashup',
];

export type VideoCandidate = {
  sourceId: string;
  title: string;
  artist: string;
  duration: number; // seconds; 0 if unknown
  isVideo?: boolean;
};

export type SongInfo = { title: string; artist: string; duration: number };

function firstArtist(artist: string): string {
  return normalizeTitle(artist.split(/,|&| x | and /i)[0] ?? '');
}

/**
 * Score one candidate against the song. null = reject.
 * The song's title must appear in the candidate's title, and the artist (or
 * its first name) must show up in the title or the artist field.
 */
export function scoreCandidate(song: SongInfo, cand: VideoCandidate): number | null {
  if (cand.isVideo !== true) return null;
  if (!cand.duration || !song.duration) return null;

  const songTitle = normalizeTitle(song.title);
  const candTitle = normalizeTitle(cand.title);
  if (!songTitle || !candTitle) return null;
  if (!candTitle.includes(songTitle)) return null;

  const artist = firstArtist(song.artist);
  const candArtist = normalizeTitle(cand.artist);
  if (artist) {
    const token = artist.split(' ')[0];
    const hit = candTitle.includes(artist) || candArtist.includes(artist) || (token.length > 2 && (candTitle.includes(token) || candArtist.includes(token)));
    if (!hit) return null;
  }

  let score = 100;
  const songWords = new Set(songTitle.split(' '));
  const rawSong = song.title.toLowerCase();
  const rawCand = cand.title.toLowerCase();
  for (const w of BAD_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    if (re.test(rawCand) && !re.test(rawSong) && !songWords.has(w)) score -= 40;
  }
  if (/official/.test(rawCand)) score += 10;
  if (/\bvideo\b|\bmv\b|music video/.test(rawCand)) score += 5;
  // Extra words beyond the song title (and artist) hint at a different video.
  score -= Math.min(15, Math.max(0, candTitle.split(' ').length - songTitle.split(' ').length - 3) * 2);
  score -= Math.min(20, Math.abs(cand.duration - song.duration) / 6);
  return score;
}

export type RankedCandidate = { cand: VideoCandidate; delta: number; score: number };

/** Good candidates, best first; only those whose length could possibly work. */
export function rankCandidates(song: SongInfo, cands: VideoCandidate[], limit = 3): RankedCandidate[] {
  const out: RankedCandidate[] = [];
  for (const cand of cands) {
    const score = scoreCandidate(song, cand);
    if (score === null || score < 40) continue;
    const delta = cand.duration - song.duration;
    // Shorter than the audio, or far longer: it can never line up.
    if (delta < -VIDEO.SAME_LENGTH_S || delta > VIDEO.MAX_EXTRA_S) continue;
    out.push({ cand, delta, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Offset (skip an intro)
// ---------------------------------------------------------------------------

export type Segment = { start: number; end: number };

/** SponsorBlock `skipSegments` response -> clean segments (seconds). */
export function parseSegments(body: unknown): Segment[] {
  if (!Array.isArray(body)) return [];
  const out: Segment[] = [];
  for (const row of body) {
    const seg = (row as { segment?: unknown })?.segment;
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const start = Number(seg[0]);
    const end = Number(seg[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

export type OffsetDecision = { ok: true; offsetS: number } | { ok: false };

/**
 * How far into the video the song starts.
 *  - about the same length -> 0
 *  - longer: only with a real intro segment from SponsorBlock, never a guess
 *  - anything else -> no match
 */
export function decideOffset(delta: number, segments: Segment[] | null): OffsetDecision {
  if (Math.abs(delta) <= VIDEO.SAME_LENGTH_S) return { ok: true, offsetS: 0 };
  if (delta < 0 || delta > VIDEO.MAX_EXTRA_S) return { ok: false };

  const intro = (segments ?? []).find((s) => s.start <= 3 && s.end - s.start >= 1);
  if (!intro) return { ok: false };
  const offsetS = Math.round(intro.end * 10) / 10;
  // The intro can not be longer than the extra length (plus the tolerance).
  if (offsetS > delta + VIDEO.SAME_LENGTH_S) return { ok: false };
  return { ok: true, offsetS };
}

// ---------------------------------------------------------------------------
// Keeping the silent video in step with the audio
// ---------------------------------------------------------------------------

export type SyncInput = {
  audioPosS: number;
  audioPlaying: boolean;
  /** Audio is loading / buffering: hold the picture. */
  audioBusy: boolean;
  videoPosS: number;
  offsetS: number;
  videoDurationS?: number;
  videoReady: boolean;
  /** Time since the last video seek. */
  sinceSeekMs: number;
};

export type SyncAction = {
  /** What the video should be doing. */
  play: boolean;
  /** Seek to this many seconds (video time) first, if set. */
  seekToS?: number;
};

export function videoSyncDecision(i: SyncInput): SyncAction {
  if (!i.videoReady) return { play: false };

  const target = Math.max(0, i.audioPosS + i.offsetS);
  const dur = i.videoDurationS && i.videoDurationS > 0 ? i.videoDurationS : Infinity;

  // The audio outlasts the video: freeze on the last frame.
  if (target >= dur - 0.2) return { play: false };

  const playing = i.audioPlaying && !i.audioBusy;
  const drift = i.videoPosS - target;
  const far = Math.abs(drift) > VIDEO.DRIFT_S;

  if (far && i.sinceSeekMs >= VIDEO.MIN_SEEK_GAP_MS) return { play: playing, seekToS: target };
  // A tiny seek while paused keeps the shown frame on the right moment.
  if (!playing && Math.abs(drift) > 0.25 && i.sinceSeekMs >= VIDEO.MIN_SEEK_GAP_MS) {
    return { play: false, seekToS: target };
  }
  return { play: playing };
}
