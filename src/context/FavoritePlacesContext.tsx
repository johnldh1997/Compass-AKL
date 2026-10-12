import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { FavoritePlace, JourneyEndpoint } from '../types';

const STORAGE_KEY = 'auckland-transit:favorite-places';

interface FavoritePlacesContextValue {
  places: FavoritePlace[];
  loading: boolean;
  isFavorite: (endpoint: JourneyEndpoint) => boolean;
  addPlace: (endpoint: JourneyEndpoint) => void;
  removePlace: (id: string) => void;
  removeByEndpoint: (endpoint: JourneyEndpoint) => void;
  // An empty or blank name clears it.
  setNickname: (id: string, nickname: string) => void;
}

const FavoritePlacesContext = createContext<FavoritePlacesContextValue | undefined>(undefined);

function endpointKey(endpoint: JourneyEndpoint): string {
  return endpoint.kind === 'place' ? `place:${endpoint.placeId}` : `coords:${endpoint.lat}:${endpoint.lon}`;
}

export function FavoritePlacesProvider({ children }: { children: React.ReactNode }) {
  const [places, setPlaces] = useState<FavoritePlace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setPlaces(JSON.parse(raw));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!loading) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(places));
    }
  }, [places, loading]);

  const value = useMemo<FavoritePlacesContextValue>(
    () => ({
      places,
      loading,
      isFavorite: (endpoint) => places.some((p) => endpointKey(p.endpoint) === endpointKey(endpoint)),
      addPlace: (endpoint) =>
        setPlaces((prev) =>
          prev.some((p) => endpointKey(p.endpoint) === endpointKey(endpoint))
            ? prev
            : [...prev, { id: endpointKey(endpoint), endpoint, addedAt: Date.now() }]
        ),
      removePlace: (id) => setPlaces((prev) => prev.filter((p) => p.id !== id)),
      removeByEndpoint: (endpoint) =>
        setPlaces((prev) => prev.filter((p) => endpointKey(p.endpoint) !== endpointKey(endpoint))),
      setNickname: (id, nickname) =>
        setPlaces((prev) =>
          prev.map((p) => {
            if (p.id !== id) return p;
            const { nickname: _old, ...rest } = p;
            const trimmed = nickname.trim();
            return trimmed ? { ...rest, nickname: trimmed } : rest;
          })
        ),
    }),
    [places, loading]
  );

  return <FavoritePlacesContext.Provider value={value}>{children}</FavoritePlacesContext.Provider>;
}

export function useFavoritePlaces(): FavoritePlacesContextValue {
  const ctx = useContext(FavoritePlacesContext);
  if (!ctx) throw new Error('useFavoritePlaces must be used within FavoritePlacesProvider');
  return ctx;
}
