import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Play, Shuffle, Heart } from 'lucide-react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { COLORS, SIZES, FONTS } from '../constants/theme';
import { TrackRow } from '../components/lists/TrackRow';
import { AddToPlaylistSheet } from '../components/lists/AddToPlaylistSheet';
import { QueueAddIcon } from '../components/icons/QueueAddIcon';
import { MiniPlayer } from '../components/player/MiniPlayer';
import { GlassCard } from '../components/common/GlassCard';
import { Track } from '../core/types';
import { usePlayer } from '../hooks/usePlayer';
import { useLibrary } from '../hooks/useLibrary';

type PlaylistRouteParams = { playlistId: string };
type PlaylistRoute = RouteProp<{ Playlist: PlaylistRouteParams }, 'Playlist'>;

/**
 * A playlist on its own page.
 *
 * Everything here operates strictly on this playlist's own tracks: pressing
 * Play queues exactly these, in this order, with this playlist as the context
 * label -- never the global recents list.
 */
export default function PlaylistDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<PlaylistRoute>();
  const { playlistId } = route.params;

  const { playlists, likedPlaylist } = useLibrary();
  const {
    playTrack,
    addToQueue,
    queue,
    currentTrack,
    isPlaying,
    isLoading,
    togglePlayPause,
    shuffle,
    toggleShuffle,
    next,
  } = usePlayer();

  /** Track whose "add to playlist" sheet is open. */
  const [addingTrack, setAddingTrack] = useState<Track | null>(null);

  /** Short confirmation shown at the bottom ("3 songs added to queue"). */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    []
  );

  const playlist = useMemo(
    () => (playlistId === 'liked' ? likedPlaylist : playlists.find((p) => p.id === playlistId)),
    [playlistId, playlists, likedPlaylist]
  );

  const tracks = playlist?.tracks ?? [];

  const playFromStart = useCallback(() => {
    if (!tracks.length || !playlist) return;
    if (shuffle) toggleShuffle(); // Play means in order.
    playTrack(tracks[0], { tracks, label: playlist.name });
  }, [tracks, playlist, playTrack, shuffle, toggleShuffle]);

  const playShuffled = useCallback(() => {
    if (!tracks.length || !playlist) return;

    const start = tracks[Math.floor(Math.random() * tracks.length)];
    playTrack(start, { tracks, label: playlist.name });
    if (!shuffle) toggleShuffle();
  }, [tracks, playlist, playTrack, shuffle, toggleShuffle]);

  const queueAll = useCallback(() => {
    if (!tracks.length) return;
    const inQueue = new Set(queue.map((t) => t.id));
    const added = tracks.filter((t) => !inQueue.has(t.id)).length;
    if (added === 0) {
      showNotice('Already in your queue');
      return;
    }
    addToQueue(tracks);
    showNotice(`${added} ${added === 1 ? 'song' : 'songs'} added to queue`);
  }, [tracks, queue, addToQueue, showNotice]);

  /** One stable callback for every row in this playlist. */
  const onTrackPress = useCallback(
    (track: Track) => {
      if (!playlist) return;
      playTrack(track, { tracks, label: playlist.name });
    },
    [playTrack, tracks, playlist]
  );

  const renderItem = useCallback(
    ({ item }: { item: Track }) => (
      <TrackRow
        track={item}
        onPress={onTrackPress}
        onMorePress={setAddingTrack}
        isPlaying={currentTrack?.id === item.id && isPlaying}
      />
    ),
    [onTrackPress, currentTrack?.id, isPlaying]
  );

  if (!playlist) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + SIZES.xxl }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={[styles.backButton, { top: insets.top + SIZES.sm }]}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <ChevronLeft color={COLORS.text.primary} size={28} />
        </TouchableOpacity>
        <GlassCard intensity={20} style={styles.emptyCard}>
          <Text style={styles.emptyText}>This playlist is no longer available.</Text>
        </GlassCard>
      </View>
    );
  }

  const isLikedPlaylist = playlist.id === 'liked';
  // Real cover art beats the flat placeholder: a normal playlist with no
  // explicit cover shows its first track's own artwork instead of a solid
  // block. Liked Songs never had a real cover to begin with (its
  // coverImageUrl is a sentinel, not a URL) -- it gets a heart instead.
  const coverImageUrl = isLikedPlaylist
    ? null
    : playlist.coverImageUrl || tracks[0]?.albumImageUrl || null;

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.artworkWrap}>
        {isLikedPlaylist ? (
          <View style={[styles.artwork, styles.likedArtwork]}>
            <Heart color={COLORS.text.primary} size={64} fill={COLORS.text.primary} />
          </View>
        ) : coverImageUrl ? (
          <Image source={{ uri: coverImageUrl }} style={styles.artwork} />
        ) : (
          <View style={[styles.artwork, styles.artworkFallback]} />
        )}
      </View>

      <Text style={styles.title} numberOfLines={2}>{playlist.name}</Text>
      <Text style={styles.meta} numberOfLines={1}>
        {playlist.creator ? `${playlist.creator} • ` : ''}
        {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
      </Text>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.primaryAction, !tracks.length && styles.actionDisabled]}
          activeOpacity={0.85}
          onPress={playFromStart}
          disabled={!tracks.length}
        >
          <Play color={COLORS.background} size={20} fill={COLORS.background} />
          <Text style={styles.primaryActionText}>Play</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryAction, !tracks.length && styles.actionDisabled]}
          activeOpacity={0.85}
          onPress={playShuffled}
          disabled={!tracks.length}
        >
          <Shuffle color={COLORS.text.primary} size={20} />
          <Text style={styles.secondaryActionText}>Shuffle</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.iconAction, !tracks.length && styles.actionDisabled]}
          activeOpacity={0.85}
          onPress={queueAll}
          disabled={!tracks.length}
        >
          <QueueAddIcon color={COLORS.text.primary} size={20} />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={tracks}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <GlassCard intensity={20} style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              {playlist.id === 'liked'
                ? 'Tap the heart on a track to save it here.'
                : 'This playlist is empty.'}
            </Text>
          </GlassCard>
        }
        contentContainerStyle={{
          paddingTop: insets.top + SIZES.xxxl,
          paddingBottom: SIZES.bottomInset,
        }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        windowSize={9}
        removeClippedSubviews
      />

      {/* Back button removed ONLY for Favorites/Liked Songs, per request --
          every regular playlist keeps its explicit back control. */}
      {!isLikedPlaylist && (
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={[styles.backButton, { top: insets.top + SIZES.sm }]}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <ChevronLeft color={COLORS.text.primary} size={28} />
        </TouchableOpacity>
      )}

      <AddToPlaylistSheet track={addingTrack} onClose={() => setAddingTrack(null)} />

      {!!notice && (
        <View pointerEvents="none" style={[styles.notice, { bottom: SIZES.bottomInset - 8 }]}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

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
  notice: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '88%',
    backgroundColor: COLORS.surfaceRaised,
    borderRadius: SIZES.radius.pill,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    paddingHorizontal: SIZES.md,
    paddingVertical: SIZES.smd,
  },
  noticeText: { fontFamily: FONTS.medium, fontSize: 14, color: COLORS.text.primary, textAlign: 'center' },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  backButton: {
    position: 'absolute',
    left: SIZES.md,
    zIndex: 30,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
  },
  headerBlock: {
    paddingHorizontal: SIZES.md,
    paddingBottom: SIZES.lg,
  },
  artworkWrap: {
    alignItems: 'center',
    marginBottom: SIZES.lg,
  },
  artwork: {
    width: 200,
    height: 200,
    borderRadius: SIZES.radius.md,
    backgroundColor: COLORS.surfaceLight,
  },
  artworkFallback: {
    backgroundColor: COLORS.surfaceRaised,
  },
  likedArtwork: {
    backgroundColor: COLORS.accent.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: FONTS.bold,
    fontSize: 28,
    color: COLORS.text.primary,
    marginBottom: SIZES.xs,
  },
  meta: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    color: COLORS.text.secondary,
    marginBottom: SIZES.lg,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
  },
  primaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    backgroundColor: COLORS.text.primary,
    paddingVertical: SIZES.sm + 4,
    paddingHorizontal: SIZES.lg,
    borderRadius: SIZES.radius.pill,
  },
  primaryActionText: {
    fontFamily: FONTS.medium,
    fontSize: 15,
    color: COLORS.background,
  },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    backgroundColor: COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    paddingVertical: SIZES.sm + 4,
    paddingHorizontal: SIZES.md,
    borderRadius: SIZES.radius.pill,
  },
  secondaryActionText: {
    fontFamily: FONTS.medium,
    fontSize: 15,
    color: COLORS.text.primary,
  },
  iconAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: SIZES.radius.pill,
    backgroundColor: COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
  },
  actionDisabled: {
    opacity: 0.4,
  },
  emptyCard: {
    marginHorizontal: SIZES.md,
    padding: SIZES.lg,
  },
  emptyText: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    color: COLORS.text.secondary,
  },
});
