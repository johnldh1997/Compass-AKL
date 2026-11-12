import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AnimatedPressable from './AnimatedPressable';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { isFeedDrifted } from '../services/feedDrift';
import { countKnownTrips, getFeedInfo } from '../services/gtfsStatic';
import { getVehiclePositions } from '../services/vehicles';
import { radius, spacing, ThemeColors } from '../theme';

const FEED_WARNING_DAYS = 30;

interface MenuItem {
  label: string;
  subtitle?: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  // Per-item accent color — falls back to textMuted when omitted (e.g. Settings), so
  // menu icons don't all read as the same single hue.
  iconColor?: string;
  onPress: () => void;
  // Shows a trailing external-link icon — for items that leave the app (e.g. opening a
  // website), so it's clear before tapping that this isn't just another in-app screen.
  external?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  items: MenuItem[];
}

const PANEL_WIDTH = Math.min(300, Dimensions.get('window').width * 0.78);

export default function SideMenu({ visible, onClose, items }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const translateX = useRef(new Animated.Value(-PANEL_WIDTH)).current;
  const [rendered, setRendered] = React.useState(visible);
  // Days remaining rather than the formatted string itself, so the message re-translates
  // correctly if the language setting changes after this has already resolved once.
  const [daysUntilExpiry, setDaysUntilExpiry] = useState<number | null>(null);
  const [feedDrifted, setFeedDrifted] = useState(false);
  const t = useTranslation();

  useEffect(() => {
    if (visible) setRendered(true);
    Animated.timing(translateX, {
      toValue: visible ? 0 : -PANEL_WIDTH,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      if (!visible) setRendered(false);
    });
  }, [visible, translateX]);

  // Surfaced here (not just on the About screen) so an expiring/expired timetable is
  // something the user runs into on the way to somewhere, not only if they happen to
  // go looking for it.
  useEffect(() => {
    getFeedInfo().then((info) => {
      if (!info) return;
      if (info.daysUntilExpiry <= FEED_WARNING_DAYS) setDaysUntilExpiry(info.daysUntilExpiry);
    });
  }, []);

  // --- Timetable Drift Check ---
  // The calendar end date alone misses AT re-issuing trip IDs early, so also check how
  // many live trips the bundled timetable still recognises. Best-effort: any failure
  // (offline, no key) just means no warning.
  useEffect(() => {
    getVehiclePositions()
      .then((vehicles) => countKnownTrips(vehicles.map((v) => v.tripId).filter((id): id is string => !!id)))
      .then(({ matched, total }) => setFeedDrifted(isFeedDrifted(matched, total)))
      .catch(() => {});
  }, []);

  if (!rendered) return null;

  const feedWarning =
    daysUntilExpiry !== null && daysUntilExpiry < 0
      ? t('feed.expired')
      : feedDrifted
        ? t('feed.drifted')
        : daysUntilExpiry !== null
          ? t('feed.expiring', { days: daysUntilExpiry })
          : null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={[StyleSheet.absoluteFill, styles.backdrop]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('menu.closeMenu')}
      />
      <Animated.View
        style={[
          styles.panel,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.md, transform: [{ translateX }] },
        ]}
      >
        <Text style={styles.title}>{t('home.title')}</Text>
        <View style={styles.itemList}>
          {items.map((item) => (
            <AnimatedPressable
              key={item.label}
              scaleTo={0.98}
              style={styles.item}
              onPress={() => {
                onClose();
                item.onPress();
              }}
            >
              <Ionicons name={item.icon} size={20} color={item.iconColor ?? colors.textMuted} />
              <View style={styles.itemTextGroup}>
                <Text style={styles.itemText}>{item.label}</Text>
                {!!item.subtitle && <Text style={styles.itemSubtitle}>{item.subtitle}</Text>}
              </View>
              {item.external && <Ionicons name="open-outline" size={16} color={colors.textMuted} />}
            </AnimatedPressable>
          ))}
        </View>
        {!!feedWarning && (
          <View style={styles.footer}>
            <Ionicons name="warning-outline" size={14} color={colors.danger} />
            <Text style={styles.footerWarning}>{feedWarning}</Text>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: { backgroundColor: 'rgba(0,0,0,0.4)' },
    panel: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: PANEL_WIDTH,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.lg,
    },
    title: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },
    itemList: { flex: 1 },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: radius.sm,
    },
    itemTextGroup: { flex: 1 },
    itemText: { fontSize: 16, fontWeight: '600', color: colors.text },
    itemSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    footerWarning: { flex: 1, fontSize: 12, color: colors.danger },
  });
}
