import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Outfit_300Light,
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  Outfit_800ExtraBold,
  Outfit_900Black,
} from '@expo-google-fonts/outfit';
import { AnimatedSplash } from './src/components/AnimatedSplash';
import { initNotifications } from './src/services/NotificationService';
import { RootNavigator } from './src/navigation/RootNavigator';
import { PlayerProvider } from './src/hooks/usePlayer';
import { LibraryProvider, useLibrary } from './src/hooks/useLibrary';
import { COLORS } from './src/constants/theme';
import { getPlatformInfo, isNoteNativeAvailable } from './modules/note-native';

// Keep the native splash up until AnimatedSplash has drawn the identical logo
// frame (it calls hideAsync via onLogoDrawn), so the hand-off has no flash.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

// Tells the splash that the app underneath has loaded its data and had a moment
// to mount, so fading the splash out will reveal a finished screen.
const ReadySignal: React.FC<{ onReady: () => void }> = ({ onReady }) => {
  const { isLoaded } = useLibrary();
  useEffect(() => {
    if (!isLoaded) return;
    let raf = 0;
    const t = setTimeout(() => {
      raf = requestAnimationFrame(onReady);
    }, 150);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [isLoaded, onReady]);
  return null;
};

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  // The heavy app is mounted only AFTER the splash animation has finished, so
  // nothing competes with it (mounting it in parallel made the animation skip).
  const [introDone, setIntroDone] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const onIntroDone = useCallback(() => setIntroDone(true), []);
  const markAppReady = useCallback(() => setAppReady(true), []);
  const hideNativeSplash = useCallback(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  const finishSplash = useCallback(() => setSplashDone(true), []);

  // Push notifications: channel + permission + token registration, once the
  // splash is gone. Fully self-contained and failure-tolerant.
  useEffect(() => {
    if (splashDone) void initNotifications();
  }, [splashDone]);

  // Proof-of-connection for the Android native module. Dev-only, no UI impact.
  useEffect(() => {
    if (__DEV__) {
      console.log(
        '[NoteNative] available:',
        isNoteNativeAvailable(),
        'getPlatformInfo():',
        getPlatformInfo()
      );
    }
  }, []);

  // Aurix's brand font. Screens reference FONTS.* from constants/theme.ts,
  // which only resolves once these are loaded — block first paint on this
  // (background stays COLORS.background so there's no white flash) rather
  // than letting screens render with a wrong fallback font for one frame.
  const [fontsLoaded] = useFonts({
    Outfit_300Light,
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
    Outfit_700Bold,
    Outfit_800ExtraBold,
    Outfit_900Black,
  });

  // Safety net: never leave the splash up forever if the ready signal is lost.
  useEffect(() => {
    if (!introDone || !fontsLoaded) return;
    const t = setTimeout(() => setAppReady(true), 3500);
    return () => clearTimeout(t);
  }, [introDone, fontsLoaded]);

  return (
    <SafeAreaProvider>
      <View style={styles.webWrapper}>
        {fontsLoaded && introDone && (
          <LibraryProvider>
            <ReadySignal onReady={markAppReady} />
            <PlayerProvider>
              <View style={styles.appContainer}>
                <RootNavigator />
                <StatusBar style="light" />
              </View>
            </PlayerProvider>
          </LibraryProvider>
        )}
        {!splashDone && (
          <AnimatedSplash
            ready={appReady}
            onFinish={finishSplash}
            onLogoDrawn={hideNativeSplash}
            onIntroDone={onIntroDone}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  webWrapper: {
    flex: 1,
    backgroundColor: '#000000', // Darker background for the empty space on desktop
    alignItems: 'center',
    justifyContent: 'center',
  },
  appContainer: {
    flex: 1,
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 420 : '100%',
    maxHeight: Platform.OS === 'web' ? 900 : '100%',
    backgroundColor: COLORS.background,
    overflow: 'hidden',
    // Add subtle borders and rounded corners to look like a phone screen on Web
    borderWidth: Platform.OS === 'web' ? 1 : 0,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: Platform.OS === 'web' ? 40 : 0,
  }
});
