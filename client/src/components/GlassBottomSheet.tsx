import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, Text, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetBackgroundProps,
} from '@gorhom/bottom-sheet';
import { BlurView } from 'expo-blur';

export type GlassBottomSheetHandle = { present: () => void; dismiss: () => void };

type Props = {
  title: string;
  onDismiss?: () => void;
  children: React.ReactNode; // caller supplies BottomSheetScrollView content
};

const GLASS_BLUR_INTENSITY = 90;

export const GlassBottomSheet = forwardRef<GlassBottomSheetHandle, Props>(function GlassBottomSheet(
  { title, onDismiss, children },
  ref,
) {
  const colorScheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => ['55%', '100%'], []);
  const sheetRef = useRef<BottomSheetModal>(null);

  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }));

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing={false}
      snapPoints={snapPoints}
      topInset={insets.top}
      bottomInset={insets.bottom}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={onDismiss}
      handleIndicatorStyle={{ backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)' }}
      backdropComponent={(props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop {...props} opacity={0.55} enableTouchThrough={false} pressBehavior="close" />
      )}
      backgroundComponent={({ style }: BottomSheetBackgroundProps) => (
        <BlurView
          intensity={GLASS_BLUR_INTENSITY}
          tint={colorScheme === 'dark' ? 'dark' : 'light'}
          style={[styles.glassBackground, { backgroundColor: colorScheme === 'dark' ? 'rgba(10,10,10,0.82)' : 'rgba(250,250,250,0.86)' }, style]}
        />
      )}
    >
      <BottomSheetView style={styles.header}>
        <Text style={{ color: colorScheme === 'dark' ? '#F0F0F0' : '#1A1A1A', fontSize: 20, fontWeight: '700' }}>{title}</Text>
      </BottomSheetView>
      {children}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  glassBackground: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
});
