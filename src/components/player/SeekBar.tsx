import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, Text, View } from 'react-native';
import { COLORS, SIZES, FONTS } from '../../constants/theme';
import { usePlayer } from '../../hooks/usePlayer';
import { progressClock } from '../../playback/progressClock';

/** Seconds -> m:ss, for the progress labels. */
const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

type SeekBarProps = {
  /** Commits a final position, in seconds. */
  onSeek: (seconds: number) => void;
  /** Shows progress only: no dragging, no thumb (Video view). */
  readOnly?: boolean;
};

/**
 * Scrubber.
 *
 * The bar and thumb are driven by ONE animated value that runs on the native
 * UI thread: while a song plays, the value simply glides from "where we are"
 * to "the end of the track" at real speed. Nothing in JS has to tick for the
 * bar to move, so a busy JS thread can no longer make it freeze and jump.
 * It is re-aimed whenever the local clock re-anchors (seek, pause, resume,
 * track change, or a real disagreement with the audio).
 *
 * While the finger is down the gesture owns the bar; engine updates are
 * ignored, and exactly one seek is issued on release.
 *
 * The time labels are plain text refreshed when the displayed second changes.
 */
export const SeekBar: React.FC<SeekBarProps> = ({ onSeek, readOnly }) => {
  const { duration: trackDuration } = usePlayer();

  const [barWidth, setBarWidth] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [displayPosition, setDisplayPosition] = useState(0);
  // Whole seconds + duration for the labels; changes about once a second.
  const [labels, setLabels] = useState(() => ({
    sec: Math.floor(progressClock.now()),
    dur: progressClock.getDuration(),
  }));
  /** 0..1 progress, animated natively. */
  const ratio = useRef(new Animated.Value(0)).current;

  // Refs mirror state for use inside PanResponder, which is created once and
  // would otherwise close over stale values.
  const barWidthRef = useRef(0);
  const durationRef = useRef(0);
  const displayRef = useRef(0);
  const seekingRef = useRef(false);

  const safeDurationNow = () => {
    const d = progressClock.getDuration() || trackDuration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  barWidthRef.current = barWidth;
  durationRef.current = safeDurationNow();
  seekingRef.current = isSeeking;

  /** Aim the native animation at the current clock state. */
  const drive = useCallback(() => {
    if (seekingRef.current) return;
    const dur = durationRef.current || progressClock.getDuration() || trackDuration || 0;
    const pos = progressClock.now();
    ratio.stopAnimation();
    const now = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
    ratio.setValue(now);
    if (progressClock.isPlaying() && dur > 0 && pos < dur) {
      Animated.timing(ratio, {
        toValue: 1,
        duration: Math.max(0, (dur - pos) * 1000),
        easing: Easing.linear,
        useNativeDriver: true,
      }).start();
    }
  }, [ratio, trackDuration]);

  useEffect(() => {
    drive();
    const unsubscribe = progressClock.subscribe(() => {
      drive();
    });
    return () => {
      unsubscribe();
      ratio.stopAnimation();
    };
  }, [drive, ratio]);

  // When the finger lifts, resume following the clock.
  useEffect(() => {
    if (!isSeeking) drive();
  }, [isSeeking, drive]);

  // Labels: check a few times a second, re-render only when the second changes.
  useEffect(() => {
    const tick = () =>
      setLabels((prev) => {
        const sec = Math.floor(progressClock.now());
        const dur = progressClock.getDuration();
        return prev.sec === sec && prev.dur === dur ? prev : { sec, dur };
      });
    tick();
    const id = setInterval(tick, 200);
    const unsubscribe = progressClock.subscribe(tick);
    return () => {
      clearInterval(id);
      unsubscribe();
    };
  }, []);

  /** Map an x offset within the bar to a safe position in seconds. */
  const positionForX = useCallback((x: number): number => {
    const width = barWidthRef.current;
    const total = durationRef.current;

    if (!width || !total) return 0;
    if (!Number.isFinite(x)) return 0;

    const ratio = Math.min(1, Math.max(0, x / width));
    const seconds = ratio * total;

    // Guard against NaN/Infinity reaching the engine.
    if (!Number.isFinite(seconds)) return 0;
    return Math.min(total, Math.max(0, seconds));
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Claim the gesture so the parent ScrollView cannot steal the drag.
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: (e) => {
          // A track with no known duration cannot be scrubbed.
          if (!durationRef.current) return;

          const next = positionForX(e.nativeEvent.locationX);
          displayRef.current = next;
          seekingRef.current = true;
          ratio.stopAnimation();
          ratio.setValue(durationRef.current > 0 ? next / durationRef.current : 0);
          setDisplayPosition(next);
          setIsSeeking(true);
        },

        onPanResponderMove: (e) => {
          if (!durationRef.current) return;

          // locationX is measured against this view, so it already accounts for
          // how far the finger has travelled. positionForX clamps it, which is
          // what keeps dragging past either end (and fast flicks that overshoot)
          // pinned to 0 / duration rather than producing an out-of-range seek.
          const next = positionForX(e.nativeEvent.locationX);

          displayRef.current = next;
          ratio.setValue(durationRef.current > 0 ? next / durationRef.current : 0);
          setDisplayPosition(next);
        },

        onPanResponderRelease: () => {
          if (!durationRef.current) {
            setIsSeeking(false);
            return;
          }
          // One seek, at the end of the gesture.
          onSeek(displayRef.current);
          setIsSeeking(false);
        },

        onPanResponderTerminate: () => {
          // Gesture stolen or cancelled: drop back to engine position.
          setIsSeeking(false);
        },
      }),
    [onSeek, positionForX, ratio]
  );

  const safeDuration = labels.dur || trackDuration || 0;
  const shown = isSeeking ? displayPosition : labels.sec;
  const remaining = Math.max(0, safeDuration - shown);

  // Fill and thumb slide by translation (native-driver friendly; width is not).
  const fillX = ratio.interpolate({ inputRange: [0, 1], outputRange: [-barWidth, 0] });
  const dotX = ratio.interpolate({ inputRange: [0, 1], outputRange: [0, barWidth] });

  return (
    <View style={styles.container}>
      <View
        style={styles.barBg}
        hitSlop={{ top: 20, bottom: 20, left: 0, right: 0 }}
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
        {...(readOnly ? {} : panResponder.panHandlers)}
      >
        {/* The fill is clipped to the track; the thumb is not (it is taller than the track). */}
        <View style={styles.fillClip}>
          <Animated.View style={[styles.barFill, { transform: [{ translateX: fillX }] }]} />
        </View>
        {!readOnly && (
          <Animated.View
            style={[styles.dot, isSeeking && styles.dotActive, { transform: [{ translateX: dotX }] }]}
          />
        )}
      </View>

      <View style={styles.timeRow}>
        <Text style={styles.timeText}>{formatTime(shown)}</Text>
        <Text style={styles.timeText}>-{formatTime(remaining)}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: SIZES.lg,
  },
  barBg: {
    height: 4,
    backgroundColor: COLORS.player.progressTrack,
    borderRadius: 2,
    marginBottom: SIZES.sm,
    justifyContent: 'center',
  },
  fillClip: {
    ...StyleSheet.absoluteFill,
    borderRadius: 2,
    overflow: 'hidden',
  },
  barFill: {
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.player.progressFill, // accent red, per Aurix — was white
    borderRadius: 2,
  },
  dot: {
    position: 'absolute',
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.text.primary,
    marginLeft: -6,
  },
  /** Slight grow while dragging, so the thumb reads as grabbed. */
  dotActive: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    fontFamily: FONTS.regular,
    fontSize: 12,
    color: COLORS.text.secondary,
  },
});
