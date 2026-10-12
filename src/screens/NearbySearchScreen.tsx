import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useHeaderHeight } from '@react-navigation/elements';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AnimatedPressable from '../components/AnimatedPressable';
import { useThemeColors } from '../context/ThemeContext';
import { TranslationKey } from '../i18n/translations';
import { useTranslation } from '../i18n/useTranslation';
import { useFavoritePlaces } from '../context/FavoritePlacesContext';
import { useHomeAddress } from '../context/HomeAddressContext';
import { useSettings } from '../context/SettingsContext';
import { clampToNow } from '../services/departureTime';
import { recentTurnsFrom } from '../services/nearbyConversation';
import { NearbySearchResult, ParsedNearbyQuery } from '../services/nearbySearch';
import { ProgressStep, runNearbyTurn, ShownSearch } from '../services/nearbyTurn';
import { radius, spacing, ThemeColors } from '../theme';
import { JourneyEndpoint, RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'NearbySearch'>;

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
    }
  // --- Written Summary ---
  // The reply that explains a results message, sent as its own follow-up bubble once it's ready.
  // Results used to wait for it (several seconds); and had it been inserted into the results
  // bubble instead, it would have pushed the list down mid-read — right as someone is about to
  // tap a row. Best-effort: a failed explain call just means no summary bubble follows.
  | { id: string; role: 'assistant'; kind: 'summary'; text: string };

// Plain Omit<ChatMessage, 'id'> collapses the union to its shared fields only — this
// distributes over each member instead, so each call site still gets its own shape checked.
type NewChatMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, 'id'> : never) : never;

function formatSubtitle(result: NearbySearchResult, t: ReturnType<typeof useTranslation>): string {
  if (result.mode === 'WALK') return t('nearby.walkMinutes', { minutes: result.durationMinutes });
  return result.routeShortName
    ? t('nearby.transitMinutesRoute', { minutes: result.durationMinutes, route: result.routeShortName })
    : t('nearby.transitMinutes', { minutes: result.durationMinutes });
}

