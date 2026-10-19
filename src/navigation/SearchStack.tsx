import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import SearchScreen from '../screens/Search';
import ArtistPageScreen from '../screens/ArtistPage';
import CollectionPageScreen from '../screens/CollectionPage';

const Stack = createNativeStackNavigator();

/**
 * Explore and the pages it opens (artist, album, playlist) live in their own
 * stack INSIDE the Search tab, like LibraryStack, so the bottom tab bar stays
 * visible and going back returns to the same search results.
 */
export const SearchStack = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="SearchHome" component={SearchScreen} />
    <Stack.Screen name="ArtistPage" component={ArtistPageScreen} />
    <Stack.Screen name="CollectionPage" component={CollectionPageScreen} />
  </Stack.Navigator>
);
