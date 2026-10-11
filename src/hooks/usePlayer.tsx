import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { AppState, Platform, PermissionsAndroid } from 'react-native';
import { AppError, messageFor, toAppError } from '../core/errors';
import { RepeatMode, Track } from '../core/types';
import { flushWrites, readJson, writeJsonDebounced, STORAGE_KEYS } from '../core/storage';
import { progressClock } from '../playback/progressClock';
import { playbackEngine, IDLE_STATUS, PlaybackStatus } from '../playback/PlaybackEngine';
import { Queue, QueueSnapshot, EMPTY_QUEUE } from '../playback/queue';
import { preloader } from '../playback/preload';
import { endpointSource } from '../providers/stream/StreamResolver';
import { LibraryService } from '../services/LibraryService';
import { MusicService } from '../services/MusicService';
import { DownloadService } from '../services/DownloadService';
import { TasteService } from '../services/TasteService';
import { artistKey } from '../recommendation/identity';
import { pickFresh, songKey } from '../recommendation/mix';
// TEMP (crash bisection test): react-native-playback-controls suspected of a
// native crash. Commented out, not deleted -- re-enable by uncommenting this
// import and the block below once confirmed.
// import {
//   PlaybackControls,
//   useRemoteCommand,
//   type PlaybackSession,
// } from 'react-native-playback-controls';

type PlayerContextType = {
  // --- the original mock API, unchanged so existing screens keep working ---
  currentTrack: Track | null;
  isPlaying: boolean;
  playTrack: (track: Track, context?: { tracks?: Track[]; label?: string }) => void;
  togglePlayPause: () => void;
  // --- everything the real player adds ---
  isLoading: boolean;
  isBuffering: boolean;
  error: string | null;
  clearError: () => void;
  retry: () => void;
  duration: number;
  volume: number;
  setVolume: (v: number) => void;
  seekTo: (seconds: number) => void;
  /** Jump relative to the current position. Negative rewinds. */
  seekBy: (deltaSeconds: number) => void;
  next: () => void;
  previous: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
  queue: Track[];
  upcoming: Track[];
  queueContext: string;
  addToQueue: (tracks: Track | Track[]) => void;
  playNext: (tracks: Track | Track[]) => void;
  removeFromQueue: (trackId: string) => void;
  reorderQueue: (from: number, to: number) => void;
  /** Commit a new order (by track ids) for the upcoming portion of the queue. */
  reorderUpcoming: (ids: string[]) => void;
  clearQueue: () => void;
  jumpTo: (trackId: string) => void;
  shuffle: boolean;
  toggleShuffle: () => void;
  /** While shuffle is on: re-roll the upcoming order (updates the real queue). */
  reshuffle: () => void;
  repeat: RepeatMode;
  cycleRepeat: () => void;
  isReady: boolean;
  canPlayCurrent: boolean;
};

/**
 * How long a track must actually play before it counts as a listen.
 *
 * Tapping a track and skipping it immediately is not listening, so history is
 * gated on real playback rather than on intent. Short tracks use a proportion
 * instead, so a 30s clip is not excluded by a fixed threshold.
 */
const HISTORY_MIN_SECONDS = 20;
const HISTORY_MIN_RATIO = 0.25;

/**
 * Continuous playback: when this many tracks (or fewer) are left to play, a
 * few related tracks are fetched and added, so the queue never runs dry.
 */
const REFILL_AT = 3;
/** How many related tracks one refill adds. */
const REFILL_BATCH = 5;
/** Per-artist cap inside one refill, so a single artist cannot take over. */
const REFILL_MAX_PER_ARTIST = 2;
/** After a refill that found nothing, wait before trying again. */
const REFILL_RETRY_MS = 60_000;
/** Minimum gap between refills, so a trickle of results cannot loop fast. */
const REFILL_GAP_MS = 3_000;
/**
 * Tracks the app queued itself (not picked by the user) count for this much
 * of a normal listen/complete in taste scoring. Skips always count in full.
 */
const AUTOPLAY_TASTE_WEIGHT = 0.5;

