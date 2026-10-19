import React, { useCallback, useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { COLORS, FONTS, SIZES } from '../constants/theme';
import { Album, ArtistPage } from '../core/types';
import { messageFor } from '../core/errors';
import { MusicService } from '../services/MusicService';
import { MediaPage } from '../components/lists/MediaPage';

type Params = { browseId: string; name: string; imageUrl?: string; subtitle?: string };

/**
 * An artist's own page. The name and photo from the search result show at
 * once; songs and albums fill in as the page loads.
 */
export default function ArtistPageScreen() {
  const navigation = useNavigation();
  const { params } = useRoute<RouteProp<{ ArtistPage: Params }, 'ArtistPage'>>();
  const [page, setPage] = useState<ArtistPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    MusicService.getArtistPage(
      params.browseId,
      { name: params.name, imageUrl: params.imageUrl, subtitle: params.subtitle },
      controller.signal
    )
      .then((p) => {
        if (controller.signal.aborted) return;
        setPage(p);
        setLoading(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(messageFor(e));
        setLoading(false);
      });
    return () => controller.abort();
  }, [params.browseId, params.name, params.imageUrl, params.subtitle, attempt]);

  const openAlbum = useCallback(
    (album: Album) => {
      (navigation as any).push('CollectionPage', {
        kind: 'album',
        browseId: album.browseId,
        title: album.title,
        subtitle: album.year ? `${album.artist} • ${album.year}` : album.artist,
        imageUrl: album.coverImageUrl,
      });
    },
    [navigation]
  );

  const albums = page?.albums ?? [];
  const extra =
    albums.length > 0 ? (
      <View style={styles.albums}>
        <Text style={styles.albumsTitle}>Albums & Singles</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.albumsRow}>
          {albums.map((a) => (
            <TouchableOpacity key={a.id} style={styles.card} activeOpacity={0.8} onPress={() => openAlbum(a)}>
              <Image source={{ uri: a.coverImageUrl }} style={styles.cardImage} />
              <Text style={styles.cardTitle} numberOfLines={1}>
                {a.title}
              </Text>
              {!!a.year && <Text style={styles.cardSub}>{a.year}</Text>}
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    ) : null;

  return (
    <MediaPage
      title={page?.name || params.name}
      subtitle={page?.subtitle || params.subtitle}
      imageUrl={page?.imageUrl || params.imageUrl}
      round
      tracks={page?.songs ?? []}
      label={page?.name || params.name}
      loading={loading}
      error={error}
      onRetry={() => setAttempt((n) => n + 1)}
      extra={extra}
      listTitle="Popular songs"
    />
  );
}

const styles = StyleSheet.create({
  albums: { marginTop: SIZES.lg, marginHorizontal: -SIZES.md },
  albumsTitle: {
    fontFamily: FONTS.bold,
    fontSize: 19,
    color: COLORS.text.primary,
    marginBottom: SIZES.sm,
    paddingHorizontal: SIZES.md,
  },
  albumsRow: { paddingHorizontal: SIZES.md, gap: SIZES.smd },
  card: { width: 132 },
  cardImage: { width: 132, height: 132, borderRadius: SIZES.radius.md, backgroundColor: COLORS.surfaceLight },
  cardTitle: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text.primary, marginTop: 6 },
  cardSub: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.secondary },
});
