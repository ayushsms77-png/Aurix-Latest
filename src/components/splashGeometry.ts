/**
 * Geometry + timeline for the "Λurix" write-on splash.
 *
 * Everything here is plain numbers in dp, measured from the SCREEN CENTRE
 * (x to the right, y down). `frameAt(t)` is a pure function of time (ms) that
 * returns every moving value for that instant, so the whole animation is driven
 * by ONE clock (see AnimatedSplash.tsx) and can never drift out of sync.
 *
 * Functions marked 'worklet' run on the UI thread (Reanimated), so the
 * animation keeps playing smoothly even while the JS thread is busy booting.
 */

export type Pt = [number, number];

// ---------------------------------------------------------------------------
// 1. The logo, in the same place as assets/splash-icon.png on the native splash
// ---------------------------------------------------------------------------
// splash-icon.png is a 1024 master drawn at 288dp, with the Λ's bottom edge
// 61dp below the screen centre. Same maths here => identical first frame.
const K = (288 / 1024) * 0.774; // dp per master unit
const OY = 61 - (818 - 512) * K;
const mx = (x: number) => (x - 512) * K;
const my = (y: number) => (y - 512) * K + OY;

export const LAMBDA_PTS: Pt[] = (
  [[512, 220], [777, 810], [685, 810], [512, 425], [339, 810], [247, 810]] as Pt[]
).map(([x, y]): Pt => [mx(x), my(y)]);
export const LAMBDA_STROKE = 16 * K;
const LAMBDA_HALF = LAMBDA_STROKE / 2;

export const DOT0: Pt = [mx(692), my(289)];
export const DOT_R0 = 60 * K;

// ---------------------------------------------------------------------------
// 2. The lockup: Λ + "urix" (Outfit SemiBold), x-height 48dp
// ---------------------------------------------------------------------------
export const F = 48 / 23.18; // font units -> dp
const GAP = 12; // space between Λ and u
const LAMBDA_LEFT0 = mx(239);
const LAMBDA_W = 546 * K;
const LOCK_W = LAMBDA_W + GAP + (128.11 - 38.88) * F;
export const LAMBDA_DX = -LOCK_W / 2 - LAMBDA_LEFT0; // how far the Λ slides left
const TX = -LOCK_W / 2 + LAMBDA_W + GAP;
export const BASELINE = my(818); // = 61, the Λ's bottom edge

