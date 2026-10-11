/**
 * Pure helpers for the Playing Next sheet's drag-to-reorder.
 *
 * Kept free of React Native imports so the maths can be tested on its own.
 */

/** Fixed row height so drag maths stays exact (48 art + 8 pad top/bottom). */
export const ROW_HEIGHT = 64;

/** How long a finger must rest on a row before it lifts and can be dragged. */
export const LONG_PRESS_MS = 280;

/** Finger travel (px) before the long-press is cancelled and it is a scroll. */
export const MOVE_CANCEL_PX = 10;

export const arrayMove = <T,>(list: T[], from: number, to: number): T[] => {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/**
 * Index the dragged row should occupy after the finger has travelled `dy`
 * (already including any carry from earlier swaps). Always inside the list.
 */
export const dragTarget = (length: number, from: number, dy: number, rowHeight = ROW_HEIGHT): number =>
  Math.min(length - 1, Math.max(0, from + Math.round(dy / rowHeight)));

/** True once the finger has moved far enough that this is a scroll, not a hold. */
export const exceedsSlop = (dx: number, dy: number, slop = MOVE_CANCEL_PX): boolean =>
  Math.hypot(dx, dy) > slop;

/** True when two id lists differ in length or order. */
export const orderChanged = (before: string[], after: string[]): boolean =>
  before.length !== after.length || before.some((id, i) => id !== after[i]);
