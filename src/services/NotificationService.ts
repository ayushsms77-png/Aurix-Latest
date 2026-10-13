import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPushRegistrar, type PushDeps } from './pushRegistrar';

/**
 * Aurix push notifications (Expo Push + FCM).
 *
 * Deliberately self-contained: it touches nothing in playback, navigation or
 * the library. A notification tap just opens the app (Android's default).
 * Call initNotifications() once, after the first screen is up.
 *
 * All registration logic lives in pushRegistrar.ts (pure, unit-tested).
 *
 * KILL SWITCH: app.json -> expo.extra.pushRegistrationEnabled. While it is not
 * exactly `true`, this module does NOT register listeners, fetch tokens, ask
 * for permission or call the server.
 */

const CHANNEL_ID = 'daily';

type Extra = {
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  pushRegistrationEnabled?: boolean;
  eas?: { projectId?: string };
};
const extra = (): Extra => (Constants.expoConfig?.extra ?? {}) as Extra;

let started = false;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Aurix Daily',
    description: 'Daily nudges and song picks from Aurix',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#FA2D55',
    vibrationPattern: [0, 200, 100, 200],
  });
}

export async function initNotifications(): Promise<void> {
  if (started || Platform.OS === 'web') return;
  started = true;

  // Kill switch: do nothing at all (no listener, no token fetch, no network).
  if (extra().pushRegistrationEnabled !== true) return;

  try {
    // Show notifications even while the app is open (quietly: no sound).
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    await ensureChannel();

    // Tapping a notification opens the app (default); keep the event handled.
    Notifications.addNotificationResponseReceivedListener(() => undefined);

    const deps: PushDeps = {
      enabled: true,
      platform: Platform.OS,
      supabaseUrl: extra().supabaseUrl,
      supabaseKey: extra().supabasePublishableKey,
      projectId: extra().eas?.projectId,
      appVersion: Constants.expoConfig?.version ?? null,
      notifications: Notifications as unknown as PushDeps['notifications'],
      storage: AsyncStorage,
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      random: Math.random,
      log: __DEV__ ? (...a) => console.log('[Notifications]', ...a) : undefined,
    };
    await createPushRegistrar(deps).init();
  } catch (e) {
    // Never let this affect the app.
    if (__DEV__) console.log('[Notifications] init failed:', e);
  }
}
