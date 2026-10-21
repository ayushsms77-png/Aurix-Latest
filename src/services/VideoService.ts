import { resolveYouTubeVideo } from '../../modules/note-native';
import { Track } from '../core/types';
import { fetchAppFlag } from '../sync/syncServer';
import { MusicService } from './MusicService';
import {
  decideOffset,
  describeRejects,
  parseSegments,
  rankWithReport,
  Segment,
  VIDEO,
  VideoCandidate,
} from '../video/videoLogic';

/**
 * Finds the music video that belongs to a song and a playable (silent) stream
 * for it. The sound always comes from the normal player; this is only the
 * picture.
 */

export type VideoPlan = {
  /** YouTube id of the video to show. */
  videoId: string;
  /** Seconds into the video at which the song starts (an intro to skip). */
  offsetS: number;
  /** What was picked, for the caption under the picture. */
  match: VideoMatch;
};

export type VideoMatch = {
  title: string;
  channel: string;
  /** Video length minus song length, in seconds. */
  deltaS: number;
  /** Length did not line up exactly: the picture may be a little out of step. */
  approx: boolean;
  /** The song was itself a video. */
  self: boolean;
};

export type VideoStream = {
  url: string;
  headers: Record<string, string>;
  durationS?: number;
};

/** Which step broke. Shown on screen so a failure can be traced. */
export type VideoFailStep = 'search' | 'match' | 'stream' | 'player' | 'timeout' | 'cancelled';

export class VideoUnavailableError extends Error {
  readonly step: VideoFailStep;
  constructor(step: VideoFailStep, message = 'No video for this song') {
    super(message);
    this.name = 'VideoUnavailableError';
    this.step = step;
  }
}

/** One short line for the failure screen, e.g. "match: 12 results (title 7, length 3)". */
export function describeFailure(e: unknown): string {
  if (e instanceof VideoUnavailableError) return `${e.step}: ${e.message}`.slice(0, 220);
  const msg = e instanceof Error ? e.message : String(e);
  return `error: ${msg}`.slice(0, 220);
}

const PLAN_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 2 * 60 * 1000;
const STREAM_TTL_MS = 20 * 60 * 1000;
const FLAG_TTL_MS = 10 * 60 * 1000;

const plans = new Map<string, { at: number; plan: VideoPlan | null; err?: VideoUnavailableError }>();
const streams = new Map<string, { at: number; stream: VideoStream }>();
let flagCache: { at: number; enabled: boolean } | null = null;

