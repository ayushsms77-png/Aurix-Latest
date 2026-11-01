import { Album, ArtistResult, SearchFilter, SearchResults } from '../core/types';
import { MusicService } from './MusicService';

/**
 * Opens an artist or album from the Library lists.
 *
 * A saved song only remembers the artist's id and the album's NAME (no album
 * id), so the page to open is found the same way a search would find it.
 */

type SearchFn = (
  query: string,
  options?: { filter?: SearchFilter; signal?: AbortSignal; limit?: number }
) => Promise<SearchResults>;

export type ArtistTarget = { browseId: string; name: string; imageUrl?: string; subtitle?: string };
export type AlbumTarget = {
  kind: 'album';
  browseId: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
};

/** A real YouTube Music artist page id (channel ids start with UC). */
const REAL_ARTIST_ID = /^UC[\w-]{15,}$/;

export function norm(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ')
    .replace(/[^a-z0-9ऀ-ॿÀ-ɏ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Luis Fonsi, Daddy Yankee" / "A & B" -> "Luis Fonsi". */
export function firstArtistName(name: string): string {
  return (name.split(/,|&| x |\bfeat\.?\b/i)[0] ?? name).trim();
}

export function pickArtist(name: string, artists: ArtistResult[]): ArtistResult | null {
  if (!artists.length) return null;
  const want = norm(firstArtistName(name));
  return (
    artists.find((a) => norm(a.name) === want) ??
    artists.find((a) => want && norm(a.name).includes(want)) ??
    null
  );
}

export function pickAlbum(albumName: string, artistName: string, albums: Album[]): Album | null {
  if (!albums.length) return null;
  const want = norm(albumName);
  const artist = norm(firstArtistName(artistName));
  const sameTitle = albums.filter((a) => norm(a.title) === want);
  const pool = sameTitle.length ? sameTitle : albums.filter((a) => want && (norm(a.title).includes(want) || (want.includes(norm(a.title)) && norm(a.title).length > 3)));
  if (!pool.length) return null;
  // Best first: same artist, then the title exactly as saved (not "(Deluxe)" etc.).
  const exact = (a: Album) => a.title.trim().toLowerCase() === albumName.trim().toLowerCase();
  const sameArtist = (a: Album) => !!artist && norm(a.artist).includes(artist);
  const rank = (a: Album) => (sameArtist(a) ? 2 : 0) + (exact(a) ? 1 : 0);
  return [...pool].sort((x, y) => rank(y) - rank(x))[0];
}

export async function resolveArtistTarget(
  name: string,
  artistId: string | undefined,
  image: string | undefined,
  search: SearchFn = (q, o) => MusicService.search(q, o),
  signal?: AbortSignal
): Promise<ArtistTarget | null> {
  if (artistId && REAL_ARTIST_ID.test(artistId)) {
    return { browseId: artistId, name: firstArtistName(name), imageUrl: image };
  }
  const found = await search(firstArtistName(name), { filter: 'Artists', limit: 8, signal });
  const hit = pickArtist(name, found.artists);
  return hit ? { browseId: hit.browseId, name: hit.name, imageUrl: hit.imageUrl || image, subtitle: hit.subtitle } : null;
}

export async function resolveAlbumTarget(
  albumName: string,
  artistName: string,
  image: string | undefined,
  search: SearchFn = (q, o) => MusicService.search(q, o),
  signal?: AbortSignal
): Promise<AlbumTarget | null> {
  const found = await search(`${albumName} ${firstArtistName(artistName)}`, { filter: 'Albums', limit: 10, signal });
  const hit = pickAlbum(albumName, artistName, found.albums);
  if (!hit) return null;
  return {
    kind: 'album',
    browseId: hit.browseId,
    title: hit.title,
    subtitle: hit.year ? `${hit.artist} • ${hit.year}` : hit.artist,
    imageUrl: hit.coverImageUrl || image,
  };
}
