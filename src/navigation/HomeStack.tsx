import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from '../screens/Home';
import ArtistPageScreen from '../screens/ArtistPage';
import CollectionPageScreen from '../screens/CollectionPage';

const Stack = createNativeStackNavigator();

/**
 * Home and the pages it opens (album) live in their own stack inside the Home
 * tab, like SearchStack, so the bottom tab bar stays visible and going back
 * returns to the same place on Home.
 */
export const HomeStack = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="HomeMain" component={HomeScreen} />
    <Stack.Screen name="ArtistPage" component={ArtistPageScreen} />
    <Stack.Screen name="CollectionPage" component={CollectionPageScreen} />
  </Stack.Navigator>
);
