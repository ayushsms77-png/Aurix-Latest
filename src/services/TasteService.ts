import { readJson, writeJsonDebounced, STORAGE_KEYS } from '../core/storage';
import { Track } from '../core/types';
import { artistKey, primaryArtistName } from '../recommendation/identity';

/**
 * Per-artist affinity, learned incrementally from real listening behaviour.
 *
 * Deliberately artist-scoped: the app's Track model carries no genre or
 * mood data (see core/types.ts) to score by, so this covers the one taste
 * dimension the data actually supports.
 *
 * Artists are identified by a canonical key built from the artist's NAME
 * (recommendation/identity.ts), not the provider's artist id: the same artist
 * arrives under different provider ids from search and from related tracks.
 */
export type ArtistScore = {
  /** Canonical artist key. Older saved data holds provider ids; re-keyed on load. */
  artistId: string;
  /** Primary artist's display name (not a ", "-joined list). */
  artistName: string;
  /** Score as of `updatedAt`. Fades with time -- see decayed(). */
  score: number;
  updatedAt: number;
};

const STRONG_LISTEN = 4; // crossed the "real listen" threshold (see usePlayer)
const FULL_COMPLETE = 6; // played all the way to the end
const EARLY_SKIP = -5; // left before the threshold -- a clear pass

/**
 * Scores fade with real time, not with how often the artist is played: every
 * day without a signal multiplies the score by this (half-life ~23 days). An
 * old favourite therefore fades instead of staying on top forever.
 */
const DAILY_DECAY = 0.97;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Scores below this have faded to nothing and are not "top" artists. */
const MIN_TOP_SCORE = 1;

const MIN_SCORE = -50;
const MAX_SCORE = 50;

const clamp = (n: number) => Math.max(MIN_SCORE, Math.min(MAX_SCORE, n));

/** `score` as it stands at time `at`, having faded since `since`. */
export function decayed(score: number, since: number, at: number): number {
  const days = Math.max(0, (at - since) / DAY_MS);
  return score * Math.pow(DAILY_DECAY, days);
}

/**
 * Learns which artists a listener favours, purely from playback signals --
 * no history scan, ever. Each event updates exactly one artist's score in O(1).
 */
class TasteServiceImpl {
  private scores = new Map<string, ArtistScore>(); // canonical key -> score

  private loadPromise: Promise<void> | null = null;

  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.performLoad();
    return this.loadPromise;
  }

  private async performLoad(): Promise<void> {
    const stored = await readJson<unknown>(STORAGE_KEYS.tasteScores, []);
    const list = Array.isArray(stored) ? stored : [];
    const merged = new Map<string, ArtistScore>();
    let changed = false;

    for (const raw of list) {
      // A damaged entry is dropped; it must never stop the rest from loading.
      if (!raw || typeof raw !== 'object') {
        changed = true;
        continue;
      }
      const s = raw as Partial<ArtistScore>;
      if (typeof s.artistName !== 'string' || !Number.isFinite(s.score)) {
        changed = true;
        continue;
      }

      // Re-key by canonical identity: entries stored under a real browse id
      // and under a synthetic "yt-artist:" id for the same artist collapse
      // into one, and non-artists (podcast "Episode" rows) are dropped.
      const key = artistKey({ id: s.artistId, name: s.artistName });
      if (!key) {
        changed = true;
        continue;
      }
      const name = primaryArtistName(s.artistName) || s.artistName;
      if (key !== s.artistId || name !== s.artistName) changed = true;

      const updatedAt = Number.isFinite(s.updatedAt) ? (s.updatedAt as number) : 0;
      const score = clamp(s.score as number);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { artistId: key, artistName: name, score, updatedAt });
      } else {
        changed = true;
        // Two separate evidence streams for one artist: fade both to the later
        // time, add them, then re-bound.
        const at = Math.max(updatedAt, existing.updatedAt);
        merged.set(key, {
          artistId: key,
          artistName: updatedAt > existing.updatedAt ? name : existing.artistName,
          score: clamp(decayed(existing.score, existing.updatedAt, at) + decayed(score, updatedAt, at)),
          updatedAt: at,
        });
      }
    }

    this.scores = merged;
    if (changed) this.persist();
  }

  /**
   * `weight` scales the signal: tracks the user did not choose themselves
   * (queue auto-fill) count for less than ones they picked.
   */
  private bump(track: Track, delta: number, weight: number): void {
    const key = artistKey(track.artist);
    if (!key) return;

    const now = Date.now();
    const existing = this.scores.get(key);
    const base = existing ? decayed(existing.score, existing.updatedAt, now) : 0;
    const next = clamp(base + delta * weight);

    this.scores.set(key, {
      artistId: key,
      artistName: primaryArtistName(track.artist.name) || track.artist.name,
      score: next,
      updatedAt: now,
    });
    this.persist();
  }

  /** A genuine listen crossed the "real listen" threshold (see usePlayer). */
  recordListen(track: Track, weight = 1): void {
    this.bump(track, STRONG_LISTEN, weight);
  }

  /** The track played all the way to the end. */
  recordComplete(track: Track, weight = 1): void {
    this.bump(track, FULL_COMPLETE, weight);
  }

  /** Skipped before the "real listen" threshold -- a pass, not just a tap. */
  recordSkip(track: Track, weight = 1): void {
    this.bump(track, EARLY_SKIP, weight);
  }

  /** Current score for an artist, whichever provider id variant the caller holds. */
  getScore(artist: { id?: string; name?: string }): number {
    const s = this.scores.get(artistKey(artist));
    return s ? decayed(s.score, s.updatedAt, Date.now()) : 0;
  }

  /** Highest-affinity artists right now, most-favoured first. Faded/negative excluded. */
  getTopArtists(limit = 10): ArtistScore[] {
    const now = Date.now();
    return [...this.scores.values()]
      .map((s) => ({ ...s, score: decayed(s.score, s.updatedAt, now) }))
      .filter((s) => s.score >= MIN_TOP_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private persist(): void {
    writeJsonDebounced(STORAGE_KEYS.tasteScores, [...this.scores.values()], 1000);
  }
}

export const TasteService = new TasteServiceImpl();
