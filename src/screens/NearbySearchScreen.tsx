import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useHeaderHeight } from '@react-navigation/elements';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AnimatedPressable from '../components/AnimatedPressable';
import { useThemeColors } from '../context/ThemeContext';
import { useTranslation } from '../i18n/useTranslation';
import { useHomeAddress } from '../context/HomeAddressContext';
import { useSettings } from '../context/SettingsContext';
import { getCurrentLocationEndpoint } from '../services/location';
import {
  explainResults,
  NearbySearchResult,
  ParsedNearbyQuery,
  parseNearbyQuery,
  resolveEndpointCoordinates,
  searchNearby,
} from '../services/nearbySearch';
import { radius, spacing, ThemeColors } from '../theme';
import { JourneyEndpoint, RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'NearbySearch'>;

// A fresh GPS fix (getCurrentLocationEndpoint, deliberately not the faster-but-stale
// getFastCoordinates — see alerts.ts) can occasionally hang far longer than a normal
// network call, especially indoors. Without a bound here the loading spinner never
// resolves — matches the LOCATION_TIMEOUT_MS pattern in VehicleMap.tsx/ChooseOnMapScreen.tsx,
// just longer since accuracy matters more for "what's near me" than for map centering.
const SEARCH_TIMEOUT_MS = 12_000;

// --- Persistence ---
// A chat that vanishes the moment you leave the screen doesn't read as a real conversation —
// this survives navigation and app restarts, same storage-key convention as the rest of the
// app's AsyncStorage-backed contexts (see e.g. RecentTripsContext).
const STORAGE_KEY = 'auckland-transit:nearby-search-chat';

interface PersistedNearbyChat {
  messages: ChatMessage[];
  lastIntent: ParsedNearbyQuery | null;
}

// JSON round-trips a Date as an ISO string, not back into a Date instance — this restores it
// on the one field that's ever a real Date (results messages' departureTime).
function reviveMessage(message: ChatMessage): ChatMessage {
  if (message.role === 'assistant' && message.kind === 'results') {
    return { ...message, departureTime: message.departureTime ? new Date(message.departureTime) : null };
  }
  return message;
}

// --- Chat Thread ---
// Each search is its own turn (user bubble + assistant reply), so a rejected/failed
// attempt stays visible while the user tries again, rather than one result area that
// silently overwrites itself.
type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }
  // A clarifying question — a normal part of the conversation, not a failure, so it gets its
  // own kind rather than reusing the red error styling.
  | { id: string; role: 'assistant'; kind: 'question'; text: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'results';
      results: NearbySearchResult[];
      origin: JourneyEndpoint;
      // Shown as a "near <place>" confirmation only when true — lets a misread location
      // (or a correct one) be visibly obvious rather than buried in prose.
      usedReferenceLocation: boolean;
      departureTime: Date | null;
      // Best-effort — a failed explain-results call still shows real results, just without
      // the written blurb, rather than losing the results over a second call's failure.
      explanation?: string;
    };

// Plain Omit<ChatMessage, 'id'> collapses the union to its shared fields only — this
// distributes over each member instead, so each call site still gets its own shape checked.
type NewChatMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, 'id'> : never) : never;

function formatSubtitle(result: NearbySearchResult, t: ReturnType<typeof useTranslation>): string {
  if (result.mode === 'WALK') return t('nearby.walkMinutes', { minutes: result.durationMinutes });
  return result.routeShortName
    ? t('nearby.transitMinutesRoute', { minutes: result.durationMinutes, route: result.routeShortName })
    : t('nearby.transitMinutes', { minutes: result.durationMinutes });
}

// "Today"/"Tomorrow" read faster than a weekday name for the two cases that matter most;
// anything further out falls back to the weekday, which is still unambiguous without a
// full date — this is a confirmation chip, not a calendar.
function formatDepartureLabel(date: Date, isKorean: boolean, t: ReturnType<typeof useTranslation>): string {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  const time = date.toLocaleTimeString(isKorean ? 'ko-KR' : 'en-NZ', { hour: 'numeric', minute: '2-digit', hour12: true });
  const dayLabel =
    diffDays === 0
      ? t('nearby.today')
      : diffDays === 1
        ? t('nearby.tomorrow')
        : date.toLocaleDateString(isKorean ? 'ko-KR' : 'en-NZ', { weekday: 'long' });
  return `${dayLabel}, ${time}`;
}

