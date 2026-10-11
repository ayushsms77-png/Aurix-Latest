import { metadataCache } from '../core/cache';
import { appError, toAppError } from '../core/errors';
import {
  emptySearchResults,
  SearchFilter,
  SearchResults,
  Track,
} from '../core/types';
import { PlaylistPage, providers } from '../providers/TrackResolver';
import { youtubeResolver } from '../providers/youtube/YouTubeResolver';
import { streamResolver } from '../providers/stream/StreamResolver';

// Register the providers the app ships with. Adding another is one line.
providers.register(youtubeResolver, true);

/**
 * The single entry point the UI uses for anything music-related.
 *
 * Screens call MusicService; MusicService picks the provider. No screen ever
 * imports a provider, an InnerTube helper, or a stream resolver.
 */
/** Below this many candidates the search backup tops the pool up. */
const RELATED_MIN_POOL = 10;
const RELATED_TTL_MS = 30 * 60 * 1000;
const RELATED_CACHE_MAX = 60;

class MusicServiceImpl {
  private relatedCache = new Map<string, { at: number; tracks: Track[] }>();
  private relatedInFlight = new Map<string, Promise<Track[]>>();

  /** Warm the on-disk metadata cache. Called once at startup. */
  async init(): Promise<void> {
    await metadataCache.hydrate();
  }

  async search(
    query: string,
    options: { filter?: SearchFilter; signal?: AbortSignal; limit?: number } = {}
  ): Promise<SearchResults> {
    const q = query.trim();
    if (!q) return emptySearchResults();

    try {
      return await providers.default.search(q, options);
    } catch (e) {
      throw toAppError(e, 'search_failed');
    }
  }

  async getSuggestions(input: string, signal?: AbortSignal): Promise<string[]> {
    const provider = providers.default;
    if (!provider.getSuggestions) return [];
    return provider.getSuggestions(input, signal);
  }

  async getMetadata(track: Track, signal?: AbortSignal): Promise<Track> {
    return providers.forTrack(track).getMetadata(track.sourceId, signal);
  }

  /** Expand a provider playlist into tracks, following continuations. */
  async getPlaylist(
    browseId: string,
    options: { signal?: AbortSignal; maxTracks?: number } = {}
  ): Promise<PlaylistPage> {
    const { signal, maxTracks = 200 } = options;
    const provider = providers.default;

    let page = await provider.getPlaylist(browseId, { signal });
    const tracks = [...page.tracks];

    // Follow continuations until we have enough, bounded so a huge playlist
    // cannot stall the import.
    let guard = 0;
    while (page.continuation && tracks.length < maxTracks && guard < 5) {
      guard++;
      try {
        page = await provider.getPlaylist(browseId, {
          continuation: page.continuation,
          signal,
        });
        if (!page.tracks.length) break;
        tracks.push(...page.tracks);
      } catch {
        break; // partial playlist is better than none
      }
    }

    return {
      playlist: { ...page.playlist, trackCount: tracks.length },
      tracks: tracks.slice(0, maxTracks),
    };
  }

  async getAlbum(browseId: string, signal?: AbortSignal): Promise<PlaylistPage> {
    const provider = providers.default;
    if (!provider.getAlbum) throw appError('invalid_playlist', 'Albums not supported');
    return provider.getAlbum(browseId, signal);
  }

  async getArtistTracks(browseId: string, signal?: AbortSignal): Promise<Track[]> {
    const provider = providers.default;
    if (!provider.getArtistTracks) return [];
    return provider.getArtistTracks(browseId, signal);
  }

  /**
   * Related ("radio") tracks for a track. Cached in memory only -- these lists
   * are large and cheap to refetch, so they are kept out of the on-disk
   * metadata cache. Concurrent callers share one request, and empty results
   * (usually a failed fetch) are never cached.
   */
  async getRelated(track: Track, signal?: AbortSignal): Promise<Track[]> {
    const provider = providers.forTrack(track);
    if (!provider.getRelated) return [];

    const key = track.id;
    const hit = this.relatedCache.get(key);
    if (hit && Date.now() - hit.at < RELATED_TTL_MS) return hit.tracks;

    const pending = this.relatedInFlight.get(key);
    if (pending) return pending;

    const request = provider
      .getRelated(track, signal)
      .then(async (tracks) => {
        // Backup source: if the related feed gave (almost) nothing, search for
        // more of the same artist. Search is the path the app already relies
        // on everywhere, so continuous playback does not hang on one endpoint.
        if (tracks.length < RELATED_MIN_POOL) {
          const extra = await this.relatedViaSearch(track, signal);
          const seen = new Set(tracks.map((t) => t.id));
          tracks = [...tracks, ...extra.filter((t) => !seen.has(t.id))];
        }
        return tracks;
      })
      .then((tracks) => {
        if (tracks.length) {
          this.relatedCache.set(key, { at: Date.now(), tracks });
          // Oldest entries out first (Map keeps insertion order).
          while (this.relatedCache.size > RELATED_CACHE_MAX) {
            const oldest = this.relatedCache.keys().next().value;
            if (oldest === undefined) break;
            this.relatedCache.delete(oldest);
          }
        }
        return tracks;
      })
      .finally(() => {
        this.relatedInFlight.delete(key);
      });
    this.relatedInFlight.set(key, request);
    return request;
  }

  /** Songs by the same artist, found through plain search. Never throws. */
  private async relatedViaSearch(track: Track, signal?: AbortSignal): Promise<Track[]> {
    try {
      const name = track.artist.name.split(/,|&| feat\.?| ft\.?| x /i)[0].trim();
      if (!name || /^(unknown artist|episode|podcast)$/i.test(name)) return [];
      const res = await providers.default.search(`${name} songs`, {
        filter: 'Songs',
        signal,
        limit: 20,
      });
      const out = res.tracks.filter((t) => t.id !== track.id && t.isVideo !== true);
      if (__DEV__) console.log('[related] search backup', name, '| usable:', out.length);
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Import anything the user pastes: a playlist link, an album link, a track
   * link, or a bare id.
   */
  async importFromUrl(
    input: string,
    signal?: AbortSignal
  ): Promise<{ page: PlaylistPage } | { track: Track }> {
    const provider = providers.default;
    const parsed = provider.parseShareUrl?.(input);

    if (!parsed) throw appError('invalid_playlist', `Unrecognized link: ${input}`);

    if (parsed.kind === 'playlist') {
      return { page: await this.getPlaylist(parsed.id, { signal }) };
    }
    if (parsed.kind === 'album') {
      return { page: await this.getAlbum(parsed.id, signal) };
    }
    return { track: await provider.getMetadata(parsed.id, signal) };
  }

  /** Resolve a playable stream for a track. */
  async resolveStream(track: Track, signal?: AbortSignal) {
    return providers.forTrack(track).resolve(track, signal);
  }

  /** Whether any configured source could play this track at all. */
  canPlay(track: Track): boolean {
    return streamResolver.canResolve(track);
  }

  /**
   * Resolve ahead of time so pressing "next" is instant. Failures are
   * swallowed: a prefetch is an optimisation, never a user-visible event.
   */
  prefetchStream(track: Track | null): void {
    if (!track) return;
    if (!streamResolver.canResolve(track)) return;
    if (streamResolver.peek(track)) return;

    void streamResolver.resolve(track).catch(() => undefined);
  }

  /** Force the next resolve for this track to go back to the network. */
  invalidateStream(track: Track): void {
    streamResolver.invalidate(track);
  }
}

export const MusicService = new MusicServiceImpl();
