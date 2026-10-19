import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, ListPlus, Music2, Play, Shuffle } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS, FONTS, SIZES } from '../../constants/theme';
import { Track } from '../../core/types';
import { usePlayer } from '../../hooks/usePlayer';
import { TrackRow } from './TrackRow';
import { AddToPlaylistSheet } from './AddToPlaylistSheet';
import { MiniPlayer } from '../player/MiniPlayer';

type Props = {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  /** Artists get a round photo; albums and playlists a rounded square. */
  round?: boolean;
  tracks: Track[];
  /** Queue label shown by the player, e.g. the artist or album name. */
  label: string;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Shown between the buttons and the song list (e.g. an albums row). */
  extra?: React.ReactNode;
  listTitle?: string;
};

/**
 * The shared body of the artist, album and playlist pages: hero, Play /
 * Shuffle / Queue buttons, the song list, and the mini player. Pressing a song
 * plays the list from that song, like every other list in the app.
 */
export function MediaPage({
  title,
  subtitle,
  imageUrl,
  round,
  tracks,
  label,
  loading,
  error,
  onRetry,
  extra,
  listTitle = 'Songs',
}: Props) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { playTrack, addToQueue, currentTrack, isPlaying, isLoading, togglePlayPause, shuffle, toggleShuffle, next } =
    usePlayer();
  const [addingTrack, setAddingTrack] = useState<Track | null>(null);

  const playFromStart = useCallback(() => {
    if (!tracks.length) return;
    if (shuffle) toggleShuffle(); // Play means in order.
    playTrack(tracks[0], { tracks, label });
  }, [tracks, label, playTrack, shuffle, toggleShuffle]);

  const playShuffled = useCallback(() => {
    if (!tracks.length) return;
    const start = tracks[Math.floor(Math.random() * tracks.length)];
    playTrack(start, { tracks, label });
    if (!shuffle) toggleShuffle();
  }, [tracks, label, playTrack, shuffle, toggleShuffle]);

  const queueAll = useCallback(() => {
    if (tracks.length) addToQueue(tracks);
  }, [tracks, addToQueue]);

  const onTrackPress = useCallback(
    (track: Track) => playTrack(track, { tracks, label }),
    [playTrack, tracks, label]
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

  const disabled = !tracks.length;
  const artStyle = [styles.art, round && styles.artRound];

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.artWrap}>
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={artStyle} />
        ) : (
          <View style={[artStyle, styles.artEmpty]}>
            <Music2 color={COLORS.text.muted} size={48} />
          </View>
        )}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {!!subtitle && (
        <Text style={styles.meta} numberOfLines={2}>
          {subtitle}
        </Text>
      )}

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.primaryAction, disabled && styles.actionDisabled]}
          activeOpacity={0.85}
          onPress={playFromStart}
          disabled={disabled}
        >
          <Play color={COLORS.background} size={20} fill={COLORS.background} />
          <Text style={styles.primaryActionText}>Play</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryAction, disabled && styles.actionDisabled]}
          activeOpacity={0.85}
          onPress={playShuffled}
          disabled={disabled}
        >
          <Shuffle color={COLORS.text.primary} size={20} />
          <Text style={styles.secondaryActionText}>Shuffle</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.iconAction, disabled && styles.actionDisabled]}
          activeOpacity={0.85}
          onPress={queueAll}
          disabled={disabled}
        >
          <ListPlus color={COLORS.text.primary} size={20} />
        </TouchableOpacity>
      </View>

      {extra}

      {(tracks.length > 0 || loading) && <Text style={styles.listTitle}>{listTitle}</Text>}
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
          loading ? (
            <View style={styles.state}>
              <ActivityIndicator color={COLORS.text.secondary} />
            </View>
          ) : (
            <TouchableOpacity style={styles.state} activeOpacity={onRetry ? 0.7 : 1} onPress={onRetry}>
              <Text style={styles.stateText}>{error || 'Nothing to show here yet.'}</Text>
              {!!onRetry && <Text style={styles.stateHint}>Tap to try again</Text>}
            </TouchableOpacity>
          )
        }
        contentContainerStyle={{ paddingTop: insets.top + SIZES.xxxl, paddingBottom: SIZES.bottomInset }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        windowSize={9}
      />

      <TouchableOpacity
        onPress={() => navigation.goBack()}
        style={[styles.backButton, { top: insets.top + SIZES.sm }]}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <ChevronLeft color={COLORS.text.primary} size={28} />
      </TouchableOpacity>

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
  headerBlock: { paddingHorizontal: SIZES.md, paddingBottom: SIZES.md },
  artWrap: { alignItems: 'center', marginBottom: SIZES.lg },
  art: { width: 200, height: 200, borderRadius: SIZES.radius.md, backgroundColor: COLORS.surfaceLight },
  artRound: { borderRadius: 100 },
  artEmpty: { alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: FONTS.bold, fontSize: 28, color: COLORS.text.primary, marginBottom: SIZES.xs },
  meta: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.secondary, marginBottom: SIZES.lg },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SIZES.sm },
  primaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    backgroundColor: COLORS.text.primary,
    paddingVertical: SIZES.sm + 4,
    paddingHorizontal: SIZES.lg,
    borderRadius: SIZES.radius.pill,
  },
  primaryActionText: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.background },
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
  secondaryActionText: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.text.primary },
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
  actionDisabled: { opacity: 0.4 },
  listTitle: {
    fontFamily: FONTS.bold,
    fontSize: 19,
    color: COLORS.text.primary,
    marginTop: SIZES.lg,
  },
  state: { alignItems: 'center', paddingVertical: SIZES.xl, paddingHorizontal: SIZES.lg },
  stateText: { fontFamily: FONTS.medium, fontSize: 14, color: COLORS.text.secondary, textAlign: 'center' },
  stateHint: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.muted, marginTop: SIZES.xs },
});
