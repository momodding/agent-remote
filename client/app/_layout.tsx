import '../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { TabDeckProvider, useProvideTabStore } from '../src/lib/tabs/tab-store';

function Providers({ children }: { children: React.ReactNode }) {
  const store = useProvideTabStore();
  return <TabDeckProvider value={store}>{children}</TabDeckProvider>;
}
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>
        <Providers>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
        </Providers>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}
