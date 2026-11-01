import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS, SIZES, FONTS } from '../constants/theme';
import { useLibrary } from '../hooks/useLibrary';
import { resolveArtistTarget } from '../services/LibraryLinks';

export default function ArtistsListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { liked, playlists, recentlyPlayed } = useLibrary();

  const artists = useMemo(() => {
    const tracks = [...liked, ...playlists.flatMap((p) => p.tracks), ...recentlyPlayed];
    const map = new Map<string, { name: string; id: string; image: string; count: number }>();
    for (const t of tracks) {
      const a = map.get(t.artist.name);
      if (a) a.count++;
      else map.set(t.artist.name, { name: t.artist.name, id: t.artist.id, image: t.albumImageUrl, count: 1 });
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

  const openArtist = useCallback(
    async (artist: { name: string; id: string; image: string }) => {
      if (opening) return; // one at a time
      setOpening(artist.name);
      setNotice(null);
      try {
        const target = await resolveArtistTarget(artist.name, artist.id, artist.image);
        if (!alive.current) return;
        if (target) (navigation as any).navigate('ArtistPage', target);
        else setNotice(`Could not find ${artist.name}'s page`);
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
        <Text style={styles.headerTitle}>Artists</Text>
      </View>

      {!!notice && <Text style={styles.notice}>{notice}</Text>}

      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + SIZES.xxl }]}>
        {artists.length ? (
          artists.map((artist) => (
            <TouchableOpacity key={artist.name} style={styles.row} activeOpacity={0.7} onPress={() => openArtist(artist)}>
              <Image source={{ uri: artist.image }} style={styles.image} />
              <View style={styles.info}>
                <Text style={styles.title}>{artist.name}</Text>
                <Text style={styles.subtitle}>
                  {artist.count} {artist.count === 1 ? 'song' : 'songs'}
                </Text>
              </View>
              {opening === artist.name && <ActivityIndicator color={COLORS.text.secondary} />}
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyHint}>Artists appear here as you save music.</Text>
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
  image: { width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.surfaceLight },
  info: { flex: 1, marginLeft: SIZES.md, justifyContent: 'center' },
  title: { fontFamily: FONTS.medium, fontSize: 16, color: COLORS.text.primary, marginBottom: 4 },
  subtitle: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.secondary },
  notice: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.accent.red, paddingHorizontal: SIZES.md, paddingBottom: SIZES.sm },
  emptyHint: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.muted, paddingVertical: SIZES.sm },
});
