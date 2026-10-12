import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NicknameModal from '../components/NicknameModal';
import { useFavorites } from '../context/FavoritesContext';
import { useFavoritePlaces } from '../context/FavoritePlacesContext';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { getStopById } from '../services/gtfs';
import { radius, spacing, ThemeColors } from '../theme';
import { FavoritePlace, FavoriteStop, JourneyEndpoint, RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Favorites'>;

// Stops (from the hamburger menu) and places (starred from Plan a Journey) used to be
// two separate lists in two separate screens — merged into one so "favourites" always
// means the same list no matter where it's opened from.
type MergedFavorite =
  | { kind: 'stop'; addedAt: number; stop: FavoriteStop }
  | { kind: 'place'; addedAt: number; place: FavoritePlace };

export default function FavoritesScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { pickingFor, currentFrom, currentTo, returnTo } = route.params ?? {};
  const { favorites, loading: stopsLoading, removeFavorite } = useFavorites();
  const { places, loading: placesLoading, removePlace, setNickname } = useFavoritePlaces();
  // The place being named — see NicknameModal; what lets Find Nearby understand "near work".
  const [naming, setNaming] = useState<FavoritePlace | null>(null);
  const t = useTranslation();

  const merged: MergedFavorite[] = [
    ...favorites.map((stop): MergedFavorite => ({ kind: 'stop', addedAt: stop.addedAt, stop })),
    ...places.map((place): MergedFavorite => ({ kind: 'place', addedAt: place.addedAt, place })),
  ].sort((a, b) => b.addedAt - a.addedAt);

  async function handleSelect(item: MergedFavorite) {
    if (!pickingFor) {
      if (item.kind === 'stop') {
        navigation.navigate('StopDetail', {
          stopId: item.stop.stopId,
          stopName: item.stop.stopName,
          stopCode: item.stop.stopCode,
        });
      } else {
        // Just browsing (not picking) a favourite place jumps to Home's inline journey
        // form with it pre-filled as the destination — that's the only place From/To are
        // editable now.
        navigation.navigate('Home', { restoredTo: item.place.endpoint });
      }
      return;
    }

    // Picking mode: carry the full from+to pair back to whichever form opened this picker
    // (Home's inline form, or the Journey Planner results page), not just the field being
    // picked — so the other field's in-progress selection isn't lost on the way back.
    function returnEndpoints(restoredFrom: JourneyEndpoint | undefined, restoredTo: JourneyEndpoint | undefined) {
      if (returnTo === 'JourneyPlanner') {
        navigation.navigate('JourneyPlanner', { restoredFrom, restoredTo, autoSearch: !!(restoredFrom && restoredTo) });
      } else {
        navigation.navigate('Home', { restoredFrom, restoredTo });
      }
    }

    if (item.kind === 'place') {
      returnEndpoints(
        pickingFor === 'from' ? item.place.endpoint : currentFrom,
        pickingFor === 'to' ? item.place.endpoint : currentTo
      );
      return;
    }

    // Favourite stops only store an id/name/code, not coordinates — resolve the real
    // lat/lon from the cached stop list so it can be used as a routing endpoint.
    const resolved = await getStopById(item.stop.stopId);
    const endpoint = resolved
      ? { kind: 'coordinates' as const, lat: resolved.lat, lon: resolved.lon, label: item.stop.stopName }
      : undefined;
    if (!endpoint) return;
    returnEndpoints(pickingFor === 'from' ? endpoint : currentFrom, pickingFor === 'to' ? endpoint : currentTo);
  }

  function handleRemove(item: MergedFavorite) {
    if (item.kind === 'stop') removeFavorite(item.stop.stopId);
    else removePlace(item.place.id);
  }

  return (
    <View style={styles.container}>
      {!stopsLoading && !placesLoading && merged.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t('favoritesScreen.empty')}</Text>
          <Text style={styles.emptySubtext}>{t('favoritesScreen.emptyHint')}</Text>
        </View>
      )}

      <FlatList
        data={merged}
        keyExtractor={(item) => (item.kind === 'stop' ? `stop-${item.stop.stopId}` : `place-${item.place.id}`)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable style={styles.rowMain} onPress={() => handleSelect(item)}>
              <Ionicons name="star" size={18} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText} numberOfLines={1}>
                  {item.kind === 'stop' ? item.stop.stopName : item.place.nickname || item.place.endpoint.label}
                </Text>
                <Text style={styles.rowSubtext} numberOfLines={1}>
                  {item.kind === 'stop' ? t('common.stopCode', { code: item.stop.stopCode }) : ''}
                  {item.kind === 'place' && item.place.nickname ? item.place.endpoint.label : ''}
                  {item.kind === 'place' && !item.place.nickname && item.place.endpoint.kind === 'place'
                    ? item.place.endpoint.secondaryLabel
                    : ''}
                </Text>
              </View>
            </Pressable>
            {item.kind === 'place' && (
              <Pressable
                onPress={() => setNaming(item.place)}
                hitSlop={8}
                style={styles.nameButton}
                accessibilityRole="button"
                accessibilityLabel={t('favoritesScreen.nameLabel', { name: item.place.nickname || item.place.endpoint.label })}
              >
                <Ionicons name={item.place.nickname ? 'pricetag' : 'pricetag-outline'} size={18} color={colors.textMuted} />
              </Pressable>
            )}
            <Pressable
              onPress={() => handleRemove(item)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('favoritesScreen.removeLabel', {
                name: item.kind === 'stop' ? item.stop.stopName : item.place.endpoint.label,
              })}
            >
              <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        )}
      />

      <NicknameModal
        placeName={naming ? naming.endpoint.label : null}
        initialNickname={naming?.nickname ?? ''}
        onSave={(nickname) => {
          if (naming) setNickname(naming.id, nickname);
          setNaming(null);
        }}
        onClose={() => setNaming(null)}
      />

      {!pickingFor && (
        <Pressable
          style={[styles.fab, { bottom: spacing.lg + insets.bottom }]}
          onPress={() => navigation.navigate('AddFavorite')}
        >
          <Text style={styles.fabText}>{t('favoritesScreen.addButton')}</Text>
        </Pressable>
      )}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    list: { padding: spacing.lg, gap: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    nameButton: { marginRight: spacing.md },
    rowText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    rowSubtext: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
    empty: { alignItems: 'center', paddingTop: spacing.xl, paddingHorizontal: spacing.lg },
    emptyText: { fontSize: 16, fontWeight: '600', color: colors.text },
    emptySubtext: { fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, textAlign: 'center' },
    fab: {
      position: 'absolute',
      bottom: spacing.lg,
      right: spacing.lg,
      backgroundColor: colors.primary,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.lg,
    },
    fabText: { color: '#FFFFFF', fontWeight: '700' },
  });
}
