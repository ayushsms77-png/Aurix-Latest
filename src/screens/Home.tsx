import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  Image,
  TouchableOpacity,
  Animated,
  Easing,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bell } from 'lucide-react-native';
import { COLORS, SIZES, FONTS } from '../constants/theme';
import { SearchFilter, Track } from '../core/types';
import { usePlayer } from '../hooks/usePlayer';
import { useLibrary } from '../hooks/useLibrary';
import { MusicService } from '../services/MusicService';
import { TasteService } from '../services/TasteService';
import { MiniPlayer } from '../components/player/MiniPlayer';
import { StatusBarScrim } from '../components/common/StatusBarScrim';
import { useNavigation } from '@react-navigation/native';
import { TrackRow } from '../components/lists/TrackRow';
import { AddToPlaylistSheet } from '../components/lists/AddToPlaylistSheet';
import { squareArtOnly } from '../utils/rankResults';

type SectionDef = {
  key: string;
  title: string;
  kind: 'history' | 'liked' | 'search' | 'albums' | 'related';
  layout: 'h' | 'v' | 'grid';
  query?: string;
  /** Optional provider-side filter (e.g. 'Albums' returns albums only). */
  filter?: SearchFilter;
  cardSize?: number;
  radius?: number;
  limit?: number;
};

/** The exact 12-section home map, in order. */
const SECTIONS: SectionDef[] = [
  { key: 'madeForYou', title: 'Made For You', kind: 'search', layout: 'h', query: 'pop hits', cardSize: 210, radius: SIZES.radius.lg },
  { key: 'recentlyPlayed', title: 'Recently Played', kind: 'history', layout: 'h', cardSize: 168, radius: SIZES.radius.lg },
  { key: 'quickPicks', title: 'Quick Picks', kind: 'search', layout: 'grid', query: 'top hits playlist', limit: 6 },
  { key: 'trending', title: 'Trending Now', kind: 'search', layout: 'h', query: 'top global chart songs', cardSize: 128, radius: SIZES.radius.md },
  { key: 'loveSongs', title: 'Love', kind: 'search', layout: 'h', query: 'indian love songs hindi tum hi ho', cardSize: 128, radius: SIZES.radius.md },
  { key: 'partyHits', title: 'Party Hits', kind: 'search', layout: 'h', query: 'best party songs hindi punjabi', cardSize: 128, radius: SIZES.radius.md },
  { key: 'oldGold', title: 'Old Gold', kind: 'search', layout: 'h', query: 'old bollywood classic hits', cardSize: 128, radius: SIZES.radius.md },
  { key: 'popularAlbums', title: 'Popular Albums', kind: 'albums', layout: 'h', query: 'popular bollywood albums', filter: 'Albums', limit: 7, cardSize: 150, radius: SIZES.radius.lg },
  { key: 'newReleases', title: 'New Releases', kind: 'search', layout: 'h', query: 'new music releases', cardSize: 164, radius: SIZES.radius.lg },
  { key: 'basedOn', title: 'Based on Your Listening', kind: 'related', layout: 'h', cardSize: 128, radius: SIZES.radius.md },
  { key: 'favorites', title: 'Your Favorites', kind: 'liked', layout: 'v', limit: 10 },
  { key: 'listenMore', title: 'Listen More', kind: 'search', layout: 'v', query: 'evergreen bollywood hits', limit: 7 },
];

/**
 * "search"-kind sections are app-curated (Trending, Made For You, etc.) and
 * get hard-filtered to square-art-only tracks (see squareArtOnly). Fetching
 * only the display count would leave sections thin once video-type results
 * are dropped, so we over-fetch and let dataFor() trim to the real limit.
 */
const HOME_SEARCH_FETCH_LIMIT = 24;

/** Albums are fetched album-only and over-fetched; dataFor() trims to the section limit (7). */
const HOME_ALBUM_FETCH_LIMIT = 15;

