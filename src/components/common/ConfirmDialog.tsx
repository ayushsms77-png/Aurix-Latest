import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS, FONTS, SIZES } from '../../constants/theme';

type Props = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red, for actions like Exit. Default is the brand accent. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Aurix-styled replacement for the system Alert (dark card, rounded, accent buttons). */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.buttons}>
            <TouchableOpacity style={[styles.btn, styles.cancel]} activeOpacity={0.8} onPress={onCancel}>
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, destructive ? styles.destructive : styles.confirm]}
              activeOpacity={0.85}
              onPress={onConfirm}
            >
              <Text style={styles.confirmText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SIZES.lg,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: COLORS.surfaceRaised,
    borderRadius: SIZES.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    padding: SIZES.lg,
  },
  title: { fontFamily: FONTS.bold, fontSize: 19, color: COLORS.text.primary },
  message: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.text.secondary,
    marginTop: SIZES.sm,
  },
  buttons: { flexDirection: 'row', gap: SIZES.smd, marginTop: SIZES.lg },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: SIZES.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancel: { backgroundColor: COLORS.surfaceLight, borderWidth: StyleSheet.hairlineWidth, borderColor: COLORS.hairline },
  cancelText: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.text.primary },
  confirm: { backgroundColor: COLORS.accent.green },
  destructive: { backgroundColor: COLORS.accent.red },
  confirmText: { fontFamily: FONTS.semibold, fontSize: 15, color: '#fff' },
});
