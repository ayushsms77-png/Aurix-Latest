/**
 * Pure rules for the Video view: which video belongs to a song, how far to
 * shift it, and when to nudge it back into step with the audio. No React, no
 * network: everything here is unit-tested.
 */

export const VIDEO = {
  /** Same-length tolerance: a video this close to the audio needs no shift. */
  SAME_LENGTH_S: 4,
  /** A video longer than the audio by up to this much is still used (intro skipped if known). */
  MAX_EXTRA_S: 90,
  /** A video shorter than the audio by up to this much is still used (it freezes on its last frame). */
  MAX_SHORT_S: 30,
  /** Video may drift this far from the audio before it is nudged. */
  DRIFT_S: 0.4,
  /** Never seek the video more often than this. */
  MIN_SEEK_GAP_MS: 1500,
  SYNC_TICK_MS: 500,
  /** Give up on a video that shows no picture after this long. */
  FIRST_FRAME_TIMEOUT_MS: 15000,
  FAIL_MESSAGE_MS: 7000,
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

/**
 * Words that mean "not the real music video": such a result is dropped, unless
 * the song's own title has the word (e.g. "Live Forever").
 */
const REJECT_WORDS: string[] = [
  'remix',
  'cover',
  'karaoke',
  'slowed',
  'reverb',
  '8d',
  'instrumental',
  'mashup',
  'reaction',
  'tutorial',
  'live',
  'nightcore',
  'sped',
  'bass boosted',
  'acoustic',
  'unplugged',
];

// Lyric / audio-only / visualizer uploads are NOT the music video: also dropped.
REJECT_WORDS.push('lyric', 'lyrics', 'audio', 'visualizer', 'visualiser', 'status', 'whatsapp', 'topic');

function hasWord(text: string, w: string): boolean {
  return new RegExp(`\\b${w}\\b`, 'i').test(text);
}

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

/** Why a candidate was left out (for the on-screen reason). */
export type RejectReason = 'audio_only' | 'no_duration' | 'title' | 'artist' | 'remix_like';

export type ScoreResult = { score: number } | { reject: RejectReason };

function titleWords(t: string): string[] {
  return t.split(' ').filter(Boolean);
}

/**
 * Score one candidate against the song.
 * Lenient on purpose: the song's title words must all appear in the candidate's
 * title (any order), and the artist (or its first name) must show up in the
 * title or the artist field. Remix-like and audio-only results are dropped.
 */
export function evaluateCandidate(song: SongInfo, cand: VideoCandidate): ScoreResult {
  // `undefined` is fine: search results often do not say. Only a known audio track is out.
  if (cand.isVideo === false) return { reject: 'audio_only' };
  // A candidate with no length is kept (its real length is read from the stream later).
  if (!song.duration) return { reject: 'no_duration' };

  const songTitle = normalizeTitle(song.title);
  const candTitle = normalizeTitle(cand.title);
  if (!songTitle || !candTitle) return { reject: 'title' };
  const candWords = new Set(titleWords(candTitle));
  const titleOk = candTitle.includes(songTitle) || titleWords(songTitle).every((w) => candWords.has(w));
  if (!titleOk) return { reject: 'title' };

  const artist = firstArtist(song.artist);
  const candArtist = normalizeTitle(cand.artist);
  if (artist) {
    const token = artist.split(' ')[0];
    const hit =
      candTitle.includes(artist) ||
      candArtist.includes(artist) ||
      (token.length > 2 && (candTitle.includes(token) || candArtist.includes(token)));
    if (!hit) return { reject: 'artist' };
  }

  const rawSong = song.title.toLowerCase();
  const rawCand = cand.title.toLowerCase();
  const songWords = new Set(songTitle.split(' '));
  for (const w of REJECT_WORDS) {
    if (hasWord(rawCand, w) && !hasWord(rawSong, w) && !songWords.has(w)) return { reject: 'remix_like' };
  }

  let score = 100;
  if (/official/.test(rawCand)) score += 10;
  if (/\bvideo\b|\bmv\b|music video/.test(rawCand)) score += 5;
  if (cand.isVideo === true) score += 5;
  // Extra words beyond the song title (and artist) hint at a different video.
  score -= Math.min(15, Math.max(0, candWords.size - songWords.size - 3) * 2);
  // The uploader is the artist: the real thing, not a fan upload.
  if (artist && candArtist.includes(artist)) score += 15;
  // Closer in length is better: it is the strongest sign of the same recording.
  if (cand.duration) score -= Math.min(25, Math.abs(cand.duration - song.duration) / 4);
  else score -= 10; // length unknown
  return { score };
}

/** Score, or null when rejected. */
export function scoreCandidate(song: SongInfo, cand: VideoCandidate): number | null {
  const r = evaluateCandidate(song, cand);
  return 'score' in r ? r.score : null;
}

/** delta = video length - song length; null while the video's length is not known yet. */
export type RankedCandidate = { cand: VideoCandidate; delta: number | null; score: number };

export type RankReport = {
  ranked: RankedCandidate[];
  /** How many candidates were looked at. */
  total: number;
  /** Rejection counts by reason (length included). */
  rejected: Record<string, number>;
};

/** Good candidates, best first, plus a count of why the others were left out. */
export function rankWithReport(song: SongInfo, cands: VideoCandidate[], limit = 4): RankReport {
  const out: RankedCandidate[] = [];
  const rejected: Record<string, number> = {};
  const bump = (k: string) => {
    rejected[k] = (rejected[k] ?? 0) + 1;
  };
  for (const cand of cands) {
    const r = evaluateCandidate(song, cand);
    if ('reject' in r) {
      bump(r.reject);
      continue;
    }
    if (r.score < 30) {
      bump('low_score');
      continue;
    }
    if (!cand.duration) {
      out.push({ cand, delta: null, score: r.score });
      continue;
    }
    const delta = cand.duration - song.duration;
    // Far shorter or far longer than the audio: it can never line up.
    if (delta < -VIDEO.MAX_SHORT_S || delta > VIDEO.MAX_EXTRA_S) {
      bump('length');
      continue;
    }
    out.push({ cand, delta, score: r.score });
  }
  out.sort((a, b) => b.score - a.score);
  return { ranked: out.slice(0, limit), total: cands.length, rejected };
}

export function rankCandidates(song: SongInfo, cands: VideoCandidate[], limit = 4): RankedCandidate[] {
  return rankWithReport(song, cands, limit).ranked;
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

export type OffsetDecision = { ok: true; offsetS: number; approx: boolean } | { ok: false };

/**
 * How far into the video the song starts.
 *  - about the same length -> 0 (exact)
 *  - longer with a real intro segment from SponsorBlock -> skip it (exact)
 *  - longer without one, or a bit shorter -> 0, marked approximate
 *  - anything else -> no match
 */
export function decideOffset(delta: number, segments: Segment[] | null): OffsetDecision {
  if (Math.abs(delta) <= VIDEO.SAME_LENGTH_S) return { ok: true, offsetS: 0, approx: false };
  if (delta < -VIDEO.MAX_SHORT_S || delta > VIDEO.MAX_EXTRA_S) return { ok: false };
  if (delta < 0) return { ok: true, offsetS: 0, approx: true };

  const intro = (segments ?? []).find((s) => s.start <= 3 && s.end - s.start >= 1);
  if (intro) {
    const offsetS = Math.round(intro.end * 10) / 10;
    // The intro can not be longer than the extra length (plus the tolerance).
    if (offsetS <= delta + VIDEO.SAME_LENGTH_S) return { ok: true, offsetS, approx: false };
  }
  return { ok: true, offsetS: 0, approx: true };
}

/** Short on-screen note for a failed step, e.g. "match: 0 of 12 (title 7, length 3)". */
export function describeRejects(total: number, rejected: Record<string, number>): string {
  const parts = Object.entries(rejected)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`);
  return `${total} results${parts.length ? ` (${parts.join(', ')})` : ''}`;
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
