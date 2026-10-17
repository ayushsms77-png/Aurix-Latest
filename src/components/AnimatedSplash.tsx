import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Reanimated, {
  useAnimatedProps,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import {
  DOT0,
  DOT_R0,
  I_STEM_LEN,
  I_STEM_PTS,
  LAMBDA_PTS,
  LAMBDA_STROKE,
  R_ARM_LEN,
  R_ARM_PTS,
  R_STEM_LEN,
  R_STEM_PTS,
  T_END,
  U_LEN,
  U_PTS,
  W_I,
  W_R_ARM,
  W_R_STEM,
  W_U,
  X_SLIDE,
  X_SUBS,
  frameAt,
  pathD,
} from './splashGeometry';

/**
 * Second splash: shown right after the native splash, then fades into the app.
 *
 * Seamless hand-off (don't break this):
 *  - Frame 0 is the SAME picture as the native splash (assets/splash-icon.png):
 *    the Λ + red dot at the same size, dead centre, bottom edge 61dp below the
 *    screen centre. splashGeometry.ts uses the same maths, and the native splash
 *    is only hidden once this has drawn, so nothing jumps.
 *
 * Then, in one smooth ~1.9s move driven by a single clock:
 *    Λ slides left -> the red dot rolls down its right leg -> bounces onto the
 *    "u" and traces u, r (letters appear behind it) -> climbs the i and stops as
 *    its dot -> "x" slides in from the right.
 *
 * Why the clock is frame-driven (not a wall-clock timer):
 *  - The clock only advances by what was actually painted (at most MAX_STEP_MS
 *    per frame). If the phone stalls for a moment, the animation pauses with it
 *    instead of jumping ahead, so the Λ is always seen sliding and the letters
 *    are always seen being written.
 *  - `onIntroDone` fires when the LAST frame has really been drawn. App.tsx
 *    mounts the heavy app only then, so nothing competes with the animation;
 *    the hold below covers that mount.
 */

const OFF_WHITE = '#F2EFE9';
const RED = '#FF2D4A';

const HOLD_MS = 450; // how long the finished "Λurix" stays up (covers the app mounting)
const FADE_OUT_MS = 320;
const MAX_STEP_MS = 34; // clock never advances more than ~2 frames per painted frame

const STAGE_W = 420;
const STAGE_H = 220;

const AnimatedPath = Reanimated.createAnimatedComponent(Path);
const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);

// Static path strings for the letters (their reveal is animated, not their shape).
const U_D = pathD(U_PTS);
const R_STEM_D = pathD(R_STEM_PTS);
const R_ARM_D = pathD(R_ARM_PTS);
const I_STEM_D = pathD(I_STEM_PTS);

const r3 = (v: number) => {
  'worklet';
  return Math.round(v * 1000) / 1000;
};

/** The Λ, shifted `dx` dp to the left. */
function lambdaD(dx: number) {
  'worklet';
  let d = '';
  for (let i = 0; i < LAMBDA_PTS.length; i++) {
    d += (i === 0 ? 'M' : 'L') + r3(LAMBDA_PTS[i][0] + dx) + ' ' + r3(LAMBDA_PTS[i][1]);
  }
  return d + 'Z';
}

/** The "x" outline, shifted `off` dp to the right. */
function xD(off: number) {
  'worklet';
  let d = '';
  for (let s = 0; s < X_SUBS.length; s++) {
    for (let i = 0; i < X_SUBS[s].length; i++) {
      d += (i === 0 ? 'M' : 'L') + r3(X_SUBS[s][i][0] + off) + ' ' + r3(X_SUBS[s][i][1]);
    }
    d += 'Z';
  }
  return d;
}

/** Draw-on: show the first `shown` dp of a stroke whose full length is `len`. */
function drawOn(len: number, shown: number) {
  'worklet';
  return { strokeDashoffset: len + 2 - shown, strokeOpacity: shown > 0.01 ? 1 : 0 };
}

type Props = {
  /** True once the app underneath is mounted and ready to be revealed. */
  ready: boolean;
  /** Called once the overlay has fully faded out. */
  onFinish: () => void;
  /** Called when the logo has drawn, i.e. when it is safe to hide the native splash. */
  onLogoDrawn: () => void;
  /** Called when the intro animation has really finished playing (last frame drawn). */
  onIntroDone: () => void;
};

