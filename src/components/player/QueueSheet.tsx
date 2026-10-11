import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  GestureResponderEvent,
  Image,
  LayoutAnimation,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { X } from 'lucide-react-native';
import { COLORS, FONTS, SIZES } from '../../constants/theme';
import { Track } from '../../core/types';
import {
  ROW_HEIGHT,
  LONG_PRESS_MS,
  arrayMove,
  dragTarget,
  exceedsSlop,
  orderChanged,
} from './queueDrag';

// Smooth row shifts while dragging (Android needs this flag enabled once).
const anyUI = UIManager as any;
if (Platform.OS === 'android' && typeof anyUI.setLayoutAnimationEnabledExperimental === 'function') {
  anyUI.setLayoutAnimationEnabledExperimental(true);
}

/** Animated equalizer bars for the now-playing row (Image 4 look). */
const EqBars: React.FC = () => {
  const bar1 = useRef(new Animated.Value(6)).current;
  const bar2 = useRef(new Animated.Value(12)).current;
  const bar3 = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    const loops = [
      Animated.loop(Animated.sequence([
        Animated.timing(bar1, { toValue: 14, duration: 400, useNativeDriver: false }),
        Animated.timing(bar1, { toValue: 6, duration: 400, useNativeDriver: false }),
      ])),
      Animated.loop(Animated.sequence([
        Animated.timing(bar2, { toValue: 6, duration: 300, useNativeDriver: false }),
        Animated.timing(bar2, { toValue: 16, duration: 300, useNativeDriver: false }),
      ])),
      Animated.loop(Animated.sequence([
        Animated.timing(bar3, { toValue: 12, duration: 500, useNativeDriver: false }),
        Animated.timing(bar3, { toValue: 4, duration: 500, useNativeDriver: false }),
      ])),
    ];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.eqBars}>
      <Animated.View style={[styles.eqBar, { height: bar1 }]} />
      <Animated.View style={[styles.eqBar, { height: bar2 }]} />
      <Animated.View style={[styles.eqBar, { height: bar3 }]} />
    </View>
  );
};

interface QueueSheetProps {
  visible: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  upcoming: Track[];
  onClose: () => void;
  onJump: (id: string) => void;
  onRemove: (id: string) => void;
  /** Called on drag release with the new order of upcoming track ids. */
  onReorder: (ids: string[]) => void;
}

