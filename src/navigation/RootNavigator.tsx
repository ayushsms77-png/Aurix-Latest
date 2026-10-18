import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { TabNavigator } from './TabNavigator';
import { COLORS } from '../constants/theme';
import { useLibrary } from '../hooks/useLibrary';
import ProfileSetupScreen from '../screens/ProfileSetup';
import NowPlayingScreen from '../screens/NowPlaying';
import SyncRoomScreen from '../screens/SyncRoom';

const Stack = createNativeStackNavigator();

const NoteTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: COLORS.background,
    text: COLORS.text.primary,
  },
};

export const RootNavigator = () => {
  const { profile, isLoaded } = useLibrary();

  // Wait for persistence before choosing a route, otherwise a returning
  // user is flashed the onboarding screen for a frame.
  if (!isLoaded) return null;

  const initialRoute = profile.completed ? 'Main' : 'ProfileSetup';

  return (
    <NavigationContainer theme={NoteTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialRoute}>
        {/* Onboarding (the old "N Ø T E" branded splash) removed from the
            first-launch flow — new users land straight on ProfileSetup. */}
        <Stack.Screen name="ProfileSetup" component={ProfileSetupScreen} />
        <Stack.Screen name="Main" component={TabNavigator} />
        {/* Playlists, Artists, Albums, Songs, Downloaded Music and History
            all moved into LibraryStack (nested inside the Library tab) so
            the bottom tab bar stays visible on them -- see LibraryStack.tsx. */}
        <Stack.Screen 
          name="NowPlaying" 
          component={NowPlayingScreen} 
          options={{ presentation: 'fullScreenModal' }}
        />
        {/* Sync Play room: locked (no swipe-back; the screen asks before any exit). */}
        <Stack.Screen
          name="SyncRoom"
          component={SyncRoomScreen}
          options={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
};