export const AnimatedSplash: React.FC<Props> = ({ ready, onFinish, onLogoDrawn, onIntroDone }) => {
  const overlay = useRef(new Animated.Value(1)).current;
  const [holdDone, setHoldDone] = useState(false);
  const started = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One clock (ms). Everything on screen is a pure function of it.
  const clock = useSharedValue(0);
  const running = useSharedValue(false);
  const finished = useSharedValue(false);
  const frame = useDerivedValue(() => frameAt(clock.value));

  // Runs on the JS thread once the last animation frame has been drawn.
  const introFinished = useCallback(() => {
    onIntroDone();
    holdTimer.current = setTimeout(() => setHoldDone(true), HOLD_MS);
  }, [onIntroDone]);

  // Frame-driven clock: advances by the time of each frame that is really painted.
  useFrameCallback((info) => {
    'worklet';
    if (!running.value || finished.value) return;
    const dt = Math.min(info.timeSincePreviousFrame ?? 16, MAX_STEP_MS);
    const next = clock.value + dt;
    if (next >= T_END) {
      clock.value = T_END;
      finished.value = true;
      scheduleOnRN(introFinished);
    } else {
      clock.value = next;
    }
  });

  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;
    onLogoDrawn();
    running.value = true;
  }, [onLogoDrawn, running]);

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  // Safety net: if the layout event never fires, still proceed.
  useEffect(() => {
    const t = setTimeout(start, 700);
    return () => clearTimeout(t);
  }, [start]);

  // Fade out only when the intro has played AND the app is ready.
  useEffect(() => {
    if (!holdDone || !ready) return;
    Animated.timing(overlay, {
      toValue: 0,
      duration: FADE_OUT_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start(() => onFinish());
  }, [holdDone, ready, overlay, onFinish]);

  const lambdaProps = useAnimatedProps(() => ({ d: lambdaD(frame.value.dx) }));
  const dotProps = useAnimatedProps(() => ({
    cx: frame.value.x,
    cy: frame.value.y,
    r: frame.value.r,
  }));
  const uProps = useAnimatedProps(() => drawOn(U_LEN, frame.value.u));
  const rStemProps = useAnimatedProps(() => drawOn(R_STEM_LEN, frame.value.rs));
  const rArmProps = useAnimatedProps(() => drawOn(R_ARM_LEN, frame.value.ra));
  const iProps = useAnimatedProps(() => drawOn(I_STEM_LEN, frame.value.is));
  const xProps = useAnimatedProps(() => ({
    d: xD(frame.value.xo),
    fillOpacity: frame.value.xa,
  }));

  return (
    <Animated.View style={[styles.overlay, { opacity: overlay }]}>
      <View pointerEvents="none" onLayout={() => start()}>
        <Svg
          width={STAGE_W}
          height={STAGE_H}
          viewBox={`${-STAGE_W / 2} ${-STAGE_H / 2} ${STAGE_W} ${STAGE_H}`}
        >
          {/* Λ */}
          <AnimatedPath
            d={lambdaD(0)}
            fill={OFF_WHITE}
            stroke={OFF_WHITE}
            strokeWidth={LAMBDA_STROKE}
            strokeLinejoin="round"
            animatedProps={lambdaProps}
          />

          {/* u, r, i: stroked centre-lines that are revealed as the dot passes */}
          <AnimatedPath
            d={U_D}
            fill="none"
            stroke={OFF_WHITE}
            strokeWidth={W_U}
            strokeLinejoin="round"
            strokeDasharray={[U_LEN + 2, U_LEN + 2]}
            strokeDashoffset={U_LEN + 2}
            strokeOpacity={0}
            animatedProps={uProps}
          />
          <AnimatedPath
            d={R_STEM_D}
            fill="none"
            stroke={OFF_WHITE}
            strokeWidth={W_R_STEM}
            strokeDasharray={[R_STEM_LEN + 2, R_STEM_LEN + 2]}
            strokeDashoffset={R_STEM_LEN + 2}
            strokeOpacity={0}
            animatedProps={rStemProps}
          />
          <AnimatedPath
            d={R_ARM_D}
            fill="none"
            stroke={OFF_WHITE}
            strokeWidth={W_R_ARM}
            strokeLinejoin="round"
            strokeDasharray={[R_ARM_LEN + 2, R_ARM_LEN + 2]}
            strokeDashoffset={R_ARM_LEN + 2}
            strokeOpacity={0}
            animatedProps={rArmProps}
          />
          <AnimatedPath
            d={I_STEM_D}
            fill="none"
            stroke={OFF_WHITE}
            strokeWidth={W_I}
            strokeDasharray={[I_STEM_LEN + 2, I_STEM_LEN + 2]}
            strokeDashoffset={I_STEM_LEN + 2}
            strokeOpacity={0}
            animatedProps={iProps}
          />

          {/* x slides in from the right */}
          <AnimatedPath d={xD(X_SLIDE)} fill={OFF_WHITE} fillOpacity={0} animatedProps={xProps} />

          {/* The red dot: rolls, writes, and ends as the i's dot. Drawn last (on top). */}
          <AnimatedCircle cx={DOT0[0]} cy={DOT0[1]} r={DOT_R0} fill={RED} animatedProps={dotProps} />
        </Svg>
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
});
