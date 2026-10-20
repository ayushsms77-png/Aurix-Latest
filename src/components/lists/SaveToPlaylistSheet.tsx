import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListMusic, Plus, X } from 'lucide-react-native';
import { COLORS, FONTS, SIZES } from '../../constants/theme';
import { Track } from '../../core/types';
import { useLibrary } from '../../hooks/useLibrary';

type Props = {
  /** The songs to save (a whole album or playlist). Null closes the sheet. */
  tracks: Track[] | null;
  /** Pre-filled name for a new playlist (the album's name). */
  defaultName: string;
  onClose: () => void;
  /** Called with a short message to show after saving. */
  onSaved: (message: string) => void;
};

/** Save every song of an album/playlist into one of your playlists, or a new one. */
export const SaveToPlaylistSheet: React.FC<Props> = ({ tracks, defaultName, onClose, onSaved }) => {
  const insets = useSafeAreaInsets();
  const { playlists, addToPlaylist, createPlaylist } = useLibrary();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(defaultName);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // A fresh sheet always starts with the album name in the "new playlist" box.
  useEffect(() => {
    if (tracks) {
      setNewName(defaultName);
      setCreating(false);
    }
  }, [tracks, defaultName]);

  const ordered = useMemo(
    () => [...playlists].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [playlists]
  );

  const close = useCallback(() => {
    Keyboard.dismiss();
    setCreating(false);
    onClose();
  }, [onClose]);

  const count = tracks?.length ?? 0;
  const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

  const saveInto = useCallback(
    (playlistId: string, name: string, existingIds: Set<string>) => {
      if (!tracks?.length) return;
      const added = tracks.filter((t) => !existingIds.has(t.id)).length;
      if (added > 0) addToPlaylist(playlistId, tracks);
      onSaved(added > 0 ? `Saved ${songs(added)} to ${name}` : `Already in ${name}`);
      close();
    },
    [tracks, addToPlaylist, onSaved, close]
  );

  const createAndSave = useCallback(() => {
    const name = newName.trim();
    if (!name || !tracks?.length) return;
    createPlaylist(name, tracks);
    onSaved(`Saved ${songs(tracks.length)} to ${name}`);
    close();
  }, [newName, tracks, createPlaylist, onSaved, close]);

  return (
    <Modal visible={tracks !== null} transparent animationType="slide" onRequestClose={close}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
      <View
        style={[
          styles.sheet,
          {
            paddingBottom: keyboardHeight > 0 ? SIZES.lg : insets.bottom + SIZES.lg,
            bottom: keyboardHeight,
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              Save to playlist
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {songs(count)} from {defaultName}
            </Text>
          </View>
          <TouchableOpacity onPress={close} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <X color={COLORS.text.secondary} size={22} />
          </TouchableOpacity>
        </View>

        {creating ? (
          <View style={styles.createRow}>
            <TextInput
              style={styles.input}
              value={newName}
              onChangeText={setNewName}
              placeholder="Playlist name"
              placeholderTextColor={COLORS.text.muted}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={createAndSave}
              maxLength={60}
            />
            <TouchableOpacity
              style={[styles.createButton, !newName.trim() && styles.disabled]}
              onPress={createAndSave}
              disabled={!newName.trim()}
            >
              <Text style={styles.createButtonText}>Create</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => setCreating(true)}>
            <View style={styles.rowIcon}>
              <Plus color={COLORS.text.primary} size={20} />
            </View>
            <Text style={styles.rowLabel}>New playlist</Text>
          </TouchableOpacity>
        )}

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {ordered.map((playlist) => {
            const ids = new Set(playlist.tracks.map((t) => t.id));
            return (
              <TouchableOpacity
                key={playlist.id}
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => saveInto(playlist.id, playlist.name, ids)}
              >
                <View style={styles.rowIcon}>
                  <ListMusic color={COLORS.text.primary} size={20} />
                </View>
                <View style={styles.rowTextWrap}>
                  <Text style={styles.rowLabelText} numberOfLines={1}>
                    {playlist.name}
                  </Text>
                  <Text style={styles.rowMeta}>{songs(playlist.tracks.length)}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
          {ordered.length === 0 && !creating && (
            <Text style={styles.empty}>No playlists yet. Create one above.</Text>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    maxHeight: '75%',
    backgroundColor: COLORS.surfaceRaised,
    borderTopLeftRadius: SIZES.radius.lg,
    borderTopRightRadius: SIZES.radius.lg,
    borderTopWidth: 1,
    borderColor: COLORS.glassBorder,
    paddingTop: SIZES.lg,
    paddingHorizontal: SIZES.md,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: SIZES.md },
  headerText: { flex: 1, marginRight: SIZES.md },
  title: { fontFamily: FONTS.bold, fontSize: 20, color: COLORS.text.primary },
  subtitle: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.text.secondary, marginTop: 2 },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: SIZES.sm + 4, gap: SIZES.md },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: SIZES.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceLight,
  },
  rowTextWrap: { flex: 1 },
  rowLabel: { flex: 1, fontFamily: FONTS.medium, fontSize: 16, color: COLORS.text.primary },
  rowLabelText: { fontFamily: FONTS.medium, fontSize: 16, color: COLORS.text.primary },
  rowMeta: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.text.secondary, marginTop: 2 },
  createRow: { flexDirection: 'row', alignItems: 'center', gap: SIZES.sm, marginBottom: SIZES.sm },
  input: {
    flex: 1,
    fontFamily: FONTS.medium,
    fontSize: 16,
    color: COLORS.text.primary,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: SIZES.radius.sm,
    paddingHorizontal: SIZES.md,
    paddingVertical: SIZES.sm + 4,
  },
  createButton: {
    paddingHorizontal: SIZES.md,
    paddingVertical: SIZES.sm + 4,
    borderRadius: SIZES.radius.sm,
    backgroundColor: COLORS.text.primary,
  },
  createButtonText: { fontFamily: FONTS.medium, fontSize: 15, color: COLORS.background },
  disabled: { opacity: 0.4 },
  empty: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text.secondary, paddingVertical: SIZES.lg },
});