export default function NearbySearchScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  // insets.top is only the status bar — this screen also has a nav header above it, whose
  // height useHeaderHeight() actually measures. Using insets.top alone under-shifts the
  // input by the header's height, leaving it partly covered by the keyboard.
  const headerHeight = useHeaderHeight();
  const t = useTranslation();
  const { language } = useSettings();
  const isKorean = language === 'ko';
  const { homeAddress } = useHomeAddress();
  const [queryText, setQueryText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const nextId = useRef(0);
  // The last successfully-understood turn, so a short follow-up ("actually walking only")
  // can be resolved as a refinement of it server-side — cleared only by a fresh confident
  // parse replacing it, never by a downstream search failure, since the parse itself was fine.
  const lastIntentRef = useRef<ParsedNearbyQuery | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: PersistedNearbyChat = JSON.parse(raw);
        const restored = parsed.messages.map(reviveMessage);
        setMessages(restored);
        lastIntentRef.current = parsed.lastIntent;
        nextId.current = restored.length;
      })
      .catch(() => {});
  }, []);

  function appendMessage(message: NewChatMessage) {
    nextId.current += 1;
    setMessages((prev) => {
      const next = [...prev, { ...message, id: `msg-${nextId.current}` } as ChatMessage];
      const toSave: PersistedNearbyChat = { messages: next, lastIntent: lastIntentRef.current };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toSave)).catch(() => {});
      return next;
    });
  }

  // --- Clear Chat ---
  // A conversation that only ever grows, with no way back to a blank slate, stops reading as
  // disposable small talk and starts reading as a permanent record — this wipes both the
  // on-screen thread and its AsyncStorage backing, and drops the refinement context so the
  // next message is parsed as a fresh request rather than a follow-up to what was cleared.
  function confirmedClearChat() {
    setMessages([]);
    lastIntentRef.current = null;
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }

  function handleClearChat() {
    if (messages.length === 0) return;
    Alert.alert(t('nearby.clearChatConfirmTitle'), t('nearby.clearChatConfirmMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('nearby.clearChat'), style: 'destructive', onPress: confirmedClearChat },
    ]);
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={handleClearChat}
          disabled={messages.length === 0}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('nearby.clearChat')}
        >
          <Ionicons name="trash-outline" size={22} color={messages.length === 0 ? colors.border : colors.text} />
        </Pressable>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, messages.length, colors, t]);

  async function handleSearch() {
    const text = queryText.trim();
    if (!text || loading) return;
    setQueryText('');
    appendMessage({ role: 'user', text });
    setLoading(true);

    function withTimeout<T>(promise: Promise<T>): Promise<T> {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('nearby search step timed out')), SEARCH_TIMEOUT_MS)
      );
      return Promise.race([promise, timeout]);
    }

    let originEndpoint: JourneyEndpoint | null;
    try {
      originEndpoint = await withTimeout(getCurrentLocationEndpoint());
    } catch (err) {
      console.error('Nearby search: location fetch failed', err);
      appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.locationNeeded') });
      setLoading(false);
      return;
    }
    if (!originEndpoint || originEndpoint.kind !== 'coordinates') {
      appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.locationNeeded') });
      setLoading(false);
      return;
    }

    let intent;
    try {
      intent = await withTimeout(parseNearbyQuery(text, lastIntentRef.current));
    } catch (err) {
      console.error('Nearby search: query parsing failed', err);
      appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.loadError') });
      setLoading(false);
      return;
    }
    // Kept even when not confident — a clarifying question's answer is a follow-up to *this*
    // partial intent, so the next turn needs it as context to merge into, not a blank slate.
    lastIntentRef.current = intent;
    if (!intent.confident || !intent.category) {
      appendMessage(
        intent.clarifyingQuestion
          ? { role: 'assistant', kind: 'question', text: intent.clarifyingQuestion }
          : { role: 'assistant', kind: 'error', text: t('nearby.notUnderstood') }
      );
      setLoading(false);
      return;
    }

    // "Home" is a personal reference to the app's own saved address, never a business name to
    // geocode through Places — without this, "home" was being searched literally and matching
    // whatever nearby business happened to be named "Home" (e.g. a real "Home Cafe").
    let searchOrigin = { lat: originEndpoint.lat, lon: originEndpoint.lon, label: originEndpoint.label };
    if (intent.useSavedHome) {
      if (!homeAddress) {
        appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.homeNotSet') });
        setLoading(false);
        return;
      }
      const homeCoords = await resolveEndpointCoordinates(homeAddress);
      if (!homeCoords) {
        appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.loadError') });
        setLoading(false);
        return;
      }
      searchOrigin = { lat: homeCoords.lat, lon: homeCoords.lon, label: homeAddress.label };
    }

    let outcome;
    try {
      outcome = await withTimeout(searchNearby(searchOrigin, intent));
    } catch (err) {
      console.error('Nearby search: place search failed', err);
      appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.loadError') });
      setLoading(false);
      return;
    }
    if (outcome.results.length === 0) {
      appendMessage({ role: 'assistant', kind: 'error', text: t('nearby.noResults') });
      setLoading(false);
      return;
    }

    const resolvedOrigin: JourneyEndpoint = { kind: 'coordinates', lat: outcome.origin.lat, lon: outcome.origin.lon, label: outcome.originLabel };
    // Best-effort: the results themselves are the real value here, so a failed/slow
    // explanation call still shows them, just without the written blurb.
    let explanation: string | undefined;
    try {
      explanation = await withTimeout(explainResults(text, outcome.results, outcome.departureTime !== null));
    } catch (err) {
      console.error('Nearby search: explanation failed', err);
    }
    appendMessage({
      role: 'assistant',
      kind: 'results',
      results: outcome.results,
      origin: resolvedOrigin,
      usedReferenceLocation: outcome.usedReferenceLocation,
      departureTime: outcome.departureTime,
      explanation,
    });
    setLoading(false);
  }

  function handleSelectResult(origin: JourneyEndpoint, departureTime: Date | null, result: NearbySearchResult) {
    navigation.navigate('JourneyPlanner', {
      restoredFrom: origin,
      restoredTo: { kind: 'coordinates', lat: result.lat, lon: result.lon, label: result.name },
      ...(departureTime ? { restoredDepartureTime: departureTime.toISOString() } : {}),
      autoSearch: true,
    });
  }

  function renderMessage({ item }: { item: ChatMessage }) {
    if (item.role === 'user') {
      return (
        <View style={styles.userRow}>
          <View style={styles.userBubble}>
            <Text style={styles.userBubbleText}>{item.text}</Text>
          </View>
        </View>
      );
    }
    if (item.kind === 'error') {
      return (
        <View style={styles.assistantRow}>
          <View style={styles.assistantBubble}>
            <Text style={styles.assistantErrorText}>{item.text}</Text>
          </View>
        </View>
      );
    }
    if (item.kind === 'question') {
      return (
        <View style={styles.assistantRow}>
          <View style={styles.assistantBubble}>
            <Text style={styles.assistantQuestionText}>{item.text}</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.assistantRow}>
        <View style={[styles.assistantBubble, styles.resultsBubble]}>
          {(item.usedReferenceLocation || !!item.departureTime) && (
            <View style={styles.contextRow}>
              {item.usedReferenceLocation && (
                <View style={styles.contextChip}>
                  <Ionicons name="location-outline" size={12} color={colors.textMuted} />
                  <Text style={styles.contextChipText}>{item.origin.label}</Text>
                </View>
              )}
              {!!item.departureTime && (
                <View style={styles.contextChip}>
                  <Ionicons name="time-outline" size={12} color={colors.textMuted} />
                  <Text style={styles.contextChipText}>{formatDepartureLabel(item.departureTime, isKorean, t)}</Text>
                </View>
              )}
            </View>
          )}
          {!!item.explanation && <Text style={styles.explanationText}>{item.explanation}</Text>}
          {item.results.map((result) => (
            <View key={result.id} style={styles.resultRowOuter}>
              <AnimatedPressable
                scaleTo={0.98}
                style={styles.resultRow}
                onPress={() => handleSelectResult(item.origin, item.departureTime, result)}
              >
                <Ionicons name={result.mode === 'WALK' ? 'walk-outline' : 'bus-outline'} size={22} color={colors.rose} />
                <View style={styles.resultMain}>
                  <View style={styles.resultNameRow}>
                    <Text style={styles.resultName} numberOfLines={1}>
                      {result.name}
                    </Text>
                    {result.rating != null && (
                      <View style={styles.ratingRow}>
                        <Ionicons name="star" size={12} color={colors.amber} />
                        <Text style={styles.ratingText}>
                          {result.rating.toFixed(1)}
                          {result.userRatingCount != null ? ` (${result.userRatingCount})` : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.resultSubtitle}>{formatSubtitle(result, t)}</Text>
                  {result.isOpenNow != null && (
                    <Text style={[styles.hoursText, result.isOpenNow ? styles.hoursOpenText : styles.hoursClosedText]}>
                      {/* When a day/time was asked about, the status is for that moment — "now" would be wrong. */}
                      {result.isOpenNow
                        ? t(item.departureTime ? 'nearby.open' : 'nearby.openNow')
                        : t(item.departureTime ? 'nearby.closed' : 'nearby.closedNow')}
                      {result.todayHoursText ? ` · ${result.todayHoursText}` : ''}
                    </Text>
                  )}
                  {!!result.editorialSummary && (
                    <Text style={styles.resultSummary} numberOfLines={2}>
                      {result.editorialSummary}
                    </Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </AnimatedPressable>
              {!!result.mapsUri && (
                <Pressable
                  style={styles.mapsLinkButton}
                  onPress={() => Linking.openURL(result.mapsUri!)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('nearby.viewOnMaps')}
                >
                  <Ionicons name="open-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.mapsLinkText}>{t('nearby.viewOnMaps')}</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={<Text style={styles.hint}>{t('nearby.hint')}</Text>}
        ListFooterComponent={loading ? <ActivityIndicator style={styles.loader} color={colors.primary} /> : null}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <View style={[styles.inputRow, { paddingBottom: insets.bottom + spacing.sm }]}>
        <TextInput
          style={styles.input}
          placeholder={t('nearby.placeholder')}
          placeholderTextColor={colors.textMuted}
          value={queryText}
          onChangeText={setQueryText}
          onSubmitEditing={handleSearch}
          returnKeyType="send"
          editable={!loading}
        />
        <AnimatedPressable style={styles.searchButton} onPress={handleSearch} disabled={!queryText.trim() || loading}>
          <Ionicons name="send" size={20} color="#FFFFFF" />
        </AnimatedPressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    messageList: { padding: spacing.lg, flexGrow: 1, gap: spacing.sm },
    hint: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: spacing.lg },
    loader: { marginTop: spacing.sm },
    userRow: { alignItems: 'flex-end' },
    userBubble: {
      maxWidth: '85%',
      backgroundColor: colors.primary,
      borderRadius: radius.lg,
      borderBottomRightRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    userBubbleText: { color: '#FFFFFF', fontSize: 15 },
    assistantRow: { alignItems: 'flex-start' },
    assistantBubble: {
      maxWidth: '85%',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      borderBottomLeftRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    assistantErrorText: { color: colors.danger, fontSize: 14 },
    assistantQuestionText: { color: colors.text, fontSize: 14, lineHeight: 20 },
    contextRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.xs },
    contextChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.primaryMuted,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    contextChipText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
    explanationText: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: spacing.xs },
    // Overrides assistantBubble's maxWidth: a shrink-to-fit bubble with no definite width
    // gives resultRow's flex:1 text column nothing to expand into, collapsing it to zero —
    // this needs a real width for that to resolve, unlike a plain text bubble.
    resultsBubble: { alignSelf: 'stretch', maxWidth: undefined, width: '100%', gap: spacing.sm, padding: spacing.sm },
    resultRowOuter: {
      alignSelf: 'stretch',
      backgroundColor: colors.background,
      borderRadius: radius.md,
    },
    resultRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    resultMain: { flex: 1 },
    resultNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    resultName: { flexShrink: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
    ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    ratingText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
    resultSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
    hoursText: { fontSize: 12, marginTop: 2, fontWeight: '600' },
    hoursOpenText: { color: colors.success },
    hoursClosedText: { color: colors.danger },
    resultSummary: { color: colors.textMuted, fontSize: 12, marginTop: 3, fontStyle: 'italic' },
    mapsLinkButton: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.sm,
    },
    mapsLinkText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
    },
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: 15,
      color: colors.text,
    },
    searchButton: {
      backgroundColor: colors.primary,
      borderRadius: radius.md,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
