import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS, SIZES, FONTS } from '../constants/theme';
import { useLibrary } from '../hooks/useLibrary';
import { resolveAlbumTarget } from '../services/LibraryLinks';

export default function AlbumsListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { liked, playlists, recentlyPlayed } = useLibrary();

  const albums = useMemo(() => {
    const tracks = [...liked, ...playlists.flatMap((p) => p.tracks), ...recentlyPlayed];
    const map = new Map<string, { name: string; artist: string; image: string; count: number }>();
    for (const t of tracks) {
      if (!t.album) continue;
      const a = map.get(t.album);
      if (a) a.count++;
      else map.set(t.album, { name: t.album, artist: t.artist.name, image: t.albumImageUrl, count: 1 });
    }
    return [...map.values()].sort((x, y) => y.count - x.count);
  }, [liked, playlists, recentlyPlayed]);

  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const openAlbum = useCallback(
    async (album: { name: string; artist: string; image: string }) => {
      if (opening) return; // one at a time
      setOpening(album.name);
      setNotice(null);
      try {
        const target = await resolveAlbumTarget(album.name, album.artist, album.image);
        if (!alive.current) return;
        if (target) (navigation as any).navigate('CollectionPage', target);
        else setNotice(`Could not find the album "${album.name}"`);
      } catch {
        if (alive.current) setNotice('Could not open the page. Check your connection.');
      } finally {
        if (alive.current) setOpening(null);
      }
    },
    [navigation, opening]
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + SIZES.xl }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <ChevronLeft color={COLORS.text.primary} size={26} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Albums</Text>
      </View>

      {!!notice && <Text style={styles.notice}>{notice}</Text>}

      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + SIZES.xxl }]}>
        {albums.length ? (
          albums.map((album) => (
            <TouchableOpacity key={album.name} style={styles.row} activeOpacity={0.7} onPress={() => openAlbum(album)}>
              <Image source={{ uri: album.image }} style={styles.image} />
              <View style={styles.info}>
                <Text style={styles.title}>{album.name}</Text>
                <Text style={styles.subtitle}>{album.artist}</Text>
              </View>
              {opening === album.name && <ActivityIndicator color={COLORS.text.secondary} />}
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyHint}>Albums appear here as you save music.</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SIZES.md, paddingBottom: SIZES.md },
  backButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontFamily: FONTS.bold, fontSize: 22, color: COLORS.text.primary },
  scrollContent: { paddingHorizontal: SIZES.md },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: SIZES.md },
  image: { width: 64, height: 64, borderRadius: SIZES.radius.sm, backgroundColor: COLORS.surfaceLight },
  info: { flex: 1, marginLeft: SIZES.md, justifyContent: 'center' },
  title: { fontFamily: FONTS.medium, fontSize: 16, color: COLORS.text.primary, marginBottom: 4 },
  subtitle: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.secondary },
  notice: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.accent.red, paddingHorizontal: SIZES.md, paddingBottom: SIZES.sm },
  emptyHint: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.muted, paddingVertical: SIZES.sm },
});
