import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { createNavigationContainerRef, NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import BackButton from './src/components/BackButton';
import { FavoritePlacesProvider } from './src/context/FavoritePlacesContext';
import { FavoritesProvider } from './src/context/FavoritesContext';
import { DismissedAlertsProvider } from './src/context/DismissedAlertsContext';
import { FavoriteTripsProvider } from './src/context/FavoriteTripsContext';
import { HomeAddressProvider } from './src/context/HomeAddressContext';
import { ReadAlertsProvider } from './src/context/ReadAlertsContext';
import { RecentPlacesProvider } from './src/context/RecentPlacesContext';
import { RecentTripsProvider } from './src/context/RecentTripsContext';
import { SettingsProvider } from './src/context/SettingsContext';
import { ThemeProvider, useThemeColors, useThemeScheme } from './src/context/ThemeContext';
import { useTranslation } from './src/i18n/useTranslation';
import { loadActiveJourney } from './src/services/activeJourney';
import AboutScreen from './src/screens/AboutScreen';
import AddFavoriteScreen from './src/screens/AddFavoriteScreen';
import AlertsScreen from './src/screens/AlertsScreen';
import ChooseOnMapScreen from './src/screens/ChooseOnMapScreen';
import FavoritesScreen from './src/screens/FavoritesScreen';
import HomeScreen from './src/screens/HomeScreen';
import JourneyPlannerScreen from './src/screens/JourneyPlannerScreen';
import MyTripsScreen from './src/screens/MyTripsScreen';
import NearbySearchScreen from './src/screens/NearbySearchScreen';
import SearchStopsScreen from './src/screens/SearchStopsScreen';
import SetHomeAddressScreen from './src/screens/SetHomeAddressScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import StopDetailScreen from './src/screens/StopDetailScreen';
import { darkColors, lightColors } from './src/theme';
import { RootStackParamList } from './src/types';

const Stack = createNativeStackNavigator<RootStackParamList>();
// Module-level (not per-render) so the onReady callback below always has a stable ref to
// imperatively navigate through, the same way React Navigation's own docs use it outside
// the component tree.
const navigationRef = createNavigationContainerRef<RootStackParamList>();

export default function App() {
  // Only used for this component's own pre-provider loading gate below — SettingsContext
  // (and therefore the real ThemeContext, which needs a theme-mode setting to read) isn't
  // mounted yet at this point, so this brief splash falls back to the system scheme.
  const systemScheme = useColorScheme();
  const loadingColors = systemScheme === 'dark' ? darkColors : lightColors;

  // Map markers (stops/vehicles) render a MaterialIcons glyph (or, for a zoomed-out bus stop,
  // a MaterialCommunityIcons bus-stop sign) as their custom marker
  // view. That icon component renders blank on its very first frame until its font
  // finishes an async load — react-native-maps on Android snapshots whatever a custom
  // marker looked like at that first frame, so a marker that mounts before the font is
  // ready gets stuck showing the SDK's default red pin instead of the icon badge (only
  // fixed by a later remount, e.g. from panning/zooming). Loading the font up front
  // means it's already ready before any marker ever mounts.
  // A font that fails to load must not leave the app stuck on the loading screen forever — a
  // missing glyph is far better than an app that never opens — so an error counts as "done".
  const [fontsReady, fontError] = useFonts({ ...MaterialIcons.font, ...MaterialCommunityIcons.font });
  const fontsLoaded = fontsReady || !!fontError;

  // By default, expo-updates only downloads a newer OTA update in the background on
  // launch — it doesn't apply to the app instance that's currently running, only on the
  // *next* cold start after the download finishes. That one-cycle lag was confusing
  // during active testing (a fix would look "not applied" because the app was still
  // showing the update from before). Checking, fetching, and reloading synchronously
  // here means a single close-and-reopen always lands on the latest published update.
  const [updateChecked, setUpdateChecked] = useState(false);
  const [updateStatus, setUpdateStatus] = useState('Checking for updates…');
  useEffect(() => {
    async function checkForUpdate() {
      if (!Updates.isEnabled) {
        setUpdateChecked(true);
        return;
      }
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          setUpdateStatus('Downloading update…');
          await Updates.fetchUpdateAsync();
          setUpdateStatus('Restarting…');
          await Updates.reloadAsync();
          return;
        }
      } catch (err) {
        console.warn('Update check failed:', err);
      }
      setUpdateChecked(true);
    }
    checkForUpdate();
  }, []);

  if (!fontsLoaded || !updateChecked) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: loadingColors.background,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
        }}
      >
        <ActivityIndicator size="large" color={loadingColors.primary} />
        <Text style={{ color: loadingColors.textMuted, fontSize: 13 }}>
          {updateChecked ? 'Loading…' : updateStatus}
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ThemeProvider>
          <FavoritesProvider>
            <FavoritePlacesProvider>
              <HomeAddressProvider>
                <RecentPlacesProvider>
                  <FavoriteTripsProvider>
                    <RecentTripsProvider>
                      <ReadAlertsProvider>
                        <DismissedAlertsProvider>
                          <AppContent />
                        </DismissedAlertsProvider>
                      </ReadAlertsProvider>
                    </RecentTripsProvider>
                  </FavoriteTripsProvider>
                </RecentPlacesProvider>
              </HomeAddressProvider>
            </FavoritePlacesProvider>
          </FavoritesProvider>
        </ThemeProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

