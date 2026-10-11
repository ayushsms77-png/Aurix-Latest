/**
 * Canonical artist identity.
 *
 * The same artist reaches the app under different ids depending on the source:
 * search rows carry YouTube's real browse id when the row links to an artist
 * page, while related/radio rows always carry the synthetic `yt-artist:<name>`.
 * Keying anything by `artist.id` therefore split one artist into two. The one
 * value present in every source is the name, so identity is derived from that.
 *
 * Pure TypeScript with no React Native imports, so it can be tested on its own.
 *
 * Known limits (deliberate):
 *  - Two different artists with the identical name share a key.
 *  - Only the FIRST of a ", "-joined artist list is used (that is how the
 *    search parser joins several artists).
 *  - Case and ASCII punctuation are ignored; other scripts (e.g. Devanagari)
 *    are kept as written.
 */

const KEY_PREFIX = 'artist:';

/** Characters ignored when comparing names. */
const IGNORED = /[\s.,&'"`!?()[\]{}\-_/\\|:;*+=~^%$#@<>]+/g;

/** Labels YouTube puts where an artist should be, for things that are not music. */
const NOT_AN_ARTIST = new Set(['episode', 'podcast']);

const normalizeName = (name: string): string =>
  name.toLowerCase().replace(IGNORED, ' ').trim();

/** The first artist of a ", "-joined display name. */
export function primaryArtistName(name: string | undefined | null): string {
  if (typeof name !== 'string') return '';
  return name.split(',')[0].trim();
}

/**
 * Stable key for an artist, identical for every id variant of that artist.
 * Returns '' when no usable identity exists (callers must skip those):
 * podcast/episode rows are not artists, and "Unknown artist" falls back to the
 * provider id so unrelated unknowns are not merged into one "artist".
 */
export function artistKey(artist: { id?: string; name?: string } | undefined | null): string {
  if (!artist) return '';
  const norm = normalizeName(primaryArtistName(artist.name));
  if (NOT_AN_ARTIST.has(norm)) return '';
  if (norm && norm !== 'unknown artist') return KEY_PREFIX + norm;
  return typeof artist.id === 'string' ? artist.id : '';
}
