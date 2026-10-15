import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFavoritePlaces } from '../context/FavoritePlacesContext';
import { useHomeAddress } from '../context/HomeAddressContext';
import { useRecentPlaces } from '../context/RecentPlacesContext';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { autocompletePlace, createSessionToken } from '../services/directions';
import { getCurrentLocationEndpoint } from '../services/location';
import { radius, spacing, ThemeColors } from '../theme';
import { JourneyEndpoint, PlaceSuggestion } from '../types';

interface Props {
  placeholder: string;
  onSelect: (endpoint: JourneyEndpoint) => void;
  onClear?: () => void;
  onChooseOnMap: () => void;
  onOpenFavorites: () => void;
  initialEndpoint?: JourneyEndpoint;
}

const DEBOUNCE_MS = 300;

function suggestionToEndpoint(place: PlaceSuggestion): JourneyEndpoint {
  return { kind: 'place', placeId: place.placeId, label: place.mainText, secondaryLabel: place.secondaryText };
}

// The suggestions list opens as a full Modal rather than an inline dropdown — this used to
// be an absolutely-positioned overlay, but sitting directly on top of Home's live map meant
// the map's own drag-to-pan gesture handling competed with (and usually won against)
// scrolling the list. A Modal renders in its own separate native layer, so it can never
// lose that fight, regardless of what's underneath it.
export default function PlaceAutocompleteInput({
  placeholder,
  onSelect,
  onClear,
  onChooseOnMap,
  onOpenFavorites,
  initialEndpoint,
}: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [text, setText] = useState(initialEndpoint?.label ?? '');
  const [modalOpen, setModalOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [selected, setSelected] = useState<JourneyEndpoint | null>(initialEndpoint ?? null);
  const sessionToken = useRef(createSessionToken());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const modalInputRef = useRef<TextInput>(null);

  const { isFavorite, addPlace, removeByEndpoint } = useFavoritePlaces();
  const { places: recentPlaces, addRecent, removeRecent } = useRecentPlaces();
  const { homeAddress } = useHomeAddress();
  const t = useTranslation();
  const selectedIsFavorite = selected ? isFavorite(selected) : false;

  function toggleFavorite() {
    if (!selected) return;
    if (selectedIsFavorite) removeByEndpoint(selected);
    else addPlace(selected);
  }

  function handleChangeText(value: string) {
    setText(value);
    setSelected(null);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      autocompletePlace(value, sessionToken.current)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, DEBOUNCE_MS);
  }

  function choose(endpoint: JourneyEndpoint) {
    setText(endpoint.label);
    setSuggestions([]);
    setSelected(endpoint);
    setModalOpen(false);
    sessionToken.current = createSessionToken();
    addRecent(endpoint);
    onSelect(endpoint);
  }

  async function handleUseCurrentLocation() {
    const endpoint = await getCurrentLocationEndpoint();
    if (endpoint) choose(endpoint);
    else Alert.alert(t('map.locationUnavailableTitle'), t('map.locationUnavailableMessage'));
  }

  function handleClear() {
    setText('');
    setSelected(null);
    setSuggestions([]);
    onClear?.();
  }

  // Leaving to a different screen (map picker/favourites) — close the modal first so it
  // isn't still sitting open underneath when the user navigates back to this one.
  function handleChooseOnMap() {
    setModalOpen(false);
    onChooseOnMap();
  }

  function handleOpenFavorites() {
    setModalOpen(false);
    onOpenFavorites();
  }

  const showQuickOptions = text.length === 0;
  const showSuggestions = text.length > 0 && suggestions.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <Pressable style={styles.input} onPress={() => setModalOpen(true)}>
          <Text style={text ? styles.inputText : styles.inputPlaceholder} numberOfLines={1}>
            {text || placeholder}
          </Text>
        </Pressable>
        {text.length > 0 && (
          <Pressable
            onPress={handleClear}
            hitSlop={8}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={t('common.clear')}
          >
            <Ionicons name="close-circle" size={20} color={colors.textMuted} />
          </Pressable>
        )}
        {selected && (
          <Pressable
            onPress={toggleFavorite}
            hitSlop={8}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={selectedIsFavorite ? t('placeInput.removeFavourite') : t('placeInput.addFavourite')}
          >
            <Ionicons
              name={selectedIsFavorite ? 'star' : 'star-outline'}
              size={20}
              color={selectedIsFavorite ? colors.accent : colors.textMuted}
            />
          </Pressable>
        )}
      </View>

      <Modal
        visible={modalOpen}
        animationType="slide"
        onRequestClose={() => setModalOpen(false)}
        // --- Keyboard On First Tap ---
        // `autoFocus` on a field inside a Modal focuses it (a cursor appears) but, on Android, the soft keyboard
        // doesn't open — the modal's window isn't ready to receive it yet, so it took a second tap on the field.
        // Focusing once the modal has actually finished appearing, after a beat for the slide-in, opens it.
        onShow={() => setTimeout(() => modalInputRef.current?.focus(), 100)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top + spacing.sm }]}>
          <View style={styles.modalHeader}>
            <Pressable
              onPress={() => setModalOpen(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('common.goBack')}
            >
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </Pressable>
            <TextInput
              ref={modalInputRef}
              style={styles.modalInput}
              placeholder={placeholder}
              placeholderTextColor={colors.textMuted}
              value={text}
              onChangeText={handleChangeText}
            />
            {text.length > 0 && (
              <Pressable
                onPress={handleClear}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.clear')}
              >
                <Ionicons name="close-circle" size={20} color={colors.textMuted} />
              </Pressable>
            )}
          </View>

          <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
            {showQuickOptions && (
              <>
                <Pressable style={styles.suggestionRow} onPress={handleUseCurrentLocation}>
                  <Ionicons name="locate" size={18} color={colors.primary} />
                  <Text style={styles.mainText}>{t('common.currentLocation')}</Text>
                </Pressable>
                {homeAddress && (
                  <Pressable style={styles.suggestionRow} onPress={() => choose(homeAddress)}>
                    <Ionicons name="home" size={18} color={colors.amber} />
                    <Text style={styles.mainText} numberOfLines={1}>
                      {homeAddress.label}
                    </Text>
                  </Pressable>
                )}
                <Pressable style={styles.suggestionRow} onPress={handleChooseOnMap}>
                  <Ionicons name="map-outline" size={18} color={colors.rose} />
                  <Text style={styles.mainText}>{t('common.chooseOnMap')}</Text>
                </Pressable>
                <Pressable style={styles.suggestionRow} onPress={handleOpenFavorites}>
                  <Ionicons name="star" size={18} color={colors.accent} />
                  <Text style={[styles.mainText, styles.grow]}>{t('menu.favourites')}</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </Pressable>

                {recentPlaces.length > 0 && <Text style={styles.sectionLabel}>{t('common.recent')}</Text>}
                {recentPlaces.map((p, index) => (
                  <Pressable key={index} style={styles.suggestionRow} onPress={() => choose(p.endpoint)}>
                    <Ionicons name="time-outline" size={18} color={colors.textMuted} />
                    <Text style={[styles.mainText, styles.grow]} numberOfLines={1}>
                      {p.endpoint.label}
                    </Text>
                    <Pressable
                      onPress={() => removeRecent(p.endpoint)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${p.endpoint.label} from recent`}
                    >
                      <Ionicons name="close" size={18} color={colors.textMuted} />
                    </Pressable>
                  </Pressable>
                ))}
              </>
            )}

            {showSuggestions &&
              suggestions.map((item) => (
                <Pressable
                  key={item.placeId}
                  style={styles.suggestionRow}
                  onPress={() => choose(suggestionToEndpoint(item))}
                >
                  <View style={styles.grow}>
                    <Text style={styles.mainText}>{item.mainText}</Text>
                    {!!item.secondaryText && <Text style={styles.secondaryText}>{item.secondaryText}</Text>}
                  </View>
                </Pressable>
              ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { marginBottom: spacing.sm },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    inputText: { fontSize: 15, color: colors.text },
    inputPlaceholder: { fontSize: 15, color: colors.textMuted },
    iconButton: { padding: spacing.xs },
    modalContainer: { flex: 1, backgroundColor: colors.background },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    modalInput: { flex: 1, fontSize: 17, color: colors.text, paddingVertical: spacing.xs },
    modalList: { flex: 1 },
    suggestionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
      textTransform: 'uppercase',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    mainText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    secondaryText: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
    grow: { flex: 1 },
  });
}