// Reads the real theme (settings-driven: light/dark/ambient-auto) rather than the raw
// system scheme, so the nav header and status bar always match the rest of the app.
function AppContent() {
  const colors = useThemeColors();
  const isDark = useThemeScheme() === 'dark';
  const t = useTranslation();
  const navTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      background: colors.background,
      card: colors.surface,
      primary: colors.primary,
      text: colors.text,
      border: colors.border,
    },
  };

  return (
    <>
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={() => {
          // Home is always the root — a journey in progress is a screen pushed on top of
          // it, not the root itself, so BackButton/hardware-back still lands on Home like
          // every other push, rather than a dead end with nowhere to go back to.
          loadActiveJourney().then((data) => {
            if (data && navigationRef.isReady()) navigationRef.navigate('JourneyPlanner');
          });
        }}
      >
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            headerLeft: () => <BackButton />,
            // Native-stack's Android default is a fade — forcing a consistent slide on
            // both platforms reads as more deliberate/smoother than the platform default.
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Favorites" component={FavoritesScreen} options={{ title: t('menu.favourites') }} />
          <Stack.Screen name="AddFavorite" component={AddFavoriteScreen} options={{ title: t('nav.addFavourite') }} />
          <Stack.Screen name="StopDetail" component={StopDetailScreen} options={{ title: '' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: t('menu.settings') }} />
          <Stack.Screen name="About" component={AboutScreen} options={{ title: t('menu.about') }} />
          <Stack.Screen name="JourneyPlanner" component={JourneyPlannerScreen} options={{ title: t('journey.planAJourney') }} />
          {/* Pick-something-and-return flow — a rising sheet reads as more "modal" than a
              same-style push, so it's obvious this is a quick detour, not a new section. */}
          <Stack.Screen
            name="ChooseOnMap"
            component={ChooseOnMapScreen}
            options={{ title: t('nav.chooseLocation'), presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="MyTrips" component={MyTripsScreen} options={{ title: t('menu.myTrips') }} />
          <Stack.Screen name="NearbySearch" component={NearbySearchScreen} options={{ title: t('menu.nearbySearch') }} />
          <Stack.Screen name="SearchStops" component={SearchStopsScreen} options={{ title: t('menu.searchStops') }} />
          <Stack.Screen name="Alerts" component={AlertsScreen} options={{ title: t('nav.serviceAlerts') }} />
          <Stack.Screen
            name="SetHomeAddress"
            component={SetHomeAddressScreen}
            options={{ title: t('nav.homeAddress'), presentation: 'modal', animation: 'slide_from_bottom' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </>
  );
}
