/**
 * Pure helpers for choosing which related tracks to add to a queue or show on
 * Home. No React Native imports, so everything here can be tested on its own.
 *
 * The related feed is only a pool of candidates. These helpers decide what is
 * actually worth keeping: no repeats, no non-music, no long runs by one artist.
 */
import { artistKey } from './identity';

type MixTrack = {
  id: string;
  title: string;
  duration: number;
  artist: { id?: string; name?: string };
};

/** Anything longer is almost always a podcast, mix or compilation, not a song. */
export const MAX_SONG_SECONDS = 15 * 60;

/**
 * Same song, different upload: lower-case title with "(feat ...)", "[Official]",
 * "(From "Film")" style suffixes stripped, plus the primary artist.
 */
export function songKey(track: MixTrack): string {
  const title = (track.title ?? '')
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(feat|ft)\b\.?.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${title}|${artistKey(track.artist)}`;
}

type PickOptions = {
  /** Track ids already in the queue. */
  existingIds: Set<string>;
  /** songKey()s already in the queue (catches re-uploads of the same song). */
  existingSongKeys: Set<string>;
  /** Artist key of the track the new ones will follow, to avoid back-to-back repeats. */
  tailArtistKey?: string;
  limit: number;
  maxPerArtist: number;
};

/**
 * Choose up to `limit` new tracks from `candidates`, keeping YouTube's order
 * as far as the rules allow:
 *  - skips anything already queued (by id or as the same song),
 *  - skips things too long to be a song,
 *  - at most `maxPerArtist` per artist,
 *  - avoids the same artist twice in a row (including right after the tail).
 */
export function pickFresh<T extends MixTrack>(candidates: T[], opts: PickOptions): T[] {
  const seenIds = new Set(opts.existingIds);
  const seenSongs = new Set(opts.existingSongKeys);
  const eligible: T[] = [];

  for (const t of candidates) {
    if (!t || !t.id || seenIds.has(t.id)) continue;
    if (t.duration > MAX_SONG_SECONDS) continue;
    const sk = songKey(t);
    if (seenSongs.has(sk)) continue;
    seenIds.add(t.id);
    seenSongs.add(sk);
    eligible.push(t);
  }

  const perArtist = new Map<string, number>();
  const out: T[] = [];
  let lastArtist = opts.tailArtistKey ?? '';
  const remaining = eligible.slice();

  while (out.length < opts.limit && remaining.length) {
    const usable = (t: T) => {
      const key = artistKey(t.artist);
      return !key || (perArtist.get(key) ?? 0) < opts.maxPerArtist;
    };
    let idx = remaining.findIndex((t) => usable(t) && (!lastArtist || artistKey(t.artist) !== lastArtist));
    if (idx < 0) idx = remaining.findIndex(usable); // only same-artist options left
    if (idx < 0) break;
    const [pick] = remaining.splice(idx, 1);
    const key = artistKey(pick.artist);
    if (key) perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
    lastArtist = key;
    out.push(pick);
  }
  return out;
}

/**
 * Mix several related lists (one per seed track) round-robin, so no single
 * seed or artist dominates. Deduplicates by id and by song, drops excluded ids,
 * and caps tracks per artist.
 */
export function interleaveBySeed<T extends MixTrack>(
  lists: T[][],
  opts: { excludeIds: Set<string>; maxPerArtist: number; limit: number }
): T[] {
  const seenIds = new Set(opts.excludeIds);
  const seenSongs = new Set<string>();
  const perArtist = new Map<string, number>();
  const cursors = lists.map(() => 0);
  const out: T[] = [];

  let progressed = true;
  while (out.length < opts.limit && progressed) {
    progressed = false;
    for (let i = 0; i < lists.length && out.length < opts.limit; i++) {
      const list = lists[i];
      while (cursors[i] < list.length) {
        const t = list[cursors[i]++];
        if (!t || !t.id || seenIds.has(t.id)) continue;
        if (t.duration > MAX_SONG_SECONDS) continue;
        const sk = songKey(t);
        if (seenSongs.has(sk)) continue;
        const key = artistKey(t.artist);
        if (key && (perArtist.get(key) ?? 0) >= opts.maxPerArtist) continue;
        seenIds.add(t.id);
        seenSongs.add(sk);
        if (key) perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
        out.push(t);
        progressed = true;
        break; // one per list per round
      }
    }
  }
  return out;
}

/**
 * Seeds for a "based on your listening" row: the most recent tracks, one per
 * artist, so three seeds means three different tastes rather than one artist's
 * album played back to back.
 */
export function pickSeeds<T extends MixTrack>(recent: T[], count: number): T[] {
  const seen = new Set<string>();
  const seeds: T[] = [];
  for (const t of recent) {
    const key = artistKey(t.artist) || t.id;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push(t);
    if (seeds.length >= count) break;
  }
  return seeds;
}