/** Equalizer-style "now playing" badge on cards. */
const PlayingIndicator: React.FC = () => {
  const bar0 = useRef(new Animated.Value(4)).current;
  const bar1 = useRef(new Animated.Value(4)).current;
  const bar2 = useRef(new Animated.Value(4)).current;
  const bars = [bar0, bar1, bar2];

  useEffect(() => {
    const loops = bars.map((bar, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(bar, { toValue: 12, duration: 300, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(bar, { toValue: 6, duration: 300, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(bar, { toValue: 10, duration: 300, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(bar, { toValue: 4, duration: 300, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.playingIndicator}>
      {bars.map((bar, i) => (
        <Animated.View key={i} style={[styles.playingBar, { height: bar }]} />
      ))}
    </View>
  );
};

const HomeCard: React.FC<{
  track: Track;
  size: number;
  radius: number;
  showPlaying?: boolean;
  onPress: (track: Track) => void;
}> = memo(({ track, size, radius, showPlaying, onPress }) => (
  <TouchableOpacity style={{ width: size }} activeOpacity={0.85} onPress={() => onPress(track)}>
    <View style={[styles.cardImageWrap, { width: size, height: size, borderRadius: radius }]}>
      <Image
        source={{ uri: track.albumImageUrl }}
        style={styles.cardImage}
        resizeMode="cover"
      />
      {showPlaying && <PlayingIndicator />}
    </View>
    <Text style={styles.cardTitle} numberOfLines={1}>{track.title}</Text>
    <Text style={styles.cardSubtitle} numberOfLines={1}>{track.artist.name}</Text>
  </TouchableOpacity>
));
HomeCard.displayName = 'HomeCard';

const SkeletonCard: React.FC<{ size: number; radius: number }> = ({ size, radius }) => (
  <View style={{ width: size }}>
    <View style={[styles.skeletonBox, { width: size, height: size, borderRadius: radius }]} />
    <View style={[styles.skeletonLine, { width: '75%' }]} />
    <View style={[styles.skeletonLine, { width: '50%', marginTop: 4 }]} />
  </View>
);

const SkeletonRow: React.FC<{ small?: boolean }> = ({ small }) => (
  <View style={[styles.skeletonRow, small && { width: '48%' }]}>
    <View style={[styles.skeletonArt, small && { width: 44, height: 44 }]} />
    <View style={{ flex: 1 }}>
      <View style={[styles.skeletonLine, { width: '80%' }]} />
      <View style={[styles.skeletonLine, { width: '50%', marginTop: 6 }]} />
    </View>
  </View>
);

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { playTrack, currentTrack, isPlaying, togglePlayPause, isLoading, next } = usePlayer();
  const { recentlyPlayed, liked } = useLibrary();

  const [sectionData, setSectionData] = useState<Record<string, Track[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addingTrack, setAddingTrack] = useState<Track | null>(null);

  /** All search/album sections in parallel. */
  const fetchStatic = useCallback(async () => {
    const defs = SECTIONS.filter((s) => s.kind === 'search' || s.kind === 'albums');
    const results = await Promise.all(
      defs.map((s) =>
        MusicService.search(s.query ?? '', {
          filter: s.filter,
          limit: s.kind === 'search' ? HOME_SEARCH_FETCH_LIMIT : HOME_ALBUM_FETCH_LIMIT,
        })
          .then((r) => ({ key: s.key, kind: s.kind, r }))
          .catch(() => ({ key: s.key, kind: s.kind, r: null }))
      )
    );
    const map: Record<string, Track[]> = {};
    for (const { key, kind, r } of results) {
      if (!r) {
        map[key] = [];
        continue;
      }
      if (kind === 'albums') {
        map[key] = r.albums.slice(0, HOME_ALBUM_FETCH_LIMIT).map((a) => ({
          id: a.id,
          title: a.title,
          artist: { id: a.id, name: a.year ? `${a.artist} • ${a.year}` : a.artist },
          albumImageUrl: a.coverImageUrl,
          duration: 0,
          provider: a.provider,
          sourceId: a.browseId,
        }));
      } else {
        // "search" sections are app-curated -- hard filter to square art
        // only (see squareArtOnly's doc comment for why this list, and not
        // search/history/liked, is safe to filter this way).
        map[key] = kind === 'search' ? squareArtOnly(r.tracks) : r.tracks;
      }
    }
    setSectionData((m) => ({ ...m, ...map }));
  }, []);

  /**
   * "Based on Your Listening" -- prefers the artist with the highest learned
   * affinity (TasteService: built from real listens/completions/skips, not
   * just whichever track happened to play last). Falls back to last-played,
   * then a generic mood, for a brand-new listener with no signal yet.
   */
  const topTasteArtist = TasteService.getTopArtists(1)[0]?.artistName;
  const relatedQuery = topTasteArtist
    ? `${topTasteArtist} songs`
    : recentlyPlayed[0]?.artist.name
      ? `${recentlyPlayed[0].artist.name} songs`
      : 'chill mood playlist';

  const fetchRelated = useCallback(() => {
    return MusicService.search(relatedQuery, { limit: HOME_SEARCH_FETCH_LIMIT })
      .then((r) => setSectionData((m) => ({ ...m, basedOn: squareArtOnly(r.tracks) })))
      .catch(() => undefined);
  }, [relatedQuery]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await fetchStatic();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatic]);

  useEffect(() => {
    void fetchRelated();
  }, [fetchRelated]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStatic();
    await fetchRelated();
    setRefreshing(false);
  }, [fetchStatic, fetchRelated]);

  const playFrom = (tracks: Track[], label: string) => (track: Track) =>
    playTrack(track, { tracks, label });

  /** Album cards queue the whole album, not one synthetic row. */
  const openAlbum = useCallback(
    async (row: Track) => {
      try {
        const page = await MusicService.getAlbum(row.sourceId);
        if (page.tracks.length) playTrack(page.tracks[0], { tracks: page.tracks, label: row.title });
      } catch {
        // Silent: a dead album simply won't play.
      }
    },
    [playTrack]
  );

  const dataFor = (s: SectionDef): Track[] => {
    if (s.kind === 'history') return recentlyPlayed.slice(0, 10);
    if (s.kind === 'liked') return liked.slice(0, s.limit ?? 10);
    return (sectionData[s.key] ?? []).slice(0, s.limit ?? 10);
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: SIZES.bottomInset }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.text.secondary}
            colors={[COLORS.accent.green]}
            progressBackgroundColor={COLORS.surfaceLight}
          />
        }
      >
        <View style={[styles.header, { paddingTop: insets.top + SIZES.lg }]}>
          <Text style={styles.headerTitle}>Home</Text>
          <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Bell color={COLORS.text.primary} size={23} style={{ marginTop: 10 }} />
          </TouchableOpacity>
        </View>

        {SECTIONS.map((s, idx) => {
          const data = dataFor(s);
          const pending = loading && (s.kind === 'search' || s.kind === 'albums' || s.kind === 'related');
          if (data.length === 0 && !pending) return null; // hide empty sections entirely
          const isAlbums = s.kind === 'albums';

          return (
            <View key={s.key} style={[styles.section, idx === 0 && styles.firstSection]}>
              <Text style={styles.sectionTitle}>{s.title}</Text>

              {s.layout === 'h' && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hscroll}>
                  {data.length === 0
                    ? Array.from({ length: 5 }).map((_, i) => (
                        <SkeletonCard key={i} size={s.cardSize ?? 128} radius={s.radius ?? SIZES.radius.md} />
                      ))
                    : data.map((track) => (
                        <HomeCard
                          key={track.id}
                          track={track}
                          size={s.cardSize ?? 128}
                          radius={s.radius ?? SIZES.radius.md}
                          showPlaying={isPlaying && currentTrack?.id === track.id}
                          onPress={isAlbums ? openAlbum : playFrom(data, s.title)}
                        />
                      ))}
                </ScrollView>
              )}

              {s.layout === 'grid' && (
                <View style={styles.gridWrap}>
                  {data.length === 0
                    ? Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} small />)
                    : data.map((track) => (
                        <TouchableOpacity
                          key={track.id}
                          style={styles.gridCell}
                          activeOpacity={0.75}
                          onPress={() => playTrack(track, { tracks: data, label: s.title })}
                        >
                          <Image
                            source={{ uri: track.albumImageUrl }}
                            style={styles.gridArt}
                            resizeMode="cover"
                          />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.gridTitle} numberOfLines={1}>{track.title}</Text>
                            <Text style={styles.gridArtist} numberOfLines={1}>{track.artist.name}</Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                </View>
              )}

              {s.layout === 'v' && (
                <View style={styles.vlist}>
                  {data.length === 0
                    ? Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} />)
                    : data.map((track) => (
                        <TrackRow
                          key={track.id}
                          track={track}
                          onPress={playFrom(data, s.title)}
                          onMorePress={setAddingTrack}
                          isPlaying={currentTrack?.id === track.id && isPlaying}
                        />
                      ))}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <StatusBarScrim />
      <AddToPlaylistSheet track={addingTrack} onClose={() => setAddingTrack(null)} />

      {currentTrack && (
        <MiniPlayer
          track={currentTrack}
          isPlaying={isPlaying}
          isLoading={isLoading}
          onPlayPause={togglePlayPause}
          onNext={next}
          onPress={() => navigation.navigate('NowPlaying' as never)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SIZES.md,
    paddingBottom: 0,
    marginTop: SIZES.md,
  },
  headerTitle: {
    fontFamily: FONTS.extrabold,
    fontSize: 34,
    color: COLORS.text.primary,
    letterSpacing: -0.5,
  },
  section: { marginTop: SIZES.xl },
  // First section sits right under the "Home" title -- the normal section
  // gap plus the header's own padding left a big dead band there.
  firstSection: { marginTop: SIZES.md },
  sectionTitle: {
    fontFamily: FONTS.bold,
    fontSize: 20,
    color: COLORS.text.primary,
    paddingHorizontal: SIZES.md,
    marginBottom: SIZES.smd,
  },
  hscroll: { paddingHorizontal: SIZES.md, gap: SIZES.smd },
  // No horizontal padding here: TrackRow already pads itself by SIZES.md, and
  // adding it again pushed the artwork to double the screen margin.
  vlist: {},
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: SIZES.md,
  },
  gridCell: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    marginBottom: SIZES.smd,
  },
  gridArt: {
    width: 46,
    height: 46,
    borderRadius: SIZES.radius.sm,
    backgroundColor: COLORS.surfaceLight,
  },
  gridTitle: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text.primary },
  gridArtist: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.text.secondary, marginTop: 1 },
  cardImageWrap: {
    backgroundColor: COLORS.surfaceLight,
    overflow: 'hidden',
    marginBottom: SIZES.sm,
    position: 'relative',
  },
  cardImage: { width: '100%', height: '100%' },
  cardTitle: { fontFamily: FONTS.semibold, fontSize: 14, color: COLORS.text.primary },
  cardSubtitle: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.secondary, marginTop: 2 },
  playingIndicator: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 6,
  },
  playingBar: { width: 3, backgroundColor: '#fff', borderRadius: 2 },
  skeletonBox: { backgroundColor: COLORS.surfaceLight, marginBottom: SIZES.sm },
  skeletonLine: { height: 11, borderRadius: 4, backgroundColor: COLORS.surfaceLight },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.smd,
    marginBottom: SIZES.smd,
  },
  skeletonArt: {
    width: 52,
    height: 52,
    borderRadius: SIZES.radius.sm,
    backgroundColor: COLORS.surfaceLight,
  },
});
