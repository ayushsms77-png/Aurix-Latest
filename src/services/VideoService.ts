import { resolveYouTubeVideo } from '../../modules/note-native';
import { Track } from '../core/types';
import { fetchAppFlag } from '../sync/syncServer';
import { MusicService } from './MusicService';
import {
  decideOffset,
  parseSegments,
  rankCandidates,
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
};

export type VideoStream = {
  url: string;
  headers: Record<string, string>;
  durationS?: number;
};

export class VideoUnavailableError extends Error {
  constructor(message = 'No video for this song') {
    super(message);
    this.name = 'VideoUnavailableError';
  }
}

const PLAN_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 2 * 60 * 1000;
const STREAM_TTL_MS = 20 * 60 * 1000;
const FLAG_TTL_MS = 10 * 60 * 1000;

const plans = new Map<string, { at: number; plan: VideoPlan | null }>();
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
      throw new VideoUnavailableError();
    }

    // The song is itself a video: that is the picture, in step by definition.
    if (track.isVideo === true) {
      const plan = { videoId: track.sourceId, offsetS: 0 };
      plans.set(track.id, { at: Date.now(), plan });
      return plan;
    }

    const artist = track.artist.name.split(/,|&/)[0].trim();
    let results: Track[] = [];
    try {
      const res = await MusicService.search(`${track.title} ${artist} official video`, { limit: 15, signal });
      results = res.tracks;
    } catch {
      if (signal?.aborted) throw new VideoUnavailableError('cancelled');
    }

    const ranked = rankCandidates(
      { title: track.title, artist: track.artist.name, duration: track.duration },
      results.map(toCandidate)
    );

    for (const r of ranked) {
      if (signal?.aborted) throw new VideoUnavailableError('cancelled');
      const segments = Math.abs(r.delta) > VIDEO.SAME_LENGTH_S ? await fetchSegments(r.cand.sourceId) : null;
      const decision = decideOffset(r.delta, segments);
      if (decision.ok) {
        const plan = { videoId: r.cand.sourceId, offsetS: decision.offsetS };
        plans.set(track.id, { at: Date.now(), plan });
        return plan;
      }
    }

    plans.set(track.id, { at: Date.now(), plan: null });
    throw new VideoUnavailableError();
  },

  /** A playable silent stream for a video id. */
  async streamFor(videoId: string, signal?: AbortSignal): Promise<VideoStream> {
    const hit = streams.get(videoId);
    if (hit && Date.now() - hit.at < STREAM_TTL_MS) return hit.stream;

    const r = await resolveYouTubeVideo(videoId, VIDEO.MAX_HEIGHT);
    if (signal?.aborted) throw new VideoUnavailableError('cancelled');
    if (!r.ok) throw new VideoUnavailableError(r.message);

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