const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** "Non-music" parts of a music video (intro, dialogue), from SponsorBlock. Never throws. */
export async function fetchSegments(videoId: string): Promise<Segment[]> {
  try {
    const res = await fetchWithTimeout(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}&category=music_offtopic`,
      5000
    );
    if (!res.ok) return [];
    return parseSegments(await res.json());
  } catch {
    return [];
  }
}

const toCandidate = (t: Track): VideoCandidate => ({
  sourceId: t.sourceId,
  title: t.title,
  artist: t.artist.name,
  duration: t.duration,
  isVideo: t.isVideo,
});

export const VideoService = {
  /**
   * Is the Video feature switched on? Fails OPEN: if the flag can not be read
   * the feature stays available (it needs the network anyway).
   */
  async isEnabled(): Promise<boolean> {
    if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) return flagCache.enabled;
    const r = await fetchAppFlag(VIDEO.FLAG_KEY);
    // Only an explicit "off" row switches Video off; no row / unreadable = on.
    const enabled = r.ok ? !r.found || r.enabled : true;
    flagCache = { at: Date.now(), enabled };
    return enabled;
  },

  /** Which video to show for this song, and how far to skip into it. */
  async planFor(track: Track, signal?: AbortSignal): Promise<VideoPlan> {
    const hit = plans.get(track.id);
    if (hit && Date.now() - hit.at < (hit.plan ? PLAN_TTL_MS : FAIL_TTL_MS)) {
      if (hit.plan) return hit.plan;
      throw hit.err ?? new VideoUnavailableError('match');
    }
    const fail = (err: VideoUnavailableError): never => {
      plans.set(track.id, { at: Date.now(), plan: null, err });
      throw err;
    };

    // The song is itself a video: that is the picture, in step by definition.
    if (track.isVideo === true) {
      const plan: VideoPlan = {
        videoId: track.sourceId,
        offsetS: 0,
        match: { title: track.title, channel: track.artist.name, deltaS: 0, approx: false, self: true },
      };
      plans.set(track.id, { at: Date.now(), plan });
      return plan;
    }

    const artist = track.artist.name.split(/,|&/)[0].trim();
    const base = `${track.title} ${artist}`;
    // Two searches side by side: videos only (real music videos), and a plain one
    // ("official video") as a second chance. Whatever either finds goes in one pool.
    const settled = await Promise.allSettled([
      MusicService.search(base, { filter: 'Videos', limit: 15, signal }),
      MusicService.search(`${base} official video`, { limit: 15, signal }),
    ]);
    if (signal?.aborted) throw new VideoUnavailableError('cancelled', 'cancelled');

    const pool: Track[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const r of settled) {
      if (r.status === 'rejected') {
        errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        continue;
      }
      for (const t of r.value.tracks) {
        if (t.sourceId && !seen.has(t.sourceId)) {
          seen.add(t.sourceId);
          pool.push(t);
        }
      }
    }
    if (pool.length === 0) {
      fail(new VideoUnavailableError('search', errors.length ? errors[0].slice(0, 120) : '0 results'));
    }

    const report = rankWithReport(
      { title: track.title, artist: track.artist.name, duration: track.duration },
      pool.map(toCandidate)
    );
    if (report.ranked.length === 0) {
      fail(new VideoUnavailableError('match', describeRejects(report.total, report.rejected)));
    }

    // Best first. A candidate whose length the search did not give is measured from
    // its real stream (at most a few, since each one costs a lookup).
    let lookups = 0;
    let lastNote = '';
    for (const r of report.ranked) {
      if (signal?.aborted) throw new VideoUnavailableError('cancelled', 'cancelled');
      let delta = r.delta;
      if (delta === null) {
        if (lookups >= 3) continue;
        lookups++;
        try {
          const st = await VideoService.streamFor(r.cand.sourceId, signal);
          if (!st.durationS) {
            lastNote = 'stream gave no length';
            continue;
          }
          delta = st.durationS - track.duration;
        } catch (e) {
          if (e instanceof VideoUnavailableError && e.step === 'cancelled') throw e;
          lastNote = e instanceof Error ? e.message : 'stream failed';
          // The extractor itself is missing or broken: no point trying more.
          if (/module_unavailable/.test(lastNote)) fail(e as VideoUnavailableError);
          continue;
        }
      }
      const segments = delta > VIDEO.SAME_LENGTH_S ? await fetchSegments(r.cand.sourceId) : null;
      const decision = decideOffset(delta, segments);
      if (decision.ok) {
        const plan: VideoPlan = {
          videoId: r.cand.sourceId,
          offsetS: decision.offsetS,
          match: {
            title: r.cand.title,
            channel: r.cand.artist,
            deltaS: Math.round(delta),
            approx: decision.approx,
            self: false,
          },
        };
        plans.set(track.id, { at: Date.now(), plan });
        return plan;
      }
    }

    return fail(new VideoUnavailableError('match', `${report.ranked.length} candidates, none usable by length${lastNote ? ` (${lastNote})` : ''}`));
  },

  /** A playable silent stream for a video id. */
  async streamFor(videoId: string, signal?: AbortSignal): Promise<VideoStream> {
    const hit = streams.get(videoId);
    if (hit && Date.now() - hit.at < STREAM_TTL_MS) return hit.stream;

    const r = await resolveYouTubeVideo(videoId, VIDEO.MAX_HEIGHT);
    if (signal?.aborted) throw new VideoUnavailableError('cancelled', 'cancelled');
    if (!r.ok) throw new VideoUnavailableError('stream', `${r.reason}${r.message ? ` - ${r.message}` : ''}`.slice(0, 160));

    const stream: VideoStream = {
      url: r.url,
      headers: { 'User-Agent': r.userAgent ?? FALLBACK_UA },
      durationS: r.durationSeconds,
    };
    streams.set(videoId, { at: Date.now(), stream });
    return stream;
  },

  /** Plan + stream in one go (what the player view calls). */
  async prepare(track: Track, signal?: AbortSignal): Promise<VideoPlan & { stream: VideoStream }> {
    const plan = await VideoService.planFor(track, signal);
    const stream = await VideoService.streamFor(plan.videoId, signal);
    return { ...plan, stream };
  },
};