/** How many unplayable tracks in a row we step over before giving up. */
const MAX_AUTO_SKIPS = 3;

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export const PlayerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const queueRef = useRef(new Queue());
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>(IDLE_STATUS);

  /**
   * Mirror of `status` for callbacks that only READ it.
   *
   * Position ticks ~4x a second. A callback that lists status.position in its
   * deps is rebuilt just as often, and because these callbacks sit in the
   * context value, that rebuilt the whole value 4x a second -- re-rendering
   * every screen using usePlayer and undoing the progress isolation.
   */
  const statusRef = useRef<PlaybackStatus>(IDLE_STATUS);
  statusRef.current = status;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [queueVersion, setQueueVersion] = useState(0);
  const [volume, setVolumeState] = useState(1);

  /** Cancels an in-flight load when the user starts another one. */
  const loadAbort = useRef<AbortController | null>(null);
  /** Identifies the newest load so stale async work can bail out. */
  const loadId = useRef(0);
  /** The track we most recently attempted, for retry(). */
  const lastAttempt = useRef<{ track: Track; position: number } | null>(null);
  /** Which track the in-flight load belongs to, so we never abort our own. */
  const loadingTrackId = useRef<string | null>(null);
  /**
   * Consecutive tracks auto-skipped because they would not play. Bounded so a
   * queue full of dead videos stops instead of racing to the end.
   */
  const autoSkips = useRef(0);
  /** Load id whose listen has already been written to history. */
  /** Track id a listen has already been logged for — NOT the load id: a
   * same-track reload (double-tap on the currently playing row, re-selecting
   * it from the queue) must not reopen the history-logging window, or the
   * position-threshold effect below fires again and writes a duplicate entry
   * for a listen that never actually restarted. */
  const historyWrittenFor = useRef<string | null>(null);

  /** Identifies the newest "sync the native next slot" request so stale async work bails. */
  const nextSlotToken = useRef(0);

  /** Bumped whenever a brand-new queue replaces the old one, so a slow refill for the old queue is dropped. */
  const queueEpoch = useRef(0);
  const refillInFlight = useRef(false);
  const refillBlockedUntil = useRef(0);
  const extendRef = useRef<(() => Promise<boolean>) | null>(null);
  /** Set when the user clears the queue: no refill for that track, they asked for it empty. */
  const refillSkipTrackId = useRef<string | null>(null);
  /** Ids the app added on its own (refill / end-of-queue related). */
  const autoAddedIds = useRef(new Set<string>());
  const tasteWeightOf = (track: Track) =>
    autoAddedIds.current.has(track.id) ? AUTOPLAY_TASTE_WEIGHT : 1;

  const bumpQueue = useCallback(() => setQueueVersion((v) => v + 1), []);

  // ---- persistence ------------------------------------------------------

  const persistQueue = useCallback(() => {
    writeJsonDebounced(STORAGE_KEYS.queue, queueRef.current.snapshot(), 600);
  }, []);

  // ---- loading a track --------------------------------------------------

  /**
   * Make the native player's queue agree with the JS queue about what plays
   * NEXT.
   *
   * RNTP keeps a real "next" item (so the lock-screen Next button works) and
   * will auto-advance into it when the track ends. If the JS queue changes
   * (shuffle, reshuffle, reorder, play next, remove, clear...) and that item
   * is not updated, the OLD next track still plays -- the queue "changed" in
   * the UI only. So every queue mutation ends here.
   *
   * - Already-queued next item is correct -> nothing to do (no churn).
   * - It is wrong -> removed immediately (so it can never be auto-played),
   *   then the right one is queued as soon as its stream resolves. If the
   *   track ends inside that window RNTP reports "nothing left" and the normal
   *   onComplete path advances using the JS queue.
   */
  const syncNextSlot = useCallback(() => {
    const q = queueRef.current;
    const current = q.current;
    const upcoming = q.peekNext();
    const token = ++nextSlotToken.current;
    preloader.schedule(upcoming);

    // Only attach a next item to a track that is really loaded in the engine.
    if (!current || playbackEngine.trackId !== current.id) return;

    // A one-track loop has no separate next item to queue.
    if (!upcoming || upcoming.id === current.id) {
      playbackEngine.clearQueuedNext();
      return;
    }
    if (playbackEngine.getQueuedNextId() === upcoming.id) return;
    playbackEngine.clearQueuedNext();

    MusicService.resolveStream(upcoming)
      .then((nextStream) => {
        // Drop the result if anything moved on while it was resolving.
        if (token !== nextSlotToken.current) return;
        if (queueRef.current.peekNext()?.id !== upcoming.id) return;
        if (playbackEngine.trackId !== current.id) return;
        playbackEngine.queueNext(upcoming, nextStream);
      })
      .catch(() => {
        // Best-effort — the OS button simply stays as it was.
      });
  }, []);

  /**
   * Bookkeeping for "this track is now genuinely the one playing" — called
   * both after a fresh load() succeeds AND when RNTP's own queue moves on by
   * itself (see the onActiveTrackChanged listener below). Does NOT touch
   * playback itself; in the second case audio is already correctly playing,
   * this only catches the app's own state up to match reality.
   */
  const onTrackNowPlaying = useCallback(
    (track: Track) => {
      setCurrentTrack(track);
      setIsLoading(false);
      setError(null);
      autoSkips.current = 0;
      loadingTrackId.current = null;
      // A track genuinely different from whatever history was last written
      // for gets a fresh listen-tracking window; a same-track re-arrival
      // (e.g. repeat-one) must not reopen it and log a duplicate.
      if (historyWrittenFor.current !== track.id) historyWrittenFor.current = null;
      LibraryService.recordPlay(track);

      // Warm one track ahead and put it in RNTP's real queue (lock-screen
      // Next, gapless continue). See syncNextSlot.
      syncNextSlot();
    },
    [syncNextSlot]
  );

  const loadCurrent = useCallback(
    async (options: { autoPlay?: boolean; startPosition?: number } = {}) => {
      const track = queueRef.current.current;
      if (!track) {
        setCurrentTrack(null);
        setIsLoading(false);
        playbackEngine.stop();
        return;
      }

      const id = ++loadId.current;
      // Only abort the previous load -- and only reopen the history-logging
      // window -- if this is genuinely a DIFFERENT track. A same-track reload
      // (double-tap on the playing row, re-picking it from the queue) joins
      // the existing in-flight resolve and must not look like a fresh listen.
      if (loadingTrackId.current !== track.id) {
        loadAbort.current?.abort();
        historyWrittenFor.current = null;
      }
      const controller = new AbortController();
      loadAbort.current = controller;
      loadingTrackId.current = track.id;

      const preloadedThis = preloader.pending === track.id;

      // Stop warming anything that is no longer next -- but if we were warming
      // THIS track, adopt that request instead of aborting it: resolveStream
      // below will be handed the very same in-flight promise.
      preloader.adopt(track.id);

      if (__DEV__) {
        console.log('[playback] load', track.title, '| preloaded:', preloadedThis);
      }

      setCurrentTrack(track);
      setError(null);
      setIsLoading(true);
      lastAttempt.current = { track, position: options.startPosition ?? 0 };

      try {
        const stream = await MusicService.resolveStream(track, controller.signal);
        if (id !== loadId.current) return; // superseded by a newer load
        await playbackEngine.load(track, stream, options);
        if (id !== loadId.current) return;
        playbackEngine.setRepeatOne(queueRef.current.repeat === 'one');

        if (__DEV__) console.log('[playback] started', track.title);
        onTrackNowPlaying(track);
      } catch (e) {
        if (id !== loadId.current) return;
        // Always leave the loading state, whatever went wrong.
        setIsLoading(false);
        loadingTrackId.current = null;

        const err = toAppError(e, 'playback_failed');
        if (__DEV__) console.log('[playback] FAILED', track.title, '|', err.kind, '|', err.detail ?? '');

        // A dead stream URL should not be reused on retry.
        if (err.kind !== 'network' && err.kind !== 'timeout') {
          MusicService.invalidateStream(track);
        }

        // A track that simply cannot play should not strand the queue: step
        // over it and keep going. Network failures are NOT skipped -- the
        // next track would fail identically, so the error is shown instead.
        const skippable =
          err.kind === 'track_unavailable' ||
          err.kind === 'region_restricted' ||
          err.kind === 'source_unavailable';
        if (skippable && autoSkips.current < MAX_AUTO_SKIPS && queueRef.current.hasNext) {
          autoSkips.current += 1;
          if (__DEV__) console.log('[playback] auto-skip', autoSkips.current, 'past', track.title);
          queueRef.current.next(false);
          bumpQueue();
          persistQueue();
          void loadCurrent({ autoPlay: true });
          return;
        }

        // Nothing after the broken track: fetch more music and move on to
        // that instead of stopping dead on an error.
        if (skippable && autoSkips.current < MAX_AUTO_SKIPS && !queueRef.current.hasNext) {
          autoSkips.current += 1;
          const message = messageFor(err);
          void (extendRef.current?.() ?? Promise.resolve(false)).then((ok) => {
            if (ok) return;
            if (id !== loadId.current) return;
            autoSkips.current = 0;
            setError(message);
          });
          return;
        }

        autoSkips.current = 0;
        setError(messageFor(err));
      }
    },
    [bumpQueue, onTrackNowPlaying, persistQueue]
  );

  // ---- engine wiring ----------------------------------------------------

  useEffect(() => {
    playbackEngine.on('onStatus', (s) => setStatus(s));
    playbackEngine.on('onComplete', () => {
      // Capture before advancing -- queueRef.current.current is about to
      // point at whatever plays next.
      const finishedTrack = queueRef.current.current;
      if (finishedTrack) TasteService.recordComplete(finishedTrack, tasteWeightOf(finishedTrack));

      // `auto` so repeat-one replays rather than advances.
      const nextTrack = queueRef.current.next(true);
      bumpQueue();
      persistQueue();
      if (!nextTrack) {
        // End of queue: optionally keep going with related tracks.
        void extendWithRelated();
        return;
      }
      void loadCurrent({ autoPlay: true });
    });
    playbackEngine.on('onError', (e) => {
      setIsLoading(false);
      setError(messageFor(e instanceof AppError ? e : toAppError(e, 'playback_failed')));
    });
    // Lock screen / notification / Bluetooth skip-next and skip-previous
    // reach here via react-native-track-player — see PlaybackEngine.ts.
    playbackEngine.on('onRemoteNext', () => next());
    playbackEngine.on('onRemotePrevious', () => previous());
    // PATCH: the real fix for "notification/audio show the new song but the
    // app still shows the old one." Once queueNext() has put a real track
    // after the current one, RNTP can move on to it by itself — this is how
    // the app finds out and catches its own state up, WITHOUT calling
    // playbackEngine.load() again (audio is already correctly playing).
    playbackEngine.on('onActiveTrackChanged', (mediaId, { endedNaturally }) => {
      const q = queueRef.current;
      const expected = q.current;

      // Same track (e.g. the native repeat-one loop): nothing changed.
      if (expected && expected.id === mediaId) return;

      // Safety net for repeat-one. The native player loops the item itself,
      // so a track ending should never land on a different one. If it did
      // (repeat-one was switched on at the very moment the track ended),
      // put the repeating track back rather than following the drift.
      // A user-pressed Next also arrives here, but that is never at the very
      // end of the track, so it is followed normally below.
      if (q.repeat === 'one' && expected && endedNaturally) {
        void loadCurrent({ autoPlay: true });
        return;
      }

      // The track that just stopped being active — same skip-vs-complete
      // distinction next()/previous() already use elsewhere.
      if (expected) {
        if (historyWrittenFor.current === expected.id) {
          TasteService.recordComplete(expected, tasteWeightOf(expected));
        } else {
          TasteService.recordSkip(expected);
        }
      }

      // The native player is the ground truth for what is actually playing:
      // move the JS queue to it. Normally it is the pre-queued peekNext();
      // jumpTo covers a queue that changed shape after that item was queued.
      // (next(false), not next(true): repeat-one must not veto a move the
      // native player has already made.)
      const landed =
        q.peekNext()?.id === mediaId ? q.next(false) : q.jumpTo(mediaId);

      bumpQueue();
      persistQueue();
      if (landed) {
        onTrackNowPlaying(landed);
      } else {
        // Native is playing something the JS queue does not contain (it was
        // removed while pre-queued): bring the engine back to the JS truth.
        void loadCurrent({ autoPlay: true });
      }
    });
    return () => {
      preloader.cancel();
      void playbackEngine.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Safety net for the very end of the queue: if nothing is left to play and
   * the refill below has not caught up, fetch related tracks and continue.
   */
  const extendWithRelated = useCallback(async (): Promise<boolean> => {
    const settings = LibraryService.getSettings();
    const last = queueRef.current.current;
    if (!settings.autoplayRelated || !last) return false;
    const epoch = queueEpoch.current;
    try {
      const related = await MusicService.getRelated(last);
      if (epoch !== queueEpoch.current) return false; // a new queue started meanwhile
      const items = queueRef.current.items;
      const fresh = pickFresh(related, {
        existingIds: new Set(items.map((t) => t.id)),
        existingSongKeys: new Set(items.map(songKey)),
        tailArtistKey: artistKey(last.artist),
        limit: 20,
        maxPerArtist: REFILL_MAX_PER_ARTIST * 3,
      });
      if (!fresh.length) return false;
      queueRef.current.add(fresh);
      fresh.forEach((t) => autoAddedIds.current.add(t.id));
      const nextTrack = queueRef.current.next(false);
      bumpQueue();
      persistQueue();
      if (nextTrack) void loadCurrent({ autoPlay: true });
      return !!nextTrack;
    } catch {
      // Autoplay is a convenience; silence is the right failure mode.
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  extendRef.current = extendWithRelated;

  /**
   * Continuous playback. When REFILL_AT or fewer tracks are left, fetch the
   * related tracks of the queue's last track and append a few good ones (no
   * repeats, no non-music, capped per artist). Runs well before the last song
   * ends, so playback never has to stop and wait.
   *
   * Only for a plain queue (repeat off); repeat modes loop what is there. One
   * request at a time, rate limited, and dropped if a new queue replaced this
   * one while it was in flight.
   */
  const refillQueue = useCallback(async () => {
    if (refillInFlight.current) return;
    if (Date.now() < refillBlockedUntil.current) return;
    if (!LibraryService.getSettings().autoplayRelated) return;

    const q = queueRef.current;
    const current = q.current;
    if (!current || q.repeat !== 'off') return;
    if (refillSkipTrackId.current === current.id) return;
    refillSkipTrackId.current = null;

    const upcoming = q.upcoming;
    if (upcoming.length > REFILL_AT) return;

    const tail = upcoming[upcoming.length - 1] ?? current;
    const epoch = queueEpoch.current;
    refillInFlight.current = true;
    try {
      const related = await MusicService.getRelated(tail);
      if (epoch !== queueEpoch.current) return; // a different queue started meanwhile

      const items = queueRef.current.items;
      const fresh = pickFresh(related, {
        existingIds: new Set(items.map((t) => t.id)),
        existingSongKeys: new Set(items.map(songKey)),
        tailArtistKey: artistKey(tail.artist),
        limit: REFILL_BATCH,
        maxPerArtist: REFILL_MAX_PER_ARTIST,
      });
      if (__DEV__) {
        console.log('[refill]', tail.title, '| related:', related.length, '| fresh:', fresh.length);
      }
      if (!fresh.length) {
        refillBlockedUntil.current = Date.now() + REFILL_RETRY_MS;
        return;
      }

      queueRef.current.add(fresh);
      fresh.forEach((t) => autoAddedIds.current.add(t.id));
      refillBlockedUntil.current = Date.now() + REFILL_GAP_MS;
      bumpQueue();
      persistQueue();
      syncNextSlot();
    } catch {
      refillBlockedUntil.current = Date.now() + REFILL_RETRY_MS;
    } finally {
      refillInFlight.current = false;
    }
  }, [bumpQueue, persistQueue, syncNextSlot]);

  // Check whether the queue needs topping up whenever it changes or playback
  // starts. The short delay keeps rapid skipping from firing a request per tap.
  useEffect(() => {
    // While a track is loading it is not "playing" yet, but the queue should
    // already be topped up.
    if (!status.isPlaying && !isLoading) return;
    const t = setTimeout(() => {
      void refillQueue();
    }, 600);
    return () => clearTimeout(t);
  }, [queueVersion, currentTrack?.id, status.isPlaying, isLoading, refillQueue]);

  // ---- startup: restore library, settings, queue and position -----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await Promise.all([
          MusicService.init(),
          LibraryService.load(),
          DownloadService.load(),
          TasteService.load(),
        ]);
        if (cancelled) return;

        const settings = LibraryService.getSettings();
        endpointSource.setEndpoints(settings.resolverEndpoints);
        playbackEngine.setVolume(settings.volume);
        setVolumeState(settings.volume);
        void playbackEngine.configure();

        const snapshot = await readJson<QueueSnapshot>(STORAGE_KEYS.queue, EMPTY_QUEUE);
        if (cancelled) return;
        if (snapshot.tracks?.length) {
          queueRef.current.restore(snapshot);
          playbackEngine.setRepeatOne(queueRef.current.repeat === 'one');
          bumpQueue();
          const restored = queueRef.current.current;
          if (restored) {
            // Restore the track and its position, but never auto-play on
            // launch -- starting audio unprompted is hostile.
            const saved = await LibraryService.getSavedPlayback();
            if (cancelled) return;
            setCurrentTrack(restored);
            lastAttempt.current = {
              track: restored,
              position: saved.trackId === restored.id ? saved.position : 0,
            };
          }
        }
      } catch {
        // A corrupt restore must never prevent the app from starting.
      } finally {
        if (!cancelled) setIsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- ask for notification permission (Android 13+) --------------------
  // Without this, the lock-screen/notification media widget (artwork,
  // play/pause, next/prev, progress bar) never renders for the user at all —
  // playback still works, but silently with no controls visible. This was
  // previously written but left commented out inside the now-disabled
  // react-native-playback-controls block below; pulled out on its own here
  // since it has nothing to do with that library or its crash.
  useEffect(() => {
    if (Platform.OS !== 'android' || Platform.Version < 33) return;
    PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    ).catch(() => undefined);
  }, []);

  // ---- persist playback position ---------------------------------------
  // `status.position` now updates about once a second (native progress
  // events); it is persisted in whole seconds, so only react when the second
  // actually changes. The UI itself reads position from the local clock.
  const positionSecond = Math.floor(status.position);
  useEffect(() => {
    if (!currentTrack) return;
    LibraryService.savePlayback(currentTrack.id, positionSecond);
    // A listen is logged once, mid-playback, not on tap and not on finish --
    // so skipping away early leaves no trace, and a track abandoned near the
    // end still counts.
    if (historyWrittenFor.current === currentTrack.id) return;
    const trackDuration = status.duration || currentTrack.duration || 0;
    const threshold = Math.min(
      HISTORY_MIN_SECONDS,
      trackDuration > 0 ? trackDuration * HISTORY_MIN_RATIO : HISTORY_MIN_SECONDS
    );
    if (positionSecond >= threshold && positionSecond > 0) {
      historyWrittenFor.current = currentTrack.id;
      LibraryService.recordListen(currentTrack);
      TasteService.recordListen(currentTrack, tasteWeightOf(currentTrack));
      if (__DEV__) console.log('[history] logged', currentTrack.title);
    }
  }, [currentTrack, positionSecond, status.duration]);

  // Flush pending writes when the app goes to the background or the tab closes.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || 'inactive' === state) void flushWrites();
    });
    let onHide: (() => void) | undefined;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      onHide = () => void flushWrites();
      window.addEventListener('pagehide', onHide);
    }
    return () => {
      sub.remove();
      if (onHide && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onHide);
      }
    };
  }, []);

  // ---- actions ----------------------------------------------------------

  const playTrack = useCallback(
    (track: Track, context?: { tracks?: Track[]; label?: string }) => {
      const list = context?.tracks?.length ? context.tracks : [track];
      const startIndex = Math.max(
        0,
        list.findIndex((t) => t.id === track.id)
      );
      // A brand-new queue: drop any refill still running for the old one and
      // forget which tracks the app had added there.
      queueEpoch.current += 1;
      autoAddedIds.current.clear();
      refillSkipTrackId.current = null;
      refillBlockedUntil.current = 0;
      queueRef.current.setTracks(list, startIndex, context?.label ?? '');
      bumpQueue();
      persistQueue();
      void loadCurrent({ autoPlay: true });
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const togglePlayPause = useCallback(() => {
    const track = queueRef.current.current ?? currentTrack;
    if (!track) return;
    // Restored-but-never-loaded track: the first press starts it.
    if (playbackEngine.trackId !== track.id) {
      if (!queueRef.current.current) {
        queueEpoch.current += 1;
        autoAddedIds.current.clear();
        queueRef.current.setTracks([track], 0, '');
        bumpQueue();
      }
      void loadCurrent({
        autoPlay: true,
        startPosition: lastAttempt.current?.position ?? 0,
      });
      return;
    }
    if (status.isPlaying) playbackEngine.pause();
    else playbackEngine.play();
  }, [bumpQueue, currentTrack, loadCurrent, status.isPlaying]);

  const next = useCallback(() => {
    // A track left before it counted as a genuine listen (see the history
    // effect above) was passed on, not finished -- a real taste signal.
    const leavingTrack = queueRef.current.current;
    if (leavingTrack && historyWrittenFor.current !== leavingTrack.id) {
      TasteService.recordSkip(leavingTrack);
    }

    const nextTrack = queueRef.current.next(false);
    bumpQueue();
    persistQueue();
    if (!nextTrack) {
      void extendWithRelated();
      return;
    }
    void loadCurrent({ autoPlay: true });
  }, [bumpQueue, extendWithRelated, loadCurrent, persistQueue]);

  const previous = useCallback(() => {
    // Standard behaviour: restart the track if we are more than 3s in.
    if (playbackEngine.getPosition() > 3) {
      void playbackEngine.seekTo(0);
      return;
    }
    const leavingTrack = queueRef.current.current;
    if (leavingTrack && historyWrittenFor.current !== leavingTrack.id) {
      TasteService.recordSkip(leavingTrack);
    }
    queueRef.current.previous();
    bumpQueue();
    persistQueue();
    void loadCurrent({ autoPlay: true });
  }, [bumpQueue, loadCurrent, persistQueue]);

  const seekTo = useCallback((seconds: number) => {
    void playbackEngine.seekTo(seconds);
  }, []);

  /**
   * Relative seek, matching the +/-10s the lock screen offers.
   * Clamped to the track so it cannot run past either end.
   */
  const seekBy = useCallback(
    (deltaSeconds: number) => {
      const { duration } = statusRef.current;
      const position = playbackEngine.getPosition();
      const total = duration || currentTrack?.duration || 0;
      const target = position + deltaSeconds;
      const clamped = total > 0 ? Math.min(total, Math.max(0, target)) : Math.max(0, target);
      void playbackEngine.seekTo(clamped);
    },
    [currentTrack?.duration]
  );

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    playbackEngine.setVolume(clamped);
    setVolumeState(clamped);
    LibraryService.updateSettings({ volume: clamped });
  }, []);

  const retry = useCallback(() => {
    const attempt = lastAttempt.current;
    if (!attempt) return;
    setError(null);
    MusicService.invalidateStream(attempt.track);
    void loadCurrent({ autoPlay: true, startPosition: attempt.position });
  }, [loadCurrent]);

  const clearError = useCallback(() => setError(null), []);

  // ---- queue operations -------------------------------------------------

  const addToQueue = useCallback(
    (tracks: Track | Track[]) => {
      const wasEmpty = queueRef.current.length === 0;
      queueRef.current.add(tracks);
      bumpQueue();
      persistQueue();
      if (wasEmpty) void loadCurrent({ autoPlay: true });
      else syncNextSlot();
    },
    [bumpQueue, loadCurrent, persistQueue, syncNextSlot]
  );

  const playNextInQueue = useCallback(
    (tracks: Track | Track[]) => {
      const wasEmpty = queueRef.current.length === 0;
      queueRef.current.playNext(tracks);
      bumpQueue();
      persistQueue();
      if (wasEmpty) void loadCurrent({ autoPlay: true });
      else syncNextSlot();
    },
    [bumpQueue, loadCurrent, persistQueue, syncNextSlot]
  );

  const removeFromQueue = useCallback(
    (trackId: string) => {
      const removedCurrent = queueRef.current.remove(trackId);
      bumpQueue();
      persistQueue();
      // Removing the playing track slides the next one into its place.
      if (removedCurrent) {
        if (queueRef.current.current) void loadCurrent({ autoPlay: true });
        else {
          playbackEngine.stop();
          setCurrentTrack(null);
        }
      } else {
        syncNextSlot();
      }
    },
    [bumpQueue, loadCurrent, persistQueue, syncNextSlot]
  );

  const reorderQueue = useCallback(
    (from: number, to: number) => {
      queueRef.current.reorder(from, to);
      bumpQueue();
      persistQueue();
      syncNextSlot();
    },
    [bumpQueue, persistQueue, syncNextSlot]
  );

  /** Commit the drag-to-reorder sheet's new upcoming order (by track ids). */
  const reorderUpcoming = useCallback(
    (ids: string[]) => {
      queueRef.current.reorderUpcoming(ids);
      bumpQueue();
      persistQueue();
      syncNextSlot();
    },
    [bumpQueue, persistQueue, syncNextSlot]
  );

  const clearQueue = useCallback(() => {
    // They asked for an empty queue: do not refill it behind their back for
    // this track (the end-of-queue autoplay still applies when it finishes).
    refillSkipTrackId.current = queueRef.current.current?.id ?? null;
    queueRef.current.clearUpcoming();
    bumpQueue();
    persistQueue();
    syncNextSlot();
  }, [bumpQueue, persistQueue, syncNextSlot]);

  const jumpTo = useCallback(
    (trackId: string) => {
      const track = queueRef.current.jumpTo(trackId);
      if (!track) return;
      // Picking it from the queue is a choice, so it counts like one.
      autoAddedIds.current.delete(trackId);
      bumpQueue();
      persistQueue();
      void loadCurrent({ autoPlay: true });
    },
    [bumpQueue, loadCurrent, persistQueue]
  );

  const toggleShuffle = useCallback(() => {
    queueRef.current.toggleShuffle();
    bumpQueue();
    persistQueue();
    // The order of what plays next just changed: update the real queue.
    syncNextSlot();
  }, [bumpQueue, persistQueue, syncNextSlot]);

  const reshuffle = useCallback(() => {
    if (!queueRef.current.reshuffle()) return;
    bumpQueue();
    persistQueue();
    syncNextSlot();
  }, [bumpQueue, persistQueue, syncNextSlot]);

  const cycleRepeat = useCallback(() => {
    const mode = queueRef.current.cycleRepeat();
    // Repeat-one is enforced by the native player, not just remembered in JS.
    playbackEngine.setRepeatOne(mode === 'one');
    bumpQueue();
    persistQueue();
    // What counts as "next" at the end of the queue depends on the mode.
    syncNextSlot();
  }, [bumpQueue, persistQueue, syncNextSlot]);

  // ---- context values ---------------------------------------------------

  const queueSnapshot = useMemo(
    () => ({
      items: queueRef.current.items,
      upcoming: queueRef.current.upcoming,
      context: queueRef.current.context,
      shuffle: queueRef.current.shuffle,
      repeat: queueRef.current.repeat,
      hasNext: queueRef.current.hasNext,
      hasPrevious: queueRef.current.hasPrevious,
    }),
    // queueVersion is the explicit invalidation signal for the mutable Queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queueVersion]
  );

  // Prefer the source-reported duration, falling back to provider metadata
  // so the scrubber is usable before the stream reports one.
  const duration = status.duration || currentTrack?.duration || 0;

  // TEMP (crash bisection test): entire media-session block disabled -- see
  // the commented-out import above. Re-enable both together once the crash
  // is confirmed to be (or not be) this library.
  //
  // const [mediaSession, setMediaSession] = useState<PlaybackSession | null>(null);
  //
  // useEffect(() => {
  //   if (Platform.OS !== 'android') return;
  //   let cancelled = false;
  //   let activeSession: PlaybackSession | null = null;
  //
  //   (async () => {
  //     if (Platform.Version >= 33) {
  //       await PermissionsAndroid.request(
  //         PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
  //       ).catch(() => undefined);
  //     }
  //     try {
  //       const session = await PlaybackControls.startSession({
  //         commands: ['play', 'pause', 'toggle-play-pause', 'next-track', 'previous-track'],
  //       });
  //       if (cancelled) {
  //         void session.end();
  //         return;
  //       }
  //       activeSession = session;
  //       setMediaSession(session);
  //     } catch {
  //     }
  //   })();
  //
  //   return () => {
  //     cancelled = true;
  //     void activeSession?.end();
  //     setMediaSession(null);
  //   };
  // }, []);
  //
  // useEffect(() => {
  //   if (!mediaSession || mediaSession.isEnded) return;
  //   if (!currentTrack) return;
  //   mediaSession.setNowPlaying({
  //     title: currentTrack.title,
  //     artist: currentTrack.artist?.name,
  //     artwork: currentTrack.albumImageUrl || undefined,
  //     durationSec: currentTrack.duration || undefined,
  //   });
  // }, [mediaSession, currentTrack]);
  //
  // useEffect(() => {
  //   if (!mediaSession || mediaSession.isEnded) return;
  //   mediaSession.setPlaybackState({
  //     status: status.isBuffering ? 'buffering' : status.isPlaying ? 'playing' : 'paused',
  //     positionSec: statusRef.current.position,
  //   });
  // }, [mediaSession, status.isPlaying, status.isBuffering]);
  //
  // useRemoteCommand(mediaSession, 'play', () => {
  //   if (!statusRef.current.isPlaying) togglePlayPause();
  // });
  // useRemoteCommand(mediaSession, 'pause', () => {
  //   if (statusRef.current.isPlaying) togglePlayPause();
  // });
  // useRemoteCommand(mediaSession, 'toggle-play-pause', togglePlayPause);
  // useRemoteCommand(mediaSession, 'next-track', next);
  // useRemoteCommand(mediaSession, 'previous-track', previous);
  // ------------------------------------------------------------------------

  const value = useMemo<PlayerContextType>(
    () => ({
      currentTrack,
      isPlaying: status.isPlaying,
      playTrack,
      togglePlayPause,
      isLoading,
      isBuffering: status.isBuffering,
      error,
      clearError,
      retry,
      duration,
      volume,
      setVolume,
      seekTo,
      seekBy,
      next,
      previous,
      hasNext: queueSnapshot.hasNext,
      hasPrevious: queueSnapshot.hasPrevious,
      queue: queueSnapshot.items,
      upcoming: queueSnapshot.upcoming,
      queueContext: queueSnapshot.context,
      addToQueue,
      playNext: playNextInQueue,
      removeFromQueue,
      reorderQueue,
      reorderUpcoming,
      clearQueue,
      jumpTo,
      shuffle: queueSnapshot.shuffle,
      toggleShuffle,
      reshuffle,
      repeat: queueSnapshot.repeat,
      cycleRepeat,
      isReady,
      canPlayCurrent: currentTrack ? MusicService.canPlay(currentTrack) : false,
    }),
    [
      currentTrack,
      status.isPlaying,
      status.isBuffering,
      playTrack,
      togglePlayPause,
      isLoading,
      error,
      clearError,
      retry,
      duration,
      volume,
      setVolume,
      seekTo,
      seekBy,
      next,
      previous,
      queueSnapshot,
      addToQueue,
      playNextInQueue,
      removeFromQueue,
      reorderQueue,
      reorderUpcoming,
      clearQueue,
      jumpTo,
      toggleShuffle,
      reshuffle,
      cycleRepeat,
      isReady,
    ]
  );

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (context === undefined) {
    throw new Error('usePlayer must be used within a PlayerProvider');
  }
  return context;
};

/** Subscribe to playback position without re-rendering on every other change. */
/**
 * Playback position for the UI, read from the local clock (see progressClock).
 * Each caller ticks on its own timer, only while mounted; nothing else in the
 * app re-renders for position. `duration` falls back to the track's own.
 */
export const useProgress = (intervalMs = 250): { position: number; duration: number } => {
  const { duration: trackDuration } = usePlayer();
  const [p, setP] = useState(() => ({
    position: progressClock.now(),
    duration: progressClock.getDuration(),
  }));

  useEffect(() => {
    const tick = () =>
      setP((prev) => {
        const position = progressClock.now();
        const duration = progressClock.getDuration();
        return Math.abs(prev.position - position) < 0.01 && prev.duration === duration
          ? prev
          : { position, duration };
      });
    tick();
    const id = setInterval(tick, intervalMs);
    const unsubscribe = progressClock.subscribe(tick);
    return () => {
      clearInterval(id);
      unsubscribe();
    };
  }, [intervalMs]);

  return { position: p.position, duration: p.duration || trackDuration };
};
