import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Image,
  Modal,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListMusic, LogOut, Music2, Pause, Play, Share2, SkipBack, SkipForward, TriangleAlert } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS, FONTS, SIZES } from '../constants/theme';
import { useProgress } from '../hooks/usePlayer';
import { SyncHealth, useSyncPlay } from '../hooks/useSyncPlay';
import { RosterEntry } from '../sync/SyncSession';
import { SYNC } from '../sync/syncTypes';
import { ConfirmDialog } from '../components/common/ConfirmDialog';

const LIVE = '#34D399';
const SYNCING = '#F5A524';

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A bar that fills over `durationMs` (to ~92%) and snaps to full when `done`. */
const LoadingBar: React.FC<{ durationMs: number; done: boolean }> = ({ durationMs, done }) => {
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 0.92,
      duration: durationMs,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [durationMs, progress]);

  useEffect(() => {
    if (!done) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: 250,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [done, progress]);

  return (
    <View style={styles.barTrack} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View
        style={[
          styles.barFill,
          { width: progress.interpolate({ inputRange: [0, 1], outputRange: [0, width] }) },
        ]}
      />
    </View>
  );
};

/** The glowing "live sync" dot. Green = in step, amber = catching up, red = offline. */
const LiveDot: React.FC<{ health: SyncHealth }> = ({ health }) => {
  const pulse = useRef(new Animated.Value(0)).current;
  const color = health === 'live' ? LIVE : health === 'syncing' ? SYNCING : COLORS.accent.red;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[
          styles.dotGlow,
          {
            backgroundColor: color,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
          },
        ]}
      />
      <View style={[styles.dot, { backgroundColor: color, shadowColor: color }]} />
    </View>
  );
};

