import { Tabs } from 'expo-router';
import React from 'react';
import { Ionicons } from '@expo/vector-icons';

import { palette } from '@/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.muted,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          height: 74,
          paddingBottom: 10,
          paddingTop: 10,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Reporter',
          tabBarIcon: ({ color, size }) => <Ionicons size={size} name="camera" color={color} />,
        }}
      />
      <Tabs.Screen
        name="robot"
        options={{
          title: 'Robot',
          tabBarIcon: ({ color, size }) => (
            <Ionicons size={size} name="navigate-circle" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