export const QueueSheet: React.FC<QueueSheetProps> = ({
  visible,
  currentTrack,
  isPlaying,
  upcoming,
  onClose,
  onJump,
  onRemove,
  onReorder,
}) => {
  const [order, setOrder] = useState<Track[]>(upcoming);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState(0);

  const orderRef = useRef<Track[]>(upcoming);
  const startIdsRef = useRef<string[]>([]);
  const draggingRef = useRef(false);
  /** Row that has been held long enough to lift; only that row may start a drag. */
  const armedRef = useRef<string | null>(null);
  /** Set when a hold lifted a row, so the touch-up does not also count as a tap. */
  const suppressTapRef = useRef(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const carryRef = useRef(0);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const lengthRef = useRef(0);
  lengthRef.current = order.length;
  const panCache = useRef<Map<string, ReturnType<typeof PanResponder.create>>>(new Map());

  // Keep local order in sync with the real queue (except mid-drag).
  useEffect(() => {
    if (!draggingRef.current) {
      orderRef.current = upcoming;
      setOrder(upcoming);
    }
  }, [upcoming, visible]);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  // Never leave a hold timer running if the sheet goes away.
  useEffect(() => () => clearHoldTimer(), []);

  /** Finger down on a row: start the "hold to lift" timer. */
  const onRowTouchStart = (id: string) => (e: GestureResponderEvent) => {
    suppressTapRef.current = false;
    touchStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    clearHoldTimer();
    if (lengthRef.current < 2) return; // nothing to reorder
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      armedRef.current = id;
      suppressTapRef.current = true;
      setDragId(id); // lifts the row and freezes list scrolling
    }, LONG_PRESS_MS);
  };

  /** Moving before the hold completes means the user is scrolling. */
  const onRowTouchMove = (e: GestureResponderEvent) => {
    if (!holdTimerRef.current) return;
    const dx = e.nativeEvent.pageX - touchStartRef.current.x;
    const dy = e.nativeEvent.pageY - touchStartRef.current.y;
    if (exceedsSlop(dx, dy)) clearHoldTimer();
  };

  /** Finger up/cancelled: drop an un-dragged hold. A live drag ends in its own release handler. */
  const onRowTouchEnd = () => {
    clearHoldTimer();
    if (!draggingRef.current) {
      armedRef.current = null;
      setDragId(null);
    }
  };

  /** One PanResponder per track id, cached — handlers read refs so no stale state. */
  const getPan = (id: string) => {
    const cached = panCache.current.get(id);
    if (cached) return cached;

    const finish = () => {
      const changed = orderChanged(startIdsRef.current, orderRef.current.map((t) => t.id));
      draggingRef.current = false;
      armedRef.current = null;
      carryRef.current = 0;
      setDragId(null);
      setDragDy(0);
      if (changed) onReorderRef.current(orderRef.current.map((t) => t.id));
    };

    const pan = PanResponder.create({
      // Only a row that was held long enough may take over the touch, so
      // ordinary taps and scrolling are left alone.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: () => armedRef.current === id,
      onMoveShouldSetPanResponderCapture: () => armedRef.current === id,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        draggingRef.current = true;
        carryRef.current = 0;
        startIdsRef.current = orderRef.current.map((t) => t.id);
        setDragId(id);
        setDragDy(0);
      },
      onPanResponderMove: (_evt, gesture) => {
        const effDy = gesture.dy + carryRef.current;
        const list = orderRef.current;
        const from = list.findIndex((t) => t.id === id);
        if (from < 0) return;
        const target = dragTarget(list.length, from, effDy);
        if (target !== from) {
          LayoutAnimation.easeInEaseOut();
          const next = arrayMove(list, from, target);
          orderRef.current = next;
          setOrder(next);
          carryRef.current -= (target - from) * ROW_HEIGHT;
          setDragDy(effDy - (target - from) * ROW_HEIGHT);
        } else {
          setDragDy(effDy);
        }
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
    panCache.current.set(id, pan);
    return pan;
  };

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Playing Next</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <X color={COLORS.text.secondary} size={20} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          scrollEnabled={dragId === null}
          showsVerticalScrollIndicator={false}
        >
          {/* Now playing row — pink + animated EQ, per Image 4 */}
          {currentTrack && (
            <View style={styles.currentRow}>
              <Image
                source={{ uri: currentTrack.albumImageUrl }}
                style={styles.artwork}
                resizeMode="cover"
              />
              <View style={styles.currentTextWrap}>
                <Text style={styles.currentTitle} numberOfLines={1}>{currentTrack.title}</Text>
                <Text style={styles.currentArtist} numberOfLines={1}>{currentTrack.artist.name}</Text>
              </View>
              {isPlaying && <EqBars />}
            </View>
          )}

          <View style={styles.divider} />

          {order.length > 1 && (
            <Text style={styles.hint}>Hold a song, then drag to reorder</Text>
          )}

          {order.length === 0 ? (
            <Text style={styles.emptyText}>Nothing queued.</Text>
          ) : (
            order.map((track) => {
              const isDragged = dragId === track.id;
              return (
                <View
                  key={track.id}
                  style={[
                    styles.row,
                    isDragged && styles.rowLifted,
                    isDragged && { transform: [{ translateY: dragDy }], zIndex: 20, elevation: 20 },
                  ]}
                >
                  {/* Hold anywhere on the song to lift it, then drag. The remove
                      button sits outside this zone so it never starts a drag. */}
                  <View
                    style={styles.dragZone}
                    {...getPan(track.id).panHandlers}
                    onTouchStart={onRowTouchStart(track.id)}
                    onTouchMove={onRowTouchMove}
                    onTouchEnd={onRowTouchEnd}
                    onTouchCancel={onRowTouchEnd}
                  >
                    <TouchableOpacity
                      style={styles.rowMain}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (suppressTapRef.current) {
                          suppressTapRef.current = false; // the hold, not a tap
                          return;
                        }
                        onJump(track.id);
                      }}
                    >
                      <Image
                        source={{ uri: track.albumImageUrl }}
                        style={styles.artwork}
                        resizeMode="cover"
                      />
                      <View style={styles.rowTextWrap}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{track.title}</Text>
                        <Text style={styles.rowArtist} numberOfLines={1}>{track.artist.name}</Text>
                      </View>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    onPress={() => onRemove(track.id)}
                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    style={styles.removeBtn}
                    activeOpacity={0.6}
                  >
                    <View style={styles.removeCircle}>
                      <X color={COLORS.text.secondary} size={14} />
                    </View>
                  </TouchableOpacity>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: COLORS.surfaceRaised,
    borderTopLeftRadius: SIZES.radius.lg,
    borderTopRightRadius: SIZES.radius.lg,
    padding: SIZES.lg,
  },
  grabber: {
    width: 36, height: 5,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 3,
    alignSelf: 'center',
    marginBottom: SIZES.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SIZES.md,
  },
  headerTitle: { fontFamily: FONTS.bold, fontSize: 20, color: COLORS.text.primary },
  closeBtn: { padding: SIZES.xs },
  currentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
  },
  currentTextWrap: { flex: 1, marginRight: SIZES.md },
  currentTitle: { fontFamily: FONTS.bold, fontSize: 16, color: COLORS.accent.green },
  currentArtist: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.accent.green, marginTop: 1 },
  eqBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 16 },
  eqBar: { width: 3, backgroundColor: COLORS.accent.green, borderRadius: 1.5 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.hairline,
    marginVertical: SIZES.sm,
  },
  // The list is 8px wider than the sheet's content on each side, with 8px of
  // padding put back inside it: nothing moves, but a lifted row's background
  // can extend past the artwork without being clipped at the list's edge.
  scroll: { marginHorizontal: -SIZES.sm },
  scrollContent: { paddingHorizontal: SIZES.sm, paddingBottom: SIZES.lg },
  // Side padding + equal negative margin: invisible normally, but lets the
  // lifted row's background extend past the artwork edge.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingHorizontal: SIZES.sm,
    marginHorizontal: -SIZES.sm,
  },
  rowLifted: {
    backgroundColor: '#2C2C2E',
    borderRadius: SIZES.radius.sm,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  dragZone: { flex: 1, minWidth: 0 },
  rowMain: { flexDirection: 'row', alignItems: 'center', height: ROW_HEIGHT, paddingRight: SIZES.sm },
  rowTextWrap: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.text.primary },
  rowArtist: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.secondary, marginTop: 1 },
  artwork: {
    width: 48, height: 48,
    borderRadius: SIZES.radius.sm,
    backgroundColor: COLORS.surfaceLight,
    marginRight: SIZES.md,
  },
  // 44px touch target with a small round button inside, kept clear of the
  // song text and the sheet edge so it is not hit by accident.
  removeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: SIZES.xs,
  },
  removeCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    fontFamily: FONTS.regular,
    fontSize: 12,
    color: COLORS.text.muted,
    marginBottom: SIZES.xs,
  },
  emptyText: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    color: COLORS.text.secondary,
    textAlign: 'center',
    marginTop: SIZES.lg,
  },
});
