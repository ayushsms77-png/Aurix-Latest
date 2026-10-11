import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search as SearchIcon, X, Clock, TrendingUp, Play } from 'lucide-react-native';
import { COLORS, SIZES, FONTS } from '../constants/theme';
import { TrackRow } from '../components/lists/TrackRow';
import { AddToPlaylistSheet } from '../components/lists/AddToPlaylistSheet';
import { MiniPlayer } from '../components/player/MiniPlayer';
import { StatusBarScrim } from '../components/common/StatusBarScrim';
import { BROWSE_CATEGORIES } from '../data/catalog';
import { Track } from '../core/types';
import { useSearch } from '../hooks/useSearch';
import { usePlayer } from '../hooks/usePlayer';
import { MusicService } from '../services/MusicService';
import { useNavigation } from '@react-navigation/native';

const RECENT_KEY = 'note_recent_searches';
const MAX_RECENT = 4;
const TRENDING_QUERY = 'trending songs this week';
const CHART_QUERY = 'top global hits 2024';
/** Max songs shown for a search (top result + the rows under "Songs"); quality drops further down. */
const MAX_SONGS_SHOWN = 7;

async function loadRecent(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
async function saveRecent(list: string[]) {
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Non-critical — worst case, recent searches don't persist this session.
  }
}

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const {
    query,
    setQuery,
    results,
    isSearching,
    error,
    searchNow,
    retry,
    clear,
    hasResults,
  } = useSearch();

  const { playTrack, currentTrack, isPlaying, togglePlayPause, isLoading, next } = usePlayer();
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [trending, setTrending] = useState<Track[]>([]);
  const [chart, setChart] = useState<Track[]>([]);
  const [addingTrack, setAddingTrack] = useState<Track | null>(null);

  const isSearchingActive = query.trim().length > 0;

  // Discovery content — loads once, independent of search state.
  useEffect(() => {
    loadRecent().then(setRecentSearches);
    (async () => {
      const [t, c] = await Promise.all([
        MusicService.search(TRENDING_QUERY, { limit: 8 }).then((r) => r.tracks).catch(() => []),
        MusicService.search(CHART_QUERY, { limit: 10 }).then((r) => r.tracks).catch(() => []),
      ]);
      setTrending(t);
      setChart(c);
    })();
  }, []);

  const commitSearch = useCallback(
    (term: string) => {
      setQuery(term);
      searchNow(term);
      const trimmed = term.trim();
      if (!trimmed) return;
      setRecentSearches((prev) => {
        const nextList = [trimmed, ...prev.filter((s) => s.toLowerCase() !== trimmed.toLowerCase())].slice(
          0,
          MAX_RECENT
        );
        saveRecent(nextList);
        return nextList;
      });
    },
    [setQuery, searchNow]
  );

  const clearAllRecent = useCallback(() => {
    setRecentSearches([]);
    saveRecent([]);
  }, []);

  const removeOneRecent = useCallback((term: string) => {
    setRecentSearches((prev) => {
      const nextList = prev.filter((s) => s !== term);
      saveRecent(nextList);
      return nextList;
    });
  }, []);

  /**
   * Playing a search result plays just that song; usePlayer then keeps the
   * queue filled with tracks related to it (continuous playback), instead of
   * queueing the rest of the search results.
   */
  const onPlayTrack = useCallback(
    (track: Track) => {
      Keyboard.dismiss();
      playTrack(track, { tracks: [track], label: `Search • ${results.query}` });
    },
    [playTrack, results.query]
  );

  const playFrom = useCallback(
    (list: Track[], label: string) => (track: Track) => playTrack(track, { tracks: list, label }),
    [playTrack]
  );

  const onOpenCollection = useCallback(
    async (id: string, browseId: string, name: string, kind: 'album' | 'playlist') => {
      Keyboard.dismiss();
      setExpandingId(id);
      try {
        const page = kind === 'album' ? await MusicService.getAlbum(browseId) : await MusicService.getPlaylist(browseId);
        if (page.tracks.length) playTrack(page.tracks[0], { tracks: page.tracks, label: name });
      } catch {
        // The inline error row already covers failed lookups.
      } finally {
        setExpandingId(null);
      }
    },
    [playTrack]
  );

  const onOpenArtist = useCallback(
    async (id: string, browseId: string, name: string) => {
      Keyboard.dismiss();
      setExpandingId(id);
      try {
        const tracks = await MusicService.getArtistTracks(browseId);
        if (tracks.length) playTrack(tracks[0], { tracks, label: name });
      } catch {
        /* handled by the error row */
      } finally {
        setExpandingId(null);
      }
    },
    [playTrack]
  );

  // Synthetic Track objects for non-track results — unchanged from before.
  const artistRows = useMemo(
    () =>
      results.artists.map((artist) => ({
        id: artist.id,
        title: artist.name,
        artist: { id: artist.id, name: artist.subtitle ?? 'Artist' },
        albumImageUrl: artist.imageUrl,
        duration: 0,
        provider: artist.provider,
        sourceId: artist.browseId,
      })),
    [results.artists]
  );
  const albumRows = useMemo(
    () =>
      results.albums.map((album) => ({
        id: album.id,
        title: album.title,
        artist: { id: album.id, name: album.year ? `${album.artist} • ${album.year}` : album.artist },
        albumImageUrl: album.coverImageUrl,
        duration: 0,
        provider: album.provider,
        sourceId: album.browseId,
      })),
    [results.albums]
  );
  const playlistRows = useMemo(
    () =>
      results.playlists.map((playlist) => ({
        id: playlist.id,
        title: playlist.name,
        artist: { id: playlist.id, name: playlist.creator },
        albumImageUrl: playlist.coverImageUrl,
        duration: 0,
        provider: playlist.provider,
        sourceId: playlist.browseId,
      })),
    [results.playlists]
  );

  const openArtistRow = useCallback((track: Track) => onOpenArtist(track.id, track.sourceId, track.title), [onOpenArtist]);
  const openAlbumRow = useCallback(
    (track: Track) => onOpenCollection(track.id, track.sourceId, track.title, 'album'),
    [onOpenCollection]
  );
  const openPlaylistRow = useCallback(
    (track: Track) => onOpenCollection(track.id, track.sourceId, track.title, 'playlist'),
    [onOpenCollection]
  );

  const [topResult, ...allRestTracks] = results.tracks;
  const restTracks = allRestTracks.slice(0, MAX_SONGS_SHOWN - 1);
  const showRecent = !isSearchingActive && recentSearches.length > 0;
  const showBrowse = !isSearchingActive;

  return (
    <View style={styles.container}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scrollContent, { paddingBottom: SIZES.bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingTop: insets.top + SIZES.xl }}>
          <Text style={styles.headerTitle}>Explore</Text>

          <View style={[styles.searchContainer, focused && styles.searchContainerFocused]}>
            <SearchIcon color={COLORS.text.secondary} size={19} />
            <TextInput
              style={styles.searchInput}
              placeholder="Songs, Artists or Albums"
              placeholderTextColor={COLORS.text.secondary}
              value={query}
              onChangeText={setQuery}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onSubmitEditing={() => commitSearch(query)}
              returnKeyType="search"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={clear} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <X color={COLORS.iconInactive} size={18} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {isSearchingActive ? (
          <>
            {error && (
              <TouchableOpacity activeOpacity={0.8} onPress={retry} style={styles.stateCard}>
                <Text style={styles.stateText}>{error}</Text>
                <Text style={styles.stateHint}>Tap to try again</Text>
              </TouchableOpacity>
            )}

            {isSearching && !hasResults && (
              <View style={styles.stateCenter}>
                <ActivityIndicator color={COLORS.text.secondary} />
              </View>
            )}

            {!isSearching && !error && !hasResults && (
              <View style={styles.noResults}>
                <View style={styles.noResultsIcon}>
                  <SearchIcon color={COLORS.text.muted} size={26} />
                </View>
                <Text style={styles.stateText}>No results for "{query.trim()}"</Text>
                <Text style={styles.stateHint}>Try a different spelling, or explore a category below</Text>
                <View style={styles.chipRow}>
                  {BROWSE_CATEGORIES.slice(0, 6).map((c) => (
                    <TouchableOpacity key={c.id} style={styles.chip} onPress={() => commitSearch(c.name)}>
                      <Text style={styles.chipText}>{c.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {!!topResult && (
              <TouchableOpacity style={styles.topResultCard} activeOpacity={0.85} onPress={() => onPlayTrack(topResult)}>
                <Image
                  source={{ uri: topResult.albumImageUrl }}
                  style={styles.topResultImage}
                  resizeMode="cover"
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.topResultLabel}>TOP RESULT</Text>
                  <Text style={styles.topResultTitle} numberOfLines={1}>{topResult.title}</Text>
                  <Text style={styles.topResultArtist} numberOfLines={1}>{topResult.artist.name}</Text>
                </View>
                <View style={styles.topResultPlay}>
                  <Play color="#fff" size={16} fill="#fff" />
                </View>
              </TouchableOpacity>
            )}

            {restTracks.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Songs</Text>
                <View style={styles.resultsList}>
                  {restTracks.map((track) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      onPress={onPlayTrack}
                      onMorePress={setAddingTrack}
                      isPlaying={currentTrack?.id === track.id && isPlaying}
                    />
                  ))}
                </View>
              </>
            )}

            {results.artists.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Artists</Text>
                <View style={styles.resultsList}>
                  {artistRows.map((row) => (
                    <TrackRow key={row.id} track={row} onPress={openArtistRow} isLoading={expandingId === row.id} />
                  ))}
                </View>
              </>
            )}

            {results.albums.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Albums</Text>
                <View style={styles.resultsList}>
                  {albumRows.map((row) => (
                    <TrackRow key={row.id} track={row} onPress={openAlbumRow} isLoading={expandingId === row.id} />
                  ))}
                </View>
              </>
            )}

            {results.playlists.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Playlists</Text>
                <View style={styles.resultsList}>
                  {playlistRows.map((row) => (
                    <TrackRow key={row.id} track={row} onPress={openPlaylistRow} isLoading={expandingId === row.id} />
                  ))}
                </View>
              </>
            )}
          </>
        ) : (
          <>
            {showRecent && (
              <View style={styles.recentSection}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionTitle}>Recent Searches</Text>
                  <TouchableOpacity onPress={clearAllRecent}>
                    <Text style={styles.clearAll}>Clear all</Text>
                  </TouchableOpacity>
                </View>
                {recentSearches.map((term) => (
                  <View key={term} style={styles.recentRowWrap}>
                    <TouchableOpacity style={styles.recentRow} onPress={() => commitSearch(term)}>
                      <Clock color={COLORS.accent.green} size={16} />
                      <Text style={styles.recentText} numberOfLines={1}>{term}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.recentRemove}
                      onPress={() => removeOneRecent(term)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <X color={COLORS.iconInactive} size={16} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {showBrowse && trending.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Trending Searches</Text>
                {trending.map((track) => (
                  <TouchableOpacity key={track.id} style={styles.trendingRow} onPress={() => playFrom(trending, 'Trending Searches')(track)}>
                    <TrendingUp color={COLORS.accent.green} size={16} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.trendingTitle} numberOfLines={1}>{track.title}</Text>
                      <Text style={styles.trendingArtist} numberOfLines={1}>{track.artist.name}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {showBrowse && chart.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Top Songs</Text>
                {chart.map((track, i) => (
                  <TouchableOpacity key={track.id} style={styles.chartRow} onPress={() => playFrom(chart, 'Top Songs')(track)}>
                    <Text style={styles.chartRank}>{i + 1}</Text>
                    <Image
                      source={{ uri: track.albumImageUrl }}
                      style={styles.chartImage}
                      resizeMode="cover"
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.trendingTitle} numberOfLines={1}>{track.title}</Text>
                      <Text style={styles.trendingArtist} numberOfLines={1}>{track.artist.name}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {showBrowse && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Browse Categories</Text>
                <View style={styles.categoriesGrid}>
                  {BROWSE_CATEGORIES.map((category) => (
                    <TouchableOpacity
                      key={category.id}
                      style={styles.categoryCard}
                      activeOpacity={0.8}
                      onPress={() => commitSearch(category.query)}
                    >
                      <Text style={styles.categoryName}>{category.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </>
        )}
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
  scrollContent: { paddingHorizontal: SIZES.md },
  headerTitle: {
    fontFamily: FONTS.extrabold,
    fontSize: 34,
    color: COLORS.text.primary,
    letterSpacing: -0.5,
    marginBottom: SIZES.md,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 10, // rectangular, not pill-like
    paddingHorizontal: SIZES.md,
    height: 50,
    marginBottom: SIZES.lg,
  },
  searchContainerFocused: {
    borderWidth: 2,
    borderColor: COLORS.accent.green,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    fontFamily: FONTS.regular,
    fontSize: 16,
    color: COLORS.text.primary,
  },
  section: { marginTop: SIZES.xl },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SIZES.sm,
  },
  sectionTitle: {
    fontFamily: FONTS.bold,
    fontSize: 19,
    color: COLORS.text.primary,
    marginBottom: SIZES.sm,
  },
  clearAll: {
    fontFamily: FONTS.semibold,
    fontSize: 12,
    color: COLORS.accent.green,
  },
  recentSection: { marginBottom: SIZES.md },
  // Recent rows share Trending Searches' look: same left edge, red icon, same
  // title style, no card or dividers.
  recentRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
  },
  recentRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.smd,
    paddingVertical: SIZES.sm,
  },
  recentText: {
    flex: 1,
    fontFamily: FONTS.semibold,
    fontSize: 14,
    color: COLORS.text.primary,
  },
  // Negative margin lines the X's visible edge up with "Clear all" above it.
  recentRemove: {
    padding: SIZES.sm,
    marginRight: -SIZES.sm,
  },
  categoriesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  categoryCard: {
    width: '48%',
    height: 76,
    borderRadius: SIZES.radius.lg,
    backgroundColor: COLORS.surfaceLight,
    justifyContent: 'center',
    paddingHorizontal: SIZES.md,
    marginBottom: SIZES.smd,
  },
  categoryName: {
    fontFamily: FONTS.bold,
    fontSize: 16,
    color: COLORS.text.primary,
  },
  trendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.smd,
    paddingVertical: SIZES.sm,
  },
  trendingTitle: { fontFamily: FONTS.semibold, fontSize: 14, color: COLORS.text.primary },
  trendingArtist: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.secondary, marginTop: 1 },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.smd,
    paddingVertical: SIZES.sm,
  },
  chartRank: {
    width: 22,
    fontFamily: FONTS.bold,
    fontSize: 15,
    color: COLORS.text.muted,
    textAlign: 'center',
  },
  chartImage: {
    width: 46,
    height: 46,
    borderRadius: SIZES.radius.md,
    backgroundColor: COLORS.surfaceLight,
  },
  topResultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.md,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.lg,
    padding: SIZES.md,
    marginBottom: SIZES.lg,
  },
  topResultImage: {
    width: 72,
    height: 72,
    borderRadius: SIZES.radius.md,
    backgroundColor: COLORS.surface,
  },
  topResultLabel: {
    fontFamily: FONTS.semibold,
    fontSize: 11,
    letterSpacing: 0.5,
    color: COLORS.text.muted,
    marginBottom: 4,
  },
  topResultTitle: { fontFamily: FONTS.bold, fontSize: 16, color: COLORS.text.primary },
  topResultArtist: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.secondary, marginTop: 2 },
  topResultPlay: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.accent.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultsList: { marginBottom: SIZES.lg },
  stateCard: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.md,
    padding: SIZES.md,
    marginBottom: SIZES.lg,
  },
  stateText: {
    fontFamily: FONTS.semibold,
    fontSize: 15,
    color: COLORS.text.primary,
    textAlign: 'center',
  },
  stateHint: {
    fontFamily: FONTS.regular,
    fontSize: 12.5,
    color: COLORS.text.secondary,
    marginTop: 4,
    textAlign: 'center',
  },
  stateCenter: { paddingVertical: SIZES.xl, alignItems: 'center' },
  noResults: { alignItems: 'center', paddingVertical: SIZES.xxl, gap: SIZES.xs },
  noResultsIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SIZES.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: SIZES.sm,
    marginTop: SIZES.md,
  },
  chip: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.sm,
    paddingHorizontal: SIZES.md,
    paddingVertical: SIZES.sm,
  },
  chipText: {
    fontFamily: FONTS.semibold,
    fontSize: 12.5,
    color: COLORS.text.secondary,
  },
});
