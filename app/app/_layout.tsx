import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ReporterProvider } from '@/context/reporter-context';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ReporterProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'fade',
          }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="report-camera"
          options={{
            presentation: 'fullScreenModal',
            animation: 'fade',
          }}
        />
        </Stack>
        <StatusBar style="dark" />
      </ReporterProvider>
    </GestureHandlerRootView>
  );
}
