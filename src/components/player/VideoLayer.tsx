import React, { useEffect, useRef, useState } from 'react';
import { Animated, AppState, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { COLORS, FONTS, SIZES } from '../../constants/theme';
import { Track } from '../../core/types';
import { usePlayer } from '../../hooks/usePlayer';
import { progressClock } from '../../playback/progressClock';
import { VideoService } from '../../services/VideoService';
import { VIDEO, VIDEO_FAIL_TEXT, videoSyncDecision } from '../../video/videoLogic';
import { LoadingLine } from './LoadingLine';

type Props = {
  track: Track;
  /** Called after the failure message has been shown, so the screen can go back. */
  onFailed: () => void;
  topInset: number;
};

type Phase = 'resolving' | 'ready' | 'failed';

/**
 * The picture for the current song: full-screen, cropped to fill (cover),
 * silent, and kept in step with the audio. While it loads there is only a black
 * screen and a red line sweeping left to right; if it can not be fetched the
 * message is shown and the screen returns to the normal player.
 */
export function VideoLayer({ track, onFailed, topInset }: Props) {
  const { isBuffering, isLoading } = usePlayer();
  const [phase, setPhase] = useState<Phase>('resolving');
  const fade = useRef(new Animated.Value(0)).current;
  const offsetRef = useRef(0);
  const durationRef = useRef<number | undefined>(undefined);
  const readyRef = useRef(false);
  const lastSeekAt = useRef(0);
  const frameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  busyRef.current = isBuffering || isLoading;

  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.loop = false;
    p.audioMixingMode = 'mixWithOthers'; // never steal audio focus from the real player
    p.staysActiveInBackground = false;
    p.showNowPlayingNotification = false;
  });

  // Resolve + load whenever the song changes.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    readyRef.current = false;
    fade.setValue(0);
    setPhase('resolving');
    try {
      player.pause();
    } catch {
      /* player is being replaced */
    }

    const fail = () => {
      if (cancelled) return;
      readyRef.current = false;
      setPhase('failed');
    };

    (async () => {
      try {
        const prepared = await VideoService.prepare(track, controller.signal);
        if (cancelled) return;
        offsetRef.current = prepared.offsetS;
        durationRef.current = prepared.stream.durationS;
        await player.replaceAsync({ uri: prepared.stream.url, headers: prepared.stream.headers });
        if (cancelled) return;
        // Start from where the audio is right now.
        player.currentTime = Math.max(0, progressClock.now() + prepared.offsetS);
        lastSeekAt.current = Date.now();
        player.play();
        frameTimer.current = setTimeout(fail, VIDEO.FIRST_FRAME_TIMEOUT_MS);
      } catch {
        fail();
      }
    })();

    const statusSub = player.addListener('statusChange', (e: { status: string }) => {
      if (e.status === 'error') {
        if (frameTimer.current) clearTimeout(frameTimer.current);
        fail();
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (frameTimer.current) clearTimeout(frameTimer.current);
      statusSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const onFirstFrame = () => {
    if (frameTimer.current) clearTimeout(frameTimer.current);
    readyRef.current = true;
    setPhase('ready');
    Animated.timing(fade, { toValue: 1, duration: 280, useNativeDriver: true }).start();
  };

  // Keep the silent video in step with the audio.
  useEffect(() => {
    const tick = () => {
      if (!readyRef.current) return;
      if (AppState.currentState !== 'active') {
        try {
          player.pause();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        const action = videoSyncDecision({
          audioPosS: progressClock.now(),
          audioPlaying: progressClock.isPlaying(),
          audioBusy: busyRef.current,
          videoPosS: player.currentTime,
          offsetS: offsetRef.current,
          videoDurationS: durationRef.current,
          videoReady: true,
          sinceSeekMs: Date.now() - lastSeekAt.current,
        });
        if (action.seekToS !== undefined) {
          player.currentTime = action.seekToS;
          lastSeekAt.current = Date.now();
        }
        if (action.play) player.play();
        else player.pause();
      } catch {
        /* the player may be mid-replace; the next tick retries */
      }
    };
    const id = setInterval(tick, VIDEO.SYNC_TICK_MS);
    return () => clearInterval(id);
  }, [player]);

  // Show the failure message, then hand control back.
  useEffect(() => {
    if (phase !== 'failed') return;
    const t = setTimeout(onFailed, VIDEO.FAIL_MESSAGE_MS);
    return () => clearTimeout(t);
  }, [phase, onFailed]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, styles.black]} />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          allowsPictureInPicture={false}
          onFirstFrameRender={onFirstFrame}
        />
      </Animated.View>

      {phase === 'resolving' && (
        <View style={[styles.line, { top: topInset + SIZES.sm }]}>
          <LoadingLine />
        </View>
      )}

      {phase === 'failed' && (
        <View style={styles.failWrap}>
          <Text style={styles.failText}>{VIDEO_FAIL_TEXT}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  black: { backgroundColor: '#000' },
  line: { position: 'absolute', left: 0, right: 0 },
  failWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SIZES.xl,
  },
  failText: {
    fontFamily: FONTS.medium,
    fontSize: 16,
    color: COLORS.text.primary,
    textAlign: 'center',
  },
});
