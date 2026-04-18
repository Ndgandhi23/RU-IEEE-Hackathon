import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        animation: 'slide_from_right',
        animationMatchesGesture: true,
        fullScreenGestureEnabled: true,
        headerBackTitle: 'Settings',
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: '#F2F2F7',
        },
        contentStyle: {
          backgroundColor: '#F2F2F7',
        },
      }}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
          headerLargeTitle: true,
        }}
      />
      <Stack.Screen
        name="universities"
        options={{
          title: 'Universities',
        }}
      />
      <Stack.Screen
        name="map-focus"
        options={{
          title: 'Map focus',
        }}
      />
      <Stack.Screen
        name="relay"
        options={{
          title: 'Relay',
        }}
      />
      <Stack.Screen
        name="latest-submission"
        options={{
          title: 'Latest submission',
        }}
      />
    </Stack>
  );
}
