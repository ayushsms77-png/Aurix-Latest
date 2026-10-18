import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LibraryScreen from '../screens/Library';
import PlaylistsListScreen from '../screens/PlaylistsList';
import ArtistsListScreen from '../screens/ArtistsList';
import AlbumsListScreen from '../screens/AlbumsList';
import SongsListScreen from '../screens/SongsList';
import DownloadedMusicScreen from '../screens/DownloadedMusic';
import HistoryScreen from '../screens/History';
import PlaylistDetailScreen from '../screens/PlaylistDetail';
import SyncPlayScreen from '../screens/SyncPlay';

const Stack = createNativeStackNavigator();

/**
 * Everything reachable from the Library tab now lives in ITS OWN stack,
 * nested inside the Library tab instead of the root stack. A nested stack's
 * screens render underneath the same bottom tab bar the tab that owns them
 * uses -- a root-level stack screen never does, which is why Favorites,
 * History, Playlists, Artists, Albums, Songs and Downloaded Music were all
 * losing the tab bar on push before this change.
 */
export const LibraryStack = () => {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="LibraryMenu" component={LibraryScreen} />
      <Stack.Screen name="PlaylistsList" component={PlaylistsListScreen} />
      <Stack.Screen name="ArtistsList" component={ArtistsListScreen} />
      <Stack.Screen name="AlbumsList" component={AlbumsListScreen} />
      <Stack.Screen name="SongsList" component={SongsListScreen} />
      <Stack.Screen name="DownloadedMusic" component={DownloadedMusicScreen} />
      <Stack.Screen name="History" component={HistoryScreen} />
      <Stack.Screen name="Playlist" component={PlaylistDetailScreen} />
      <Stack.Screen name="SyncPlay" component={SyncPlayScreen} />
    </Stack.Navigator>
  );
};
