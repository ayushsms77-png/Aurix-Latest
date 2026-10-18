import React from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pencil, ListMusic, Users, Disc3, Music2, Download, Clock, Heart, Radio } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { COLORS, SIZES, FONTS } from '../constants/theme';
import { Header } from '../components/common/Header';
import { ListRow } from '../components/common/ListRow';
import { SectionHeader } from '../components/common/SectionHeader';
import { MiniPlayer } from '../components/player/MiniPlayer';
import { StatusBarScrim } from '../components/common/StatusBarScrim';
import { usePlayer } from '../hooks/usePlayer';
import { useLibrary } from '../hooks/useLibrary';

type StackParams = {
  PlaylistsList: undefined;
  ArtistsList: undefined;
  AlbumsList: undefined;
  SongsList: undefined;
  DownloadedMusic: undefined;
  History: undefined;
  Playlist: { playlistId: string };
  SyncPlay: undefined;
  NowPlaying: undefined;
};

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<StackParams>>();
  const { playTrack, currentTrack, isPlaying, isLoading, togglePlayPause, next } = usePlayer();
  const { recentlyPlayed } = useLibrary();

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: SIZES.bottomInset }}
        showsVerticalScrollIndicator={false}
      >
        <Header
          title="Library"
          rightIcon={<Pencil color={COLORS.text.primary} size={22} />}
          onRightPress={() => navigation.navigate('PlaylistsList')}
        />

        <View style={styles.menu}>
          <ListRow icon={<ListMusic color={COLORS.text.primary} size={20} />} label="Playlists" onPress={() => navigation.navigate('PlaylistsList')} />
          <ListRow icon={<Radio color={COLORS.text.primary} size={20} />} label="Sync Play" subtitle="Listen together, in sync" onPress={() => navigation.navigate('SyncPlay')} />
          <ListRow icon={<Users color={COLORS.text.primary} size={20} />} label="Artists" onPress={() => navigation.navigate('ArtistsList')} />
          <ListRow icon={<Disc3 color={COLORS.text.primary} size={20} />} label="Albums" onPress={() => navigation.navigate('AlbumsList')} />
          <ListRow icon={<Music2 color={COLORS.text.primary} size={20} />} label="Songs" onPress={() => navigation.navigate('SongsList')} />
          <ListRow icon={<Download color={COLORS.text.primary} size={20} />} label="Downloaded Music" onPress={() => navigation.navigate('DownloadedMusic')} />
          <ListRow icon={<Clock color={COLORS.text.primary} size={20} />} label="Recently Added" onPress={() => navigation.navigate('History')} />
          <ListRow icon={<Heart color={COLORS.text.primary} size={20} />} label="Favorites" onPress={() => navigation.navigate('Playlist', { playlistId: 'liked' })} showDivider={false} />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Recently Added" onSeeAll={() => navigation.navigate('History')} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hscroll}>
            {recentlyPlayed.length ? (
              recentlyPlayed.slice(0, 10).map((track) => (
                <TouchableOpacity key={track.id} style={styles.card} activeOpacity={0.8} onPress={() => playTrack(track, { tracks: [track], label: 'Recently Added' })}>
                  <Image source={{ uri: track.albumImageUrl }} style={styles.cardImage} />
                  <Text style={styles.cardTitle} numberOfLines={1}>{track.title}</Text>
                  <Text style={styles.cardSubtitle} numberOfLines={1}>{track.artist.name}</Text>
                </TouchableOpacity>
              ))
            ) : (
              <Text style={styles.emptyHint}>Play something to see it here.</Text>
            )}
          </ScrollView>
        </View>
      </ScrollView>

      <StatusBarScrim />

      {currentTrack && (
        <MiniPlayer track={currentTrack} isPlaying={isPlaying} isLoading={isLoading} onPlayPause={togglePlayPause} onNext={next} onPress={() => navigation.navigate('NowPlaying')} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  // No horizontal padding here — ListRow already carries SIZES.md padding.
  // Double padding was pushing icons/labels right of the title's left edge.
  menu: {
    marginBottom: SIZES.xl,
  },
  section: { marginBottom: SIZES.lg },
  hscroll: { paddingHorizontal: SIZES.md, gap: SIZES.smd },
  card: { width: 140 },
  cardImage: { width: 140, height: 140, borderRadius: SIZES.radius.md, backgroundColor: COLORS.surfaceLight, marginBottom: SIZES.xs },
  cardTitle: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text.primary },
  cardSubtitle: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.secondary, marginTop: 2 },
  emptyHint: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.muted, paddingHorizontal: SIZES.md },
});
