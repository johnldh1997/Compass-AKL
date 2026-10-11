import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MODE_ICON } from '../services/markerIcon';
import { TransportMode } from '../types';

// --- Stop Marker Badge ---
// A stop's map marker: a white circle with a coloured ring, the mode icon, and a small label
// beneath it. Stops used to be a smaller copy of the same circle-plus-bus-icon a live vehicle
// is drawn with, so on a busy map one was easy to mistake for the other — the label says what
// it is outright, and `size` is meant to match the vehicle badge it sits alongside.
//
// The label is a fixed dark ink rather than the line colour: the badge's fill is always white
// (both themes), and several line colours — dark mode's light blue/orange especially — are too
// faint against white to read at this size. The ring and icon still carry the line colour.
const LABEL_INK = '#141B2E';
const RING_WIDTH = 2;

// Kept smaller than a vehicle's badge on purpose: in dense areas like the CBD, stops sit only a
// few metres apart and larger badges collapse into each other.
export const STOP_BADGE_SIZE = 32;

// Zoomed out, a full labelled badge per stop piles up into an unreadable blob, so callers can ask
// for a small plain dot instead — still obviously "a stop", and nothing like a vehicle's badge.
// Big enough (18) to remain a reasonable tap target for opening the stop's details.
const DOT_SIZE = 18;
const DOT_RING_WIDTH = 3;

interface Props {
  size: number;
  color: string;
  mode: TransportMode;
  label: string;
  compact?: boolean;
}

export default function StopBadge({ size, color, mode, label, compact }: Props) {
  if (compact) {
    return (
      <View
        style={[
          styles.badge,
          { width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2, borderColor: color, borderWidth: DOT_RING_WIDTH },
        ]}
      />
    );
  }
  const iconSize = Math.round(size * 0.38);
  const fontSize = Math.max(8, Math.round(size * 0.24));
  return (
    <View
      style={[
        styles.badge,
        { width: size, height: size, borderRadius: size / 2, borderColor: color, borderWidth: RING_WIDTH },
      ]}
    >
      <MaterialIcons name={MODE_ICON[mode]} size={iconSize} color={color} />
      <Text style={[styles.label, { fontSize, lineHeight: fontSize + 1 }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: LABEL_INK, fontWeight: '700', includeFontPadding: false },
});
