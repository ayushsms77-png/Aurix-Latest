/**
 * The one hand-shake between Sync Play and the normal player.
 *
 * While a room is open, `active` is true and usePlayer.tsx stops doing the
 * things that would pull this device out of step with the others: it does not
 * auto-skip a song that failed, add "related" songs, advance on its own when a
 * song ends, queue a native "next" item, or save the queue. Next / Previous /
 * play-pause (from anywhere, lock screen included) are handed to the room.
 *
 * With `active === false` (the default) the player behaves exactly as before.
 */
export type SyncBridge = {
  active: boolean;
  onNext?: () => void;
  onPrevious?: () => void;
  onTogglePlay?: () => void;
  onTrackEnded?: () => void;
  onLoadFailed?: (message: string) => void;
};

export const syncBridge: SyncBridge = { active: false };
