import React, { useEffect, useState } from 'react';
import { useRoute, RouteProp } from '@react-navigation/native';
import { Track } from '../core/types';
import { messageFor } from '../core/errors';
import { MusicService } from '../services/MusicService';
import { MediaPage } from '../components/lists/MediaPage';

type Params = {
  kind: 'album' | 'playlist';
  browseId: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
};

/** An album or a YouTube playlist on its own page (songs list + Play/Shuffle). */
export default function CollectionPageScreen() {
  const { params } = useRoute<RouteProp<{ CollectionPage: Params }, 'CollectionPage'>>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [cover, setCover] = useState(params.imageUrl);
  const [title, setTitle] = useState(params.title);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const load =
      params.kind === 'album'
        ? MusicService.getAlbum(params.browseId, controller.signal)
        : MusicService.getPlaylist(params.browseId, { signal: controller.signal });
    load
      .then((page) => {
        if (controller.signal.aborted) return;
        const art = params.imageUrl || page.playlist.coverImageUrl;
        // Album rows carry no artist: use the album's ("Arijit Singh • 2023" -> "Arijit Singh").
        const albumArtist =
          params.kind === 'album' ? (params.subtitle ?? '').split(' • ')[0].trim() : '';
        // Album rows often come without their own artwork: use the album cover.
        setTracks(
          page.tracks.map((t) => ({
            ...t,
            albumImageUrl: t.albumImageUrl || art || '',
            artist:
              albumArtist && (!t.artist?.name || /^unknown artist$/i.test(t.artist.name))
                ? { id: t.artist?.id ?? `yt-artist:${albumArtist}`, name: albumArtist }
                : t.artist,
            album: t.album ?? (params.kind === 'album' ? params.title : undefined),
          }))
        );
        if (art) setCover(art);
        if (page.playlist.name && page.playlist.name !== 'Playlist') setTitle(page.playlist.name);
        setLoading(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(messageFor(e));
        setLoading(false);
      });
    return () => controller.abort();
  }, [params.browseId, params.kind, params.imageUrl, params.title, attempt]);

  const count = tracks.length;
  const subtitle = [params.subtitle, count ? `${count} ${count === 1 ? 'song' : 'songs'}` : '']
    .filter(Boolean)
    .join(' • ');

  return (
    <MediaPage
      title={title}
      subtitle={subtitle || undefined}
      imageUrl={cover}
      tracks={tracks}
      label={title}
      canSaveToPlaylist
      loading={loading}
      error={error}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}
