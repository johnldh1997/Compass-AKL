import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { radius, spacing, ThemeColors } from '../theme';

interface Props {
  // The place being named; the dialog is shown while this is set.
  placeName: string | null;
  initialNickname: string;
  onSave: (nickname: string) => void;
  onClose: () => void;
}

// --- Place Nickname Dialog ---
// A small prompt for naming a favourite place ("Work", "Gym"). Android has no built-in text prompt
// (Alert.prompt is iOS-only), so this is a plain modal with a text field.
export default function NicknameModal({ placeName, initialNickname, onSave, onClose }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const t = useTranslation();
  const [value, setValue] = useState(initialNickname);

  // Each time the dialog opens it starts from that place's current name.
  useEffect(() => {
    if (placeName !== null) setValue(initialNickname);
  }, [placeName, initialNickname]);

  return (
    <Modal visible={placeName !== null} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('common.cancel')} />
        <View style={styles.card}>
          <Text style={styles.title}>{t('favoritesScreen.nameTitle')}</Text>
          <Text style={styles.placeName} numberOfLines={1}>
            {placeName}
          </Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={t('favoritesScreen.namePlaceholder')}
            placeholderTextColor={colors.textMuted}
            maxLength={30}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => onSave(value)}
          />
          <Text style={styles.hint}>{t('favoritesScreen.nameHint')}</Text>
          <View style={styles.actions}>
            {!!initialNickname && (
              <Pressable onPress={() => onSave('')} hitSlop={8}>
                <Text style={styles.clearText}>{t('favoritesScreen.nameClear')}</Text>
              </Pressable>
            )}
            <View style={styles.spacer} />
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable style={styles.saveButton} onPress={() => onSave(value)}>
              <Text style={styles.saveText}>{t('favoritesScreen.nameSave')}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: spacing.lg },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    title: { fontSize: 17, fontWeight: '700', color: colors.text },
    placeName: { fontSize: 13, color: colors.textMuted },
    input: {
      backgroundColor: colors.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: 15,
      color: colors.text,
    },
    hint: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
    spacer: { flex: 1 },
    clearText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
    cancelText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
    saveButton: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    saveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  });
}
