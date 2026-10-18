import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Music2, TriangleAlert, Wrench } from 'lucide-react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { COLORS, FONTS, SIZES } from '../constants/theme';
import { GlassCard } from '../components/common/GlassCard';
import { Playlist } from '../core/types';
import { useLibrary } from '../hooks/useLibrary';
import { useSyncPlay } from '../hooks/useSyncPlay';
import { normalizeCode, prepareTracks, SYNC } from '../sync/syncTypes';

type StackParams = { SyncRoom: undefined; PlaylistsList: undefined };

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Make a playlist',
    body: `In Library → Playlists, create a playlist with up to ${SYNC.MAX_TRACKS} songs.`,
  },
  {
    title: 'Import it here',
    body: 'Come back to this page and pick that playlist. A room is created for it.',
  },
  {
    title: 'Share the room code',
    body: `Up to ${SYNC.MAX_MEMBERS - 1} friends enter the code below on their own phones. Everyone hears the same song at the same time.`,
  },
];

/**
 * Library → Sync Play. Explains the idea, lists the user's playlists that fit
 * (1-10 songs) for importing into a new room, and lets a friend join with a code.
 * Songs can not be added inside a room: the playlist is fixed when it is imported.
 */
export default function SyncPlayScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<StackParams>>();
  const { playlists, likedPlaylist, profile } = useLibrary();
  const sync = useSyncPlay();
  const [codeInput, setCodeInput] = useState('');

  useFocusEffect(
    useCallback(() => {
      void sync.refreshFlag();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const entries = useMemo(() => {
    const all: Playlist[] = [likedPlaylist, ...[...playlists].sort((a, b) => b.updatedAt - a.updatedAt)];
    return all.map((p) => {
      const prepared = prepareTracks(p.tracks);
      return {
        playlist: p,
        count: p.tracks.length,
        reason: prepared.ok ? null : prepared.reason,
      };
    });
  }, [likedPlaylist, playlists]);

  const usable = entries.filter((e) => e.reason === null);
  const available = sync.flag.checked && sync.flag.enabled;
  const busy = sync.phase !== 'idle';
  const displayName = profile.name?.trim() || 'Guest';

  const openRoomScreen = () => navigation.navigate('SyncRoom');

  const onPick = (p: Playlist) => {
    if (!available || busy) return;
    Alert.alert(
      'Start a Sync Play room?',
      `"${p.name}" (${p.tracks.length} ${p.tracks.length === 1 ? 'song' : 'songs'}) will be shared with everyone who joins. Songs can't be changed once the room starts.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start room',
          onPress: () => {
            openRoomScreen();
            sync.createRoom(p.tracks, displayName);
          },
        },
      ]
    );
  };

  const normalized = normalizeCode(codeInput);
  const onJoin = () => {
    if (!normalized || !available || busy) return;
    Keyboard.dismiss();
    openRoomScreen();
    sync.joinRoom(normalized, displayName);
  };

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
        <Text style={styles.headerTitle}>Sync Play</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + SIZES.xxl }]}
      >
        {sync.flag.checked && !sync.flag.enabled && (
          <View style={styles.maintenance}>
            <Wrench color={COLORS.text.primary} size={20} />
            <Text style={styles.maintenanceText}>{sync.flag.message}</Text>
          </View>
        )}

        {sync.error && (
          <TouchableOpacity style={styles.errorBox} activeOpacity={0.8} onPress={sync.clearError}>
            <TriangleAlert color={COLORS.accent.red} size={18} />
            <Text style={styles.errorText}>{sync.error}</Text>
          </TouchableOpacity>
        )}

        <GlassCard intensity={20} style={styles.card}>
          <Text style={styles.cardTitle}>Listen together, in sync</Text>
          <Text style={styles.cardLead}>
            Play the same playlist on up to {SYNC.MAX_MEMBERS} phones at once. Anyone in the room can
            play, pause, and skip songs.
          </Text>
          {STEPS.map((s, i) => (
            <View key={s.title} style={styles.step}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>{s.title}</Text>
                <Text style={styles.stepText}>{s.body}</Text>
              </View>
            </View>
          ))}
        </GlassCard>

        {busy && (
          <TouchableOpacity style={styles.resume} onPress={openRoomScreen} activeOpacity={0.85}>
            <Text style={styles.resumeText}>
              {sync.phase === 'room' ? 'Return to your room' : 'Connecting… tap to view'}
            </Text>
          </TouchableOpacity>
        )}

        <Text style={styles.sectionTitle}>Import a playlist</Text>
        <Text style={styles.sectionHint}>
          Only playlists with {SYNC.MAX_TRACKS} songs or fewer can be imported.
        </Text>

        {usable.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No playlist ready yet</Text>
            <Text style={styles.emptyText}>
              You need a playlist with 1 to {SYNC.MAX_TRACKS} songs. Create one first, then come back
              here to import it.
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => (navigation as any).navigate('PlaylistsList')}
            >
              <Text style={styles.emptyButtonText}>Go to Playlists</Text>
            </TouchableOpacity>
          </View>
        )}

        {entries.map(({ playlist, count, reason }) => {
          const ok = reason === null;
          const cover = playlist.coverImageUrl?.startsWith('http') ? playlist.coverImageUrl : null;
          const disabled = !ok || !available || busy;
          // Playlists with no songs are not worth listing at all.
          if (count === 0) return null;
          return (
            <TouchableOpacity
              key={playlist.id}
              activeOpacity={0.7}
              disabled={disabled}
              onPress={() => onPick(playlist)}
              style={[styles.row, !ok && styles.rowDim]}
            >
              {cover ? (
                <Image source={{ uri: cover }} style={styles.cover} />
              ) : (
                <View style={[styles.cover, styles.coverEmpty]}>
                  <Music2 color={COLORS.text.muted} size={20} />
                </View>
              )}
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {playlist.name}
                </Text>
                <Text style={[styles.rowSub, !ok && styles.rowSubWarn]} numberOfLines={1}>
                  {ok ? `${count} ${count === 1 ? 'song' : 'songs'}` : reason}
                </Text>
              </View>
              {ok && <Text style={[styles.pick, disabled && styles.pickDim]}>Import</Text>}
            </TouchableOpacity>
          );
        })}

        <Text style={[styles.sectionTitle, { marginTop: SIZES.xl }]}>Join a room</Text>
        <Text style={styles.sectionHint}>Got a code from a friend? Enter it here.</Text>
        <View style={styles.joinRow}>
          <TextInput
            style={styles.codeInput}
            placeholder="ROOM CODE"
            placeholderTextColor={COLORS.text.disabled}
            value={codeInput}
            onChangeText={(t) => setCodeInput(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            maxLength={SYNC.CODE_LENGTH}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="go"
            onSubmitEditing={onJoin}
          />
          <TouchableOpacity
            style={[styles.joinButton, (!normalized || !available || busy) && styles.joinDisabled]}
            disabled={!normalized || !available || busy}
            onPress={onJoin}
          >
            {sync.flag.checking ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.joinText}>Join</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
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
    paddingBottom: SIZES.md,
  },
  backButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontFamily: FONTS.bold, fontSize: 20, color: COLORS.text.primary },
  scroll: { paddingHorizontal: SIZES.md, paddingTop: SIZES.sm },

  maintenance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.smd,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.md,
    padding: SIZES.md,
    marginBottom: SIZES.md,
  },
  maintenanceText: { flex: 1, fontFamily: FONTS.medium, fontSize: 14, color: COLORS.text.primary },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    backgroundColor: COLORS.accent.redGlow,
    borderRadius: SIZES.radius.md,
    padding: SIZES.smd,
    marginBottom: SIZES.md,
  },
  errorText: { flex: 1, fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.primary },

  card: { padding: SIZES.md, marginBottom: SIZES.md },
  cardTitle: { fontFamily: FONTS.bold, fontSize: 20, color: COLORS.text.primary },
  cardLead: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.text.secondary,
    marginTop: SIZES.xs,
    marginBottom: SIZES.md,
  },
  step: { flexDirection: 'row', marginBottom: SIZES.smd },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: COLORS.accent.greenGlow,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SIZES.smd,
    marginTop: 2,
  },
  stepNumText: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.accent.green },
  stepBody: { flex: 1 },
  stepTitle: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.text.primary },
  stepText: {
    fontFamily: FONTS.regular,
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.text.secondary,
    marginTop: 2,
  },

  resume: {
    backgroundColor: COLORS.accent.green,
    borderRadius: SIZES.radius.pill,
    paddingVertical: SIZES.smd,
    alignItems: 'center',
    marginBottom: SIZES.md,
  },
  resumeText: { fontFamily: FONTS.semibold, fontSize: 15, color: '#fff' },

  sectionTitle: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.text.primary },
  sectionHint: {
    fontFamily: FONTS.regular,
    fontSize: 13,
    color: COLORS.text.muted,
    marginTop: 2,
    marginBottom: SIZES.smd,
  },

  empty: {
    backgroundColor: COLORS.surface,
    borderRadius: SIZES.radius.md,
    padding: SIZES.md,
    marginBottom: SIZES.smd,
  },
  emptyTitle: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.text.primary },
  emptyText: {
    fontFamily: FONTS.regular,
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.text.secondary,
    marginTop: 4,
  },
  emptyButton: {
    alignSelf: 'flex-start',
    marginTop: SIZES.smd,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.pill,
    paddingHorizontal: SIZES.md,
    paddingVertical: SIZES.sm,
  },
  emptyButtonText: { fontFamily: FONTS.semibold, fontSize: 14, color: COLORS.text.primary },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SIZES.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.hairline,
  },
  rowDim: { opacity: 0.5 },
  cover: { width: 48, height: 48, borderRadius: 10, backgroundColor: COLORS.surfaceLight },
  coverEmpty: { alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, marginLeft: SIZES.smd },
  rowTitle: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.text.primary },
  rowSub: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.secondary, marginTop: 2 },
  rowSubWarn: { color: COLORS.text.muted },
  pick: { fontFamily: FONTS.semibold, fontSize: 14, color: COLORS.accent.green, paddingLeft: SIZES.sm },
  pickDim: { color: COLORS.text.disabled },

  joinRow: { flexDirection: 'row', gap: SIZES.smd, alignItems: 'center' },
  codeInput: {
    flex: 1,
    height: 52,
    backgroundColor: COLORS.surface,
    borderRadius: SIZES.radius.md,
    paddingHorizontal: SIZES.md,
    fontFamily: FONTS.bold,
    fontSize: 20,
    letterSpacing: 6,
    color: COLORS.text.primary,
  },
  joinButton: {
    height: 52,
    paddingHorizontal: SIZES.lg,
    borderRadius: SIZES.radius.md,
    backgroundColor: COLORS.accent.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinDisabled: { backgroundColor: COLORS.surfaceLight },
  joinText: { fontFamily: FONTS.bold, fontSize: 16, color: '#fff' },
});