const statusOf = (m: RosterEntry, idx: number): { label: string; color: string } => {
  if (m.offline) return { label: 'Reconnecting…', color: COLORS.text.muted };
  if (m.err) return { label: "Can't play this song", color: COLORS.accent.red };
  if (m.loadedIdx === idx) return { label: 'Ready', color: LIVE };
  return { label: 'Loading…', color: SYNCING };
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * The Sync Play room. Locked: back gestures and the back button ask first, and
 * the only way out is the Exit button (after "Are you sure?").
 *
 * Deliberately a stripped-down player: album art, title, a read-only progress
 * bar (nobody can seek in a room), previous / play-pause / next, the queue and
 * Exit. No lyrics, no downloads, no add-to-playlist.
 */
export default function SyncRoomScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const sync = useSyncPlay();

  const [showQueue, setShowQueue] = useState(false);
  const mountedAt = useRef(Date.now()).current;
  const [barElapsed, setBarElapsed] = useState(false);
  const [syncingUntil, setSyncingUntil] = useState(0);
  const [, force] = useState(0);

  const phaseRef = useRef(sync.phase);
  phaseRef.current = sync.phase;
  const allowLeave = useRef(false);

  // ---- locking ------------------------------------------------------------
  const exitRoom = useCallback(() => {
    allowLeave.current = true;
    sync.leaveRoom();
    navigation.goBack();
  }, [navigation, sync]);

  const [exitAsk, setExitAsk] = useState(false);
  const confirmExit = useCallback(() => setExitAsk(true), []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phaseRef.current === 'idle') return false; // nothing to protect
      if (phaseRef.current === 'connecting') {
        exitRoom(); // still connecting: just cancel
        return true;
      }
      confirmExit();
      return true;
    });
    return () => sub.remove();
  }, [confirmExit, exitRoom]);

  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (allowLeave.current || phaseRef.current === 'idle') return;
        e.preventDefault();
        if (phaseRef.current === 'connecting') exitRoom();
        else confirmExit();
      }),
    [navigation, confirmExit, exitRoom]
  );

  // ---- 4-5 second connecting bar -------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => setBarElapsed(true), SYNC.CONNECT_MIN_BAR_MS);
    return () => clearTimeout(t);
  }, []);

  // When another device joins, show the bar again while the two sync up.
  const lastPulse = useRef(sync.joinPulse);
  useEffect(() => {
    if (sync.joinPulse !== lastPulse.current) {
      lastPulse.current = sync.joinPulse;
      setSyncingUntil(Date.now() + SYNC.CONNECT_MIN_BAR_MS);
      const t = setTimeout(() => force((n) => n + 1), SYNC.CONNECT_MIN_BAR_MS + 50);
      return () => clearTimeout(t);
    }
  }, [sync.joinPulse]);

  // ---- derived -----------------------------------------------------------
  const state = sync.roomState;
  const idx = state?.idx ?? 0;
  const track = sync.tracks[idx];
  const me = sync.roster.find((m) => m.me);
  const present = sync.roster.filter((m) => !m.offline).length;
  const online = sync.connection === 'online';
  const isPlaying = !!state?.playing;
  const isLast = idx >= sync.tracks.length - 1;
  const { position, duration } = useProgress(500);
  const total = duration || track?.duration || 0;
  const ratio = total > 0 ? Math.min(1, Math.max(0, position / total)) : 0;
  const art = Math.max(160, Math.min(width - 72, height * 0.32, 340));
  const showOverlay = Date.now() < syncingUntil;

  const onShare = () => {
    if (!sync.code) return;
    void Share.share({ message: `Join my Aurix Sync Play room with the code ${sync.code}` });
  };

  const helper = useMemo(() => {
    if (!online) return 'Reconnecting… your music keeps playing.';
    if (me?.err) return "This song couldn't load on your device. Press Next to continue.";
    if (present <= 1) return 'Waiting for friends to join. Share the room code.';
    if (!sync.canPlay && !isPlaying) return 'Getting everyone ready…';
    return '';
  }, [online, me?.err, present, sync.canPlay, isPlaying]);

  // ---- not in a room: connecting / failed ----------------------------------
  if (sync.phase === 'idle') {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <TriangleAlert color={COLORS.accent.red} size={34} />
        <Text style={styles.endTitle}>{sync.error ? 'Sync Play stopped' : 'Not in a room'}</Text>
        {!!sync.error && <Text style={styles.endText}>{sync.error}</Text>}
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => {
            allowLeave.current = true;
            sync.clearError();
            navigation.goBack();
          }}
        >
          <Text style={styles.primaryText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (sync.phase === 'connecting' || (!barElapsed && Date.now() - mountedAt < SYNC.CONNECT_MIN_BAR_MS)) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Music2 color={COLORS.accent.green} size={34} />
        <Text style={styles.endTitle}>Connecting devices…</Text>
        <Text style={styles.endText}>{sync.step || 'Syncing playlist…'}</Text>
        <View style={styles.barBox}>
          <LoadingBar durationMs={SYNC.CONNECT_MIN_BAR_MS} done={sync.phase === 'room' && barElapsed} />
        </View>
        <TouchableOpacity style={styles.ghostButton} onPress={exitRoom}>
          <Text style={styles.ghostText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---- the room ------------------------------------------------------------
  const liveLabel =
    sync.health === 'live' ? 'LIVE SYNC' : sync.health === 'syncing' ? 'SYNCING…' : 'OFFLINE';

  return (
    <View style={[styles.container, { paddingTop: insets.top + SIZES.md, paddingBottom: insets.bottom + SIZES.md }]}>
      {/* Top: glowing live dot */}
      <View style={styles.topRow}>
        <LiveDot health={sync.health} />
        <Text style={[styles.liveText, { color: sync.health === 'live' ? LIVE : sync.health === 'syncing' ? SYNCING : COLORS.accent.red }]}>
          {liveLabel}
        </Text>
        <View style={styles.flex} />
        <TouchableOpacity onPress={onShare} style={styles.codePill} activeOpacity={0.8}>
          <Text style={styles.codeText}>{sync.code}</Text>
          <Share2 color={COLORS.text.secondary} size={14} />
        </TouchableOpacity>
      </View>

      {/* Who is here */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        {sync.roster.map((m) => {
          const st = statusOf(m, idx);
          return (
            <View key={m.id} style={styles.chip}>
              <View style={[styles.chipDot, { backgroundColor: st.color }]} />
              <View>
                <Text style={styles.chipName} numberOfLines={1}>
                  {m.name}
                  {m.me ? ' (you)' : ''}
                </Text>
                <Text style={[styles.chipStatus, { color: st.color }]} numberOfLines={1}>
                  {st.label}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      {/* Album art */}
      <View style={styles.artWrap}>
        {track?.albumImageUrl ? (
          <Image source={{ uri: track.albumImageUrl }} style={[styles.art, { width: art, height: art }]} />
        ) : (
          <View style={[styles.art, styles.artEmpty, { width: art, height: art }]}>
            <Music2 color={COLORS.text.muted} size={48} />
          </View>
        )}
      </View>

      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>
          {track?.title ?? ''}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {track?.artist.name ?? ''}
        </Text>
        <Text style={[styles.helper, me?.err && styles.helperError]} numberOfLines={2}>
          {helper || ' '}
        </Text>
      </View>

      {/* Read-only progress */}
      <View style={styles.progress}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.time}>{formatTime(position)}</Text>
          <Text style={styles.time}>-{formatTime(Math.max(0, total - position))}</Text>
        </View>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.sideButton}
          onPress={sync.previous}
          disabled={!online}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <SkipBack color={online ? COLORS.text.primary : COLORS.text.disabled} size={30} fill={online ? COLORS.text.primary : COLORS.text.disabled} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.playButton, (!online || (!isPlaying && !sync.canPlay)) && styles.playDisabled]}
          onPress={sync.togglePlay}
          disabled={!online || (!isPlaying && !sync.canPlay)}
          activeOpacity={0.85}
        >
          {isPlaying ? (
            <Pause color="#000" size={32} fill="#000" />
          ) : (
            <Play color="#000" size={32} fill="#000" style={styles.playIcon} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.sideButton}
          onPress={sync.next}
          disabled={!online || isLast}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <SkipForward
            color={online && !isLast ? COLORS.text.primary : COLORS.text.disabled}
            size={30}
            fill={online && !isLast ? COLORS.text.primary : COLORS.text.disabled}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.flex} />

      {/* Bottom: Exit + Queue */}
      <View style={styles.bottomRow}>
        <TouchableOpacity style={[styles.bottomButton, styles.exitButton]} onPress={confirmExit} activeOpacity={0.85}>
          <LogOut color={COLORS.accent.red} size={18} />
          <Text style={[styles.bottomText, { color: COLORS.accent.red }]}>Exit</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.bottomButton} onPress={() => setShowQueue(true)} activeOpacity={0.85}>
          <ListMusic color={COLORS.text.primary} size={18} />
          <Text style={styles.bottomText}>Queue</Text>
        </TouchableOpacity>
      </View>

      {/* "Syncing with a new device" bar */}
      {showOverlay && (
        <View style={styles.overlay} pointerEvents="auto">
          <View style={styles.overlayCard}>
            <Text style={styles.overlayTitle}>Syncing devices…</Text>
            <Text style={styles.overlayText}>A new device joined. Getting everyone in step.</Text>
            <View style={styles.barBox}>
              <LoadingBar key={syncingUntil} durationMs={SYNC.CONNECT_MIN_BAR_MS} done={false} />
            </View>
          </View>
        </View>
      )}

      {/* Queue (read-only) */}
      <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
        <View style={styles.sheetBackdrop}>
          <TouchableOpacity style={styles.flex} activeOpacity={1} onPress={() => setShowQueue(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + SIZES.md }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Queue</Text>
            <Text style={styles.sheetSub}>
              {sync.tracks.length} {sync.tracks.length === 1 ? 'song' : 'songs'} · fixed for this room
            </Text>
            <ScrollView style={styles.sheetList}>
              {sync.tracks.map((t, i) => {
                const current = i === idx;
                return (
                  <View key={t.id} style={styles.qRow}>
                    <Text style={[styles.qIndex, current && styles.qCurrent]}>{current ? '▶' : i + 1}</Text>
                    {t.albumImageUrl ? (
                      <Image source={{ uri: t.albumImageUrl }} style={styles.qArt} />
                    ) : (
                      <View style={[styles.qArt, styles.artEmpty]}>
                        <Music2 color={COLORS.text.muted} size={16} />
                      </View>
                    )}
                    <View style={styles.qText}>
                      <Text style={[styles.qTitle, current && styles.qCurrent]} numberOfLines={1}>
                        {t.title}
                      </Text>
                      <Text style={styles.qArtist} numberOfLines={1}>
                        {t.artist.name}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.sheetClose} onPress={() => setShowQueue(false)}>
              <Text style={styles.sheetCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={exitAsk}
        title="Exit Sync Play?"
        message="Are you sure you want to exit? Playback will stop on this device."
        confirmLabel="Exit"
        cancelLabel="Stay"
        destructive
        onCancel={() => setExitAsk(false)}
        onConfirm={() => {
          setExitAsk(false);
          exitRoom();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background, paddingHorizontal: SIZES.lg },
  center: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },

  endTitle: { fontFamily: FONTS.bold, fontSize: 22, color: COLORS.text.primary, marginTop: SIZES.md },
  endText: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.text.secondary,
    textAlign: 'center',
    marginTop: SIZES.sm,
    paddingHorizontal: SIZES.md,
  },
  primaryButton: {
    marginTop: SIZES.lg,
    backgroundColor: COLORS.accent.green,
    borderRadius: SIZES.radius.pill,
    paddingHorizontal: SIZES.xl,
    paddingVertical: SIZES.smd,
  },
  primaryText: { fontFamily: FONTS.bold, fontSize: 16, color: '#fff' },
  ghostButton: { marginTop: SIZES.lg, padding: SIZES.sm },
  ghostText: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.text.secondary },

  barBox: { width: '100%', maxWidth: 320, marginTop: SIZES.lg },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: COLORS.player.progressTrack, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3, backgroundColor: COLORS.accent.green },

  topRow: { flexDirection: 'row', alignItems: 'center' },
  dotWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  dotGlow: { position: 'absolute', width: 12, height: 12, borderRadius: 6 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 6,
  },
  liveText: { fontFamily: FONTS.bold, fontSize: 13, letterSpacing: 1.6, marginLeft: 4 },
  codePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.pill,
    paddingHorizontal: SIZES.smd,
    paddingVertical: 6,
  },
  codeText: { fontFamily: FONTS.bold, fontSize: 14, letterSpacing: 3, color: COLORS.text.primary },

  chipScroll: { flexGrow: 0, marginTop: SIZES.smd, marginHorizontal: -SIZES.lg },
  chipRow: { paddingHorizontal: SIZES.lg, gap: SIZES.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SIZES.sm,
    backgroundColor: COLORS.surface,
    borderRadius: SIZES.radius.md,
    paddingHorizontal: SIZES.smd,
    paddingVertical: 8,
    maxWidth: 190,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipName: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text.primary },
  chipStatus: { fontFamily: FONTS.regular, fontSize: 11, marginTop: 1 },

  artWrap: { alignItems: 'center', marginTop: SIZES.lg },
  art: { borderRadius: SIZES.radius.lg, backgroundColor: COLORS.surfaceLight },
  artEmpty: { alignItems: 'center', justifyContent: 'center' },

  meta: { marginTop: SIZES.lg },
  title: { fontFamily: FONTS.bold, fontSize: 22, color: COLORS.text.primary },
  artist: { fontFamily: FONTS.regular, fontSize: 16, color: COLORS.text.secondary, marginTop: 2 },
  helper: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.muted, marginTop: SIZES.sm, minHeight: 36 },
  helperError: { color: COLORS.accent.red },

  progress: { marginTop: SIZES.sm },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: COLORS.player.progressTrack, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: COLORS.player.progressFill },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SIZES.sm },
  time: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.secondary },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    marginTop: SIZES.md,
  },
  sideButton: { padding: SIZES.sm },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playDisabled: { opacity: 0.4 },
  playIcon: { marginLeft: 4 },

  bottomRow: { flexDirection: 'row', gap: SIZES.smd },
  bottomButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SIZES.sm,
    height: 52,
    borderRadius: SIZES.radius.md,
    backgroundColor: COLORS.surfaceLight,
  },
  exitButton: { backgroundColor: COLORS.accent.redGlow },
  bottomText: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.text.primary },

  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SIZES.lg,
  },
  overlayCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.lg,
    padding: SIZES.lg,
    alignItems: 'center',
  },
  overlayTitle: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.text.primary },
  overlayText: {
    fontFamily: FONTS.regular,
    fontSize: 13,
    color: COLORS.text.secondary,
    textAlign: 'center',
    marginTop: 4,
  },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    maxHeight: '75%',
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: SIZES.lg,
    paddingTop: SIZES.sm,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.hairline,
    marginBottom: SIZES.smd,
  },
  sheetTitle: { fontFamily: FONTS.bold, fontSize: 20, color: COLORS.text.primary },
  sheetSub: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.muted, marginTop: 2, marginBottom: SIZES.smd },
  sheetList: { flexGrow: 0 },
  qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: SIZES.sm },
  qIndex: { width: 24, fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text.muted, textAlign: 'center' },
  qArt: { width: 44, height: 44, borderRadius: 8, marginHorizontal: SIZES.smd, backgroundColor: COLORS.surfaceLight },
  qText: { flex: 1 },
  qTitle: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.text.primary },
  qArtist: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.secondary, marginTop: 1 },
  qCurrent: { color: COLORS.accent.green },
  sheetClose: {
    marginTop: SIZES.smd,
    height: 48,
    borderRadius: SIZES.radius.md,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCloseText: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.text.primary },
});
