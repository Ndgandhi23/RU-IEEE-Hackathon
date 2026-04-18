import { Tabs, useRouter } from 'expo-router';
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

export default function TabLayout() {
  const router = useRouter();

  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        animation: 'fade',
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.muted,
        tabBarStyle: {
          backgroundColor: 'rgba(255,253,248,0.98)',
          borderTopColor: '#D9D3C6',
          height: 78,
          paddingBottom: 10,
          paddingTop: 10,
        },
      }}>
      <Tabs.Screen
        name="report"
        options={{
          title: 'Report',
          tabBarActiveTintColor: palette.primary,
          tabBarIcon: ({ color, size }) => (
            <Ionicons size={size} name="camera-outline" color={color} />
          ),
          tabBarButton: () => (
            <Pressable onPress={() => router.push('/report-camera')} style={styles.reportTabButton}>
              <View style={styles.reportTabIconWrap}>
                <Ionicons color={palette.primary} name="camera-outline" size={22} />
              </View>
              <Text style={styles.reportTabLabel}>Report</Text>
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Map',
          tabBarIcon: ({ color, size }) => <Ionicons size={size} name="map" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons size={size} name="settings-outline" color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  reportTabButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  reportTabIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  reportTabLabel: {
    color: palette.primary,
    fontSize: 10,
    fontWeight: '600',
  },
});
