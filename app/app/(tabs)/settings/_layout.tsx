import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

function BackChevron() {
  const router = useRouter();
  return (
    <Pressable
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={() => router.back()}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
      <Ionicons color="#000000" name="chevron-back" size={22} />
    </Pressable>
  );
}

const subpageOptions = {
  headerBackVisible: false,
  headerLeft: () => <BackChevron />,
};

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        animation: 'slide_from_right',
        animationMatchesGesture: true,
        fullScreenGestureEnabled: true,
        headerShadowVisible: false,
        headerTintColor: '#000000',
        headerTitleStyle: {
          color: '#000000',
        },
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
        }}
      />
      <Stack.Screen
        name="campuses"
        options={{
          title: 'Campuses',
          ...subpageOptions,
        }}
      />
      <Stack.Screen
        name="map-focus"
        options={{
          title: 'Map focus',
          ...subpageOptions,
        }}
      />
      <Stack.Screen
        name="relay"
        options={{
          title: 'Relay',
          ...subpageOptions,
        }}
      />
      <Stack.Screen
        name="latest-submission"
        options={{
          title: 'Latest submission',
          ...subpageOptions,
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  buttonPressed: {
    opacity: 0.6,
  },
});