const gx = (fx: number) => TX + (fx - 38.88) * F;
const gy = (fy: number) => BASELINE + fy * F;
const toDp = (pts: Pt[]): Pt[] => pts.map(([x, y]): Pt => [gx(x), gy(y)]);

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Smooth curve through points (uniform Catmull-Rom), `per` samples per span. */
function smooth(p: Pt[], per: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

export function polyline(pts: Pt[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { xs: pts.map((p) => p[0]), ys: pts.map((p) => p[1]), cum, total: cum[cum.length - 1] };
}
export type Trace = ReturnType<typeof polyline>;

export const pathD = (pts: Pt[]) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join(' ');

// --- centre-lines of the letters, in font units (Outfit SemiBold) -----------
// u: down the left stem, round the bowl, up the right stem.
const U_FU: Pt[] = [[42.05, -23.18], [42.05, -10], ...arc(49.385, -10, 7.33, Math.PI, 0, 24), [56.715, -23.18]];
// r: stem top->bottom, then back up the stem to the arm, then out along the arm.
const R_STEM_FU: Pt[] = [[70.875, -23.18], [70.875, 0]];
const R_ARM_FU: Pt[] = smooth(
  [[71.0, -13.5], [71.9, -16.6], [73.6, -19.0], [76.0, -20.5], [78.8, -20.9], [81.2, -20.4], [83.5, -19.05]],
  8,
);
// i: stem bottom->top, the dot carries on 7.3 units above the stem and stays there.
const I_STEM_FU: Pt[] = [[94.61, 0], [94.61, -23.18]];
const I_DOT_FU: Pt = [94.61, -30.53];
const I_LEAD_FU = 3.6; // the dot starts one radius above the baseline

// Stroke geometry (dp). Stroked centre-lines match Outfit's monoline stems.
export const U_PTS = toDp(U_FU);
export const R_STEM_PTS = toDp(R_STEM_FU);
export const R_ARM_PTS = toDp(R_ARM_FU);
export const I_STEM_PTS = toDp(I_STEM_FU);
export const W_U = 6.32 * F;
export const W_R_STEM = 6.29 * F;
export const W_R_ARM = 5.9 * F;
export const W_I = 6.34 * F;

export const U_LEN = polyline(U_PTS).total;
export const R_STEM_LEN = polyline(R_STEM_PTS).total;
export const R_ARM_LEN = polyline(R_ARM_PTS).total;
export const I_STEM_LEN = polyline(I_STEM_PTS).total;

// The path the DOT follows while each letter is being revealed.
const TR_U = polyline(U_PTS);
const R_RETRACE = Math.hypot(0.125, 13.5) * F;
const TR_R = polyline(toDp([...R_STEM_FU, ...R_ARM_FU]));
const TR_I = polyline(toDp([[94.61, -I_LEAD_FU], I_DOT_FU]));
const I_LEAD = I_LEAD_FU * F;

export const DOT_R_FINAL = 3.6 * F; // = radius of the i's dot in Outfit
export const I_DOT_END: Pt = toDp([I_DOT_FU])[0];

// "x": real glyph outlines (it just slides in), converted to dp. Same winding
// for every contour so the overlapping strokes of the x union cleanly.
const X_FU: Pt[][] = [
  [[120.72, 0], [114.62, -9.41], [113.33, -10.37], [104.3, -23.18], [111.74, -23.18], [117.36, -14.69], [118.56, -13.78], [128.11, 0]],
  [[103.82, 0], [113.28, -13.25], [116.88, -8.98], [110.93, 0]],
  [[118.8, -10.42], [115.1, -14.64], [120.62, -23.18], [127.68, -23.18]],
];
function area(p: Pt[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}
export const X_SUBS: Pt[][] = X_FU.map((s) => {
  const d = toDp(s);
  return area(d) < 0 ? d.slice().reverse() : d;
});
export const X_SLIDE = 48; // dp the x travels in from the right

// ---------------------------------------------------------------------------
// 3. Timeline (ms). Tweak these to taste.
// ---------------------------------------------------------------------------
export const T = {
  slideStart: 100, // Λ starts sliding left
  slideEnd: 600,
  rollStart: 220, // dot lets go and rolls down the Λ's right leg
  rollEnd: 600, // ...and lands on the baseline
  hop1End: 760, // little bounce up to the start of the "u"
  uEnd: 1020, // dot traces the u
  hop2End: 1085,
  rEnd: 1380, // ...then the r
  hop3End: 1480,
  iEnd: 1660, // ...then climbs the i and stops as its dot
  xStart: 1560, // x slides in from the right, overlapping the end of the i
  xEnd: 1860,
};
export const T_END = T.xEnd;

// ---------------------------------------------------------------------------
// 4. Roll path (in the Λ's own frame, so it travels with the Λ while it slides)
// ---------------------------------------------------------------------------
const LEG_A = LAMBDA_PTS[0];
const LEG_B = LAMBDA_PTS[1];
const LEG_LEN = Math.hypot(LEG_B[0] - LEG_A[0], LEG_B[1] - LEG_A[1]);
const LEG_UX = (LEG_B[0] - LEG_A[0]) / LEG_LEN;
const LEG_UY = (LEG_B[1] - LEG_A[1]) / LEG_LEN;
const LEG_NX = LEG_UY; // outward normal (points right/up)
const LEG_NY = -LEG_UX;
const DOT0_S = (DOT0[0] - LEG_A[0]) * LEG_UX + (DOT0[1] - LEG_A[1]) * LEG_UY;
const DOT0_OFF = (DOT0[0] - LEG_A[0]) * LEG_NX + (DOT0[1] - LEG_A[1]) * LEG_NY;
const DOT0_EXTRA = DOT0_OFF - (LAMBDA_HALF + DOT_R0); // gap between dot and leg to start with
// distance along the leg where the ball's bottom touches the baseline
const ROLL_S_END =
  (BASELINE - DOT_R_FINAL - LEG_A[1] - LEG_NY * (LAMBDA_HALF + DOT_R_FINAL)) / LEG_UY;
const LAND: Pt = [
  LEG_A[0] + LEG_UX * ROLL_S_END + LEG_NX * (LAMBDA_HALF + DOT_R_FINAL) + LAMBDA_DX,
  LEG_A[1] + LEG_UY * ROLL_S_END + LEG_NY * (LAMBDA_HALF + DOT_R_FINAL),
];

// hop endpoints (dp)
const U_START: Pt = U_PTS[0];
const U_END: Pt = U_PTS[U_PTS.length - 1];
const R_START: Pt = R_STEM_PTS[0];
const R_END: Pt = R_ARM_PTS[R_ARM_PTS.length - 1];
const I_START: Pt = [TR_I.xs[0], TR_I.ys[0]];

// ---------------------------------------------------------------------------
// 5. Easing + helpers (worklets)
// ---------------------------------------------------------------------------
function clamp01(v: number) {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function seg(t: number, a: number, b: number) {
  'worklet';
  return clamp01((t - a) / (b - a));
}
function easeInOut(p: number) {
  'worklet';
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
function easeInOutSine(p: number) {
  'worklet';
  return -(Math.cos(Math.PI * p) - 1) / 2;
}
function easeOut(p: number) {
  'worklet';
  return 1 - Math.pow(1 - p, 3);
}
function along(tr: Trace, d: number): Pt {
  'worklet';
  const n = tr.cum.length;
  if (d <= 0) return [tr.xs[0], tr.ys[0]];
  if (d >= tr.total) return [tr.xs[n - 1], tr.ys[n - 1]];
  let i = 1;
  while (i < n - 1 && tr.cum[i] < d) i++;
  const a = tr.cum[i - 1];
  const f = (d - a) / (tr.cum[i] - a || 1);
  return [tr.xs[i - 1] + (tr.xs[i] - tr.xs[i - 1]) * f, tr.ys[i - 1] + (tr.ys[i] - tr.ys[i - 1]) * f];
}
function hop(p: number, a: Pt, b: Pt, h: number): Pt {
  'worklet';
  const e = easeInOutSine(p);
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e - 4 * h * e * (1 - e)];
}

export type Frame = {
  dx: number; // Λ translation
  x: number; // dot centre
  y: number;
  r: number; // dot radius
  u: number; // revealed length of each stroke
  rs: number;
  ra: number;
  is: number;
  xo: number; // x glyph: horizontal offset + opacity
  xa: number;
};

export function frameAt(t: number): Frame {
  'worklet';
  const dx = LAMBDA_DX * easeInOut(seg(t, T.slideStart, T.slideEnd));

  let x = 0, y = 0, r = DOT_R_FINAL;
  let u = 0, rs = 0, ra = 0, is = 0;

  if (t < T.rollStart) {
    x = DOT0[0] + dx;
    y = DOT0[1];
    r = DOT_R0;
  } else if (t < T.rollEnd) {
    // Ball drops onto the right leg, then rolls down it, speeding up.
    const p = seg(t, T.rollStart, T.rollEnd);
    const g = Math.pow(p, 1.7);
    r = DOT_R0 + (DOT_R_FINAL - DOT_R0) * easeInOut(p);
    const s = DOT0_S + (ROLL_S_END - DOT0_S) * g;
    const off = LAMBDA_HALF + r + DOT0_EXTRA * (1 - easeOut(seg(p, 0, 0.3)));
    x = LEG_A[0] + LEG_UX * s + LEG_NX * off + dx;
    y = LEG_A[1] + LEG_UY * s + LEG_NY * off;
  } else if (t < T.hop1End) {
    const q = hop(seg(t, T.rollEnd, T.hop1End), LAND, U_START, 14);
    x = q[0]; y = q[1];
  } else if (t < T.uEnd) {
    const d = easeInOutSine(seg(t, T.hop1End, T.uEnd)) * TR_U.total;
    const q = along(TR_U, d);
    x = q[0]; y = q[1]; u = d;
  } else if (t < T.hop2End) {
    const q = hop(seg(t, T.uEnd, T.hop2End), U_END, R_START, 7);
    x = q[0]; y = q[1];
  } else if (t < T.rEnd) {
    const d = easeInOutSine(seg(t, T.hop2End, T.rEnd)) * TR_R.total;
    const q = along(TR_R, d);
    x = q[0]; y = q[1];
    rs = Math.min(d, R_STEM_LEN);
    ra = clamp01((d - R_STEM_LEN - R_RETRACE) / R_ARM_LEN) * R_ARM_LEN;
  } else if (t < T.hop3End) {
    const q = hop(seg(t, T.rEnd, T.hop3End), R_END, I_START, 10);
    x = q[0]; y = q[1];
  } else if (t < T.iEnd) {
    const d = easeInOutSine(seg(t, T.hop3End, T.iEnd)) * TR_I.total;
    const q = along(TR_I, d);
    x = q[0]; y = q[1];
    is = Math.min(I_LEAD + d, I_STEM_LEN);
  } else {
    x = I_DOT_END[0]; y = I_DOT_END[1];
  }

  // Strokes that are finished stay finished.
  if (t >= T.uEnd) u = U_LEN;
  if (t >= T.rEnd) { rs = R_STEM_LEN; ra = R_ARM_LEN; }
  if (t >= T.iEnd) is = I_STEM_LEN;

  const xp = seg(t, T.xStart, T.xEnd);
  return {
    dx, x, y, r, u, rs, ra, is,
    xo: (1 - easeOut(xp)) * X_SLIDE,
    xa: easeOut(seg(t, T.xStart, T.xStart + (T.xEnd - T.xStart) * 0.7)),
  };
}