// What Places confirms about a place beyond travel time — price and the two details a search can ask
// for. Only what's known is shown: a missing detail is "unknown", never "no".
function formatDetails(result: NearbySearchResult, t: ReturnType<typeof useTranslation>): string[] {
  const details: string[] = [];
  if (result.priceLevel != null && result.priceLevel >= 1) details.push('$'.repeat(result.priceLevel));
  if (result.servesVegetarianFood) details.push(t('nearby.vegetarian'));
  if (result.outdoorSeating) details.push(t('nearby.outdoorSeating'));
  return details;
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

// --- Progress Text ---
// What the spinner says while a search runs. 'writing' is the written summary: the results are
// already on screen by then, so it doesn't lock the input the way the earlier steps do.
const PROGRESS_KEYS: Record<ProgressStep, TranslationKey> = {
  locating: 'nearby.progress.locating',
  understanding: 'nearby.progress.understanding',
  searching: 'nearby.progress.searching',
  answering: 'nearby.progress.answering',
  writing: 'nearby.progress.writing',
};

// --- Example Prompts ---
// Shown on an empty chat; tapping one sends it as-is.
const EXAMPLE_KEYS: TranslationKey[] = ['nearby.example.1', 'nearby.example.2', 'nearby.example.3', 'nearby.example.4'];

// --- Quick Replies ---
// One-tap follow-ups under the latest answer. Each is sent as the user's own message, so the
// parser handles it like any typed refinement of the previous request (server/eval has a case for
// every one, in both languages). Only the ones that would actually change something are offered —
// no "Walking only" after a walking-only search.
const QUICK_REPLIES: { key: TranslationKey; show: (intent: ParsedNearbyQuery) => boolean }[] = [
  { key: 'nearby.chip.walking', show: (i) => i.modes.includes('TRANSIT') },
  { key: 'nearby.chip.openNow', show: (i) => i.targetDay === null && i.hour === null },
  { key: 'nearby.chip.best', show: (i) => i.rankBy !== 'best' },
  { key: 'nearby.chip.closest', show: (i) => i.rankBy === 'best' },
  { key: 'nearby.chip.within10', show: (i) => i.maxMinutes === null || i.maxMinutes > 10 },
  { key: 'nearby.chip.cheap', show: (i) => !i.wantsCheap },
  { key: 'nearby.chip.vegetarian', show: (i) => !i.wantsVegetarian },
  { key: 'nearby.chip.outdoor', show: (i) => !i.wantsOutdoorSeating },
];

export default function NearbySearchScreen({ navigation, route }: Props) {
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
  const { places: savedPlaces } = useFavoritePlaces();
  // Set when this chat was opened from a planned trip — where it ends, and when they'd get there.
  const journeyStop = route.params?.journeyStop;
  const [queryText, setQueryText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [progress, setProgress] = useState<ProgressStep | null>(null);
  // The input and chips lock while a search is actually running, but not while only the written
  // summary is still coming — the results are already on screen and usable by then.
  const loading = progress !== null && progress !== 'writing';
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // --- Auto Scroll ---
  // While a search runs, new content scrolls into view. Fresh results scroll to their top (the best
  // match first, not the last row) and then stop following, so a summary arriving later doesn't yank
  // the list away from what's being read. Following resumes only when the reader themselves scrolls
  // back to the bottom, or sends something new.
  const followBottomRef = useRef(true);
  const scrollToResultsRef = useRef(false);
  // The end of a scroll animation we started ourselves also fires onMomentumScrollEnd on Android —
  // that must not count as the reader choosing to sit at the bottom.
  const programmaticScrollRef = useRef(false);
  const messageCountRef = useRef(0);
  messageCountRef.current = messages.length;
  // Which search a late summary belongs to — a newer search started meanwhile makes it stale.
  const searchSeqRef = useRef(0);
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

  // The search the chat is currently showing — what a follow-up question or action ("which is best
  // rated?", "take me to the second one") refers to. Null on a fresh chat.
  function latestShownSearch(): ShownSearch | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'assistant' && message.kind === 'results') {
        return { results: message.results, origin: message.origin, departureTime: message.departureTime };
      }
    }
    return null;
  }

  // Used by the text box, the example prompts and the quick replies alike. The thinking happens in
  // runNearbyTurn (services/nearbyTurn.ts); this only draws what it reports and carries out the
  // navigation it asks for.
  async function runSearch(rawText: string) {
    const text = rawText.trim();
    if (!text || loading) return;
    setQueryText('');
    followBottomRef.current = true;
    const searchSeq = ++searchSeqRef.current;
    // Gathered before the user's message is appended, so the turns passed along are the ones before it.
    const input = {
      text,
      lastIntent: lastIntentRef.current,
      shown: latestShownSearch(),
      recentTurns: recentTurnsFrom(messages),
      savedPlaces,
      homeAddress,
      journeyStop: journeyStop ?? null,
    };
    appendMessage({ role: 'user', text });

    await runNearbyTurn(input, {
      t,
      setProgress,
      emit: (output) => {
        if (output.kind === 'results') scrollToResultsRef.current = true;
        appendMessage({ role: 'assistant', ...output });
      },
      setLastIntent: (intent) => {
        lastIntentRef.current = intent;
      },
      openDirections: ({ origin, departureTime, result }) => handleSelectResult(origin, departureTime, result),
      openUrl: (url) => Linking.openURL(url).catch(() => {}),
      isCurrent: () => searchSeqRef.current === searchSeq,
    });
  }

  function handleSubmit() {
    runSearch(queryText);
  }

  // Only the reader's own scrolling counts here — the programmatic scrolls above don't fire these.
  function handleReaderScrolled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    if (programmaticScrollRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    followBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 160;
  }

  function handleContentSizeChange() {
    if (scrollToResultsRef.current) {
      scrollToResultsRef.current = false;
      followBottomRef.current = false;
      // A row can't be scrolled to until it has been measured, which happens just after this fires —
      // and by then the message count is the up-to-date one, not what this render saw.
      setTimeout(() => {
        programmaticScrollRef.current = true;
        listRef.current?.scrollToIndex({ index: messageCountRef.current - 1, viewPosition: 0, animated: true });
      }, 150);
    } else if (followBottomRef.current) {
      programmaticScrollRef.current = true;
      listRef.current?.scrollToEnd({ animated: true });
    }
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
    if (item.kind === 'summary') {
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
                  <Text style={styles.resultSubtitle}>{[formatSubtitle(result, t), ...formatDetails(result, t)].join(' · ')}</Text>
                  {result.isOpenOnArrival != null && (
                    <Text
                      style={[
                        styles.hoursText,
                        !result.isOpenOnArrival ? styles.hoursClosedText : result.closesInMinutes != null ? styles.hoursClosingText : styles.hoursOpenText,
                      ]}
                    >
                      {/* Judged at the moment the user would arrive (departure + travel time), not now. */}
                      {!result.isOpenOnArrival
                        ? t('nearby.closedOnArrival')
                        : result.closesInMinutes != null
                          ? t('nearby.closesAfterArrival', { count: result.closesInMinutes })
                          : t('nearby.open')}
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

  // --- Quick Replies ---
  // Under the latest answer only, and only for a request the parser actually understood.
  function renderQuickReplies() {
    const intent = lastIntentRef.current;
    const last = messages[messages.length - 1];
    if (!intent?.confident || last?.role !== 'assistant' || (last.kind !== 'results' && last.kind !== 'summary')) return null;
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {QUICK_REPLIES.filter((reply) => reply.show(intent)).map((reply) => (
          <AnimatedPressable key={reply.key} scaleTo={0.95} style={styles.chip} onPress={() => runSearch(t(reply.key))}>
            <Text style={styles.chipText}>{t(reply.key)}</Text>
          </AnimatedPressable>
        ))}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      {/* --- Planned Trip Context --- */}
      {!!journeyStop && (
        <View style={styles.tripBanner}>
          <Ionicons name="flag-outline" size={14} color={colors.primary} />
          <Text style={styles.tripBannerText} numberOfLines={2}>
            {t('nearby.journeyContext', {
              stop: journeyStop.name,
              time: formatDepartureLabel(clampToNow(new Date(journeyStop.arrivalIso)), isKorean, t),
            })}
          </Text>
        </View>
      )}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={
          <View>
            <Text style={styles.hint}>{t('nearby.hint')}</Text>
            <View style={styles.exampleList}>
              {(journeyStop ? (['nearby.example.journey', ...EXAMPLE_KEYS.slice(0, 3)] as TranslationKey[]) : EXAMPLE_KEYS).map((key) => (
                <AnimatedPressable key={key} scaleTo={0.98} style={styles.exampleRow} onPress={() => runSearch(t(key))}>
                  <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
                  <Text style={styles.exampleText}>{t(key)}</Text>
                </AnimatedPressable>
              ))}
            </View>
            {/* --- Privacy Note --- What leaves the phone to make this chat work. */}
            <Text style={styles.privacyNote}>{t('nearby.privacy')}</Text>
          </View>
        }
        ListFooterComponent={
          progress ? (
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.progressText}>{t(PROGRESS_KEYS[progress])}</Text>
            </View>
          ) : (
            renderQuickReplies()
          )
        }
        onScrollBeginDrag={() => {
          programmaticScrollRef.current = false;
        }}
        onScrollEndDrag={handleReaderScrolled}
        onMomentumScrollEnd={handleReaderScrolled}
        onContentSizeChange={handleContentSizeChange}
        onScrollToIndexFailed={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <View style={[styles.inputRow, { paddingBottom: insets.bottom + spacing.sm }]}>
        <TextInput
          style={styles.input}
          placeholder={t('nearby.placeholder')}
          placeholderTextColor={colors.textMuted}
          value={queryText}
          onChangeText={setQueryText}
          onSubmitEditing={handleSubmit}
          returnKeyType="send"
          editable={!loading}
        />
        <AnimatedPressable style={styles.searchButton} onPress={handleSubmit} disabled={!queryText.trim() || loading}>
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
    privacyNote: { color: colors.textMuted, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: spacing.lg },
    tripBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: colors.primaryMuted,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    tripBannerText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: '600' },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
    progressText: { color: colors.textMuted, fontSize: 13 },
    exampleList: { marginTop: spacing.lg, gap: spacing.sm },
    exampleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    exampleText: { flex: 1, color: colors.text, fontSize: 14 },
    chipRow: { gap: spacing.sm, paddingVertical: spacing.xs },
    chip: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    chipText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
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
    hoursClosingText: { color: colors.amber },
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
