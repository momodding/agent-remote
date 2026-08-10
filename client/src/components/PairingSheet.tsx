import { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator } from 'react-native';

import { parsePairingPayload } from '../lib/auth';
import type { PairingPayload } from '../protocol';

type Props = { visible: boolean; onDismiss: () => void; onConnect: (payload: PairingPayload, clientName: string, onStage: (message: string) => void) => Promise<void> };

// Camera readiness beyond the OS permission grant: unknown while checking, then available/unavailable.
type Availability = 'checking' | 'available' | 'unavailable';

type Palette = { text: string; textSecondary: string; border: string; accent: string; warning: string; surface: string };

function usePalette(): Palette {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark'
    ? { text: '#F0F0F0', textSecondary: '#B8B8B8', border: '#3A3A3A', accent: '#264E54', warning: '#D19A2C', surface: '#181818' }
    : { text: '#1A1A1A', textSecondary: '#5A5A5A', border: '#D0D0D0', accent: '#B7D8DB', warning: '#8A5B10', surface: '#EDEDED' };
}

export function PairingSheet({ visible, onDismiss, onConnect }: Props) {
  const palette = usePalette();
  const wasVisible = useRef(false);
  const [name, setName] = useState('phone');
  const [payloadText, setPayloadText] = useState('');
  const [scan, setScan] = useState(false);
  const [skip, setSkip] = useState(false);
  const [availability, setAvailability] = useState<Availability>('checking');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const scanLock = useRef(false);

  useEffect(() => {
    if (wasVisible.current && !visible) {
      setScan(false);
      setAvailability('checking');
      scanLock.current = false;
    }
    wasVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!scan || !permission?.granted) return;
    if (Platform.OS !== 'web') { setAvailability('available'); return; }
    let cancelled = false;
    setAvailability('checking');
    CameraView.isAvailableAsync()
      .then((ok) => { if (!cancelled) setAvailability(ok ? 'available' : 'unavailable'); })
      .catch(() => { if (!cancelled) setAvailability('unavailable'); });
    return () => { cancelled = true; };
  }, [scan, permission?.granted]);

  

  const openScan = () => {
    if (busy) return;
    setAvailability('checking');
    scanLock.current = false;
    setScan(true);
  };

  const usePastedJSON = () => {
    if (!busy) setScan(false);
  };

  const dismiss = () => {
    if (!busy) onDismiss();
  };

  const connect = async (raw: string): Promise<boolean> => {
    try {
      const payload = parsePairingPayload(raw);
      setStage('Starting…');
      await onConnect({ ...payload, skipFingerprintVerification: skip || payload.skipFingerprintVerification }, name, setStage);
      onDismiss();
      return true;
    } catch (error) {
      setStage('');
      console.error('[pairing] connect failed:', error);
      Alert.alert('Pairing failed', error instanceof Error ? error.message : 'Invalid pairing data');
      return false;
    }
  };

  const onScanned = (data: string) => {
    if (scanLock.current) return;
    scanLock.current = true;
    setBusy(true);
    void connect(data).finally(() => {
      setBusy(false);
      scanLock.current = false;
    });
  };

  const onPaste = () => {
    if (busy) return;
    setBusy(true);
    void connect(payloadText).finally(() => setBusy(false));
  };

  const renderCamera = () => {
    if (permission === null) {
      return <View style={[styles.camera, { backgroundColor: palette.surface }]}><Text style={[styles.cameraStatus, { color: palette.textSecondary }]} accessibilityLabel="camera-loading">Checking camera permission…</Text></View>;
    }
    if (!permission.granted && permission.canAskAgain) {
      return (
        <View style={[styles.camera, { backgroundColor: palette.surface }]}>
          <Pressable style={[styles.primary, { backgroundColor: palette.warning }]} accessibilityLabel="allow-camera" onPress={() => void requestPermission()}>
            <Feather name="camera" size={20} color="#0A0A0A" />
          </Pressable>
        </View>
      );
    }
    if (!permission.granted) {
      return (
        <View style={[styles.camera, { backgroundColor: palette.surface }]}>
          <Text style={[styles.cameraStatus, { color: palette.textSecondary }]}>Camera access was denied. Enable it in system settings to scan.</Text>
          <Pressable style={[styles.primary, { backgroundColor: palette.warning }]} accessibilityLabel="open-camera-settings" onPress={() => void Linking.openSettings()}>
            <Feather name="external-link" size={20} color="#0A0A0A" />
          </Pressable>
        </View>
      );
    }
    if (availability === 'checking') {
      return <View style={[styles.camera, { backgroundColor: palette.surface }]}><Text style={[styles.cameraStatus, { color: palette.textSecondary }]} accessibilityLabel="camera-checking">Checking camera availability…</Text></View>;
    }
    if (availability === 'unavailable') {
      return (
        <View style={[styles.camera, { backgroundColor: palette.surface }]}>
          <Text style={[styles.cameraStatus, { color: palette.textSecondary }]}>Camera is unavailable right now.</Text>
          <Pressable style={[styles.primary, { backgroundColor: palette.warning }]} accessibilityLabel="retry-camera" onPress={openScan}>
            <Feather name="refresh-cw" size={20} color="#0A0A0A" />
          </Pressable>
        </View>
      );
    }
    if (busy) {
      return <View style={[styles.camera, { backgroundColor: palette.surface }]}><ActivityIndicator color={palette.textSecondary} style={{ marginBottom: 10 }} /><Text style={[styles.cameraStatus, { color: palette.textSecondary }]} accessibilityLabel="camera-connecting">{stage || 'Connecting…'}</Text></View>;
    }
    return (
      <View style={[styles.camera, { backgroundColor: palette.surface }]}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScanned(data)}
          onMountError={() => setAvailability('unavailable')}
        />
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={dismiss}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: palette.surface }]}>
        <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: palette.text }]}>Connect a daemon</Text>
              <Pressable accessibilityLabel="cancel-pairing" disabled={busy} onPress={dismiss} style={styles.iconBtn}><Feather name="x" size={24} color={palette.text} /></Pressable>
            </View>
            <Text style={[styles.hint, { color: palette.textSecondary }]}>Give this device a name, then scan or paste the temporary pairing payload.</Text>
            <TextInput style={[styles.input, { color: palette.text, borderColor: palette.border }]} value={name} onChangeText={setName} placeholder="Device name" placeholderTextColor="#888" autoCapitalize="none" editable={!busy} />
            <View style={styles.row}><Text style={[styles.label, { color: palette.text }]}>Skip fingerprint verification</Text><Switch value={skip} onValueChange={setSkip} disabled={busy} /></View>
            <Text style={[styles.warning, { color: palette.warning }]}>Expo Go cannot dynamically trust a self-signed daemon certificate. Direct LAN pairing must enable this option.</Text>
            {scan ? (
              <>
                {renderCamera()}
                <Pressable style={[styles.secondary, { backgroundColor: palette.accent }]} accessibilityLabel="use-pasted-json" disabled={busy} onPress={usePastedJSON}><Feather name="clipboard" size={20} color={palette.text} /></Pressable>
              </>
            ) : (
              <>
                <Pressable style={[styles.secondary, { backgroundColor: palette.accent }]} accessibilityLabel="Scan QR code" disabled={busy} onPress={openScan}><Feather name="camera" size={20} color={palette.text} /></Pressable>
                <TextInput style={[styles.input, styles.payload, { color: palette.text, borderColor: palette.border }]} value={payloadText} onChangeText={setPayloadText} placeholder="Paste pairing JSON" placeholderTextColor="#888" multiline autoCapitalize="none" editable={!busy} />
                {busy
                  ? <View style={[styles.status, { backgroundColor: palette.surface }]}><ActivityIndicator color={palette.textSecondary} style={{ marginBottom: 10 }} /><Text style={[styles.cameraStatus, { color: palette.textSecondary }]} accessibilityLabel="paste-connecting">{stage || 'Connecting…'}</Text></View>
                  : <Pressable accessibilityLabel="Connect" style={[styles.primary, { backgroundColor: palette.warning }]} onPress={onPaste}><Feather name="log-in" size={20} color="#0A0A0A" /></Pressable>}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  form: { flexGrow: 1, padding: 20, gap: 14 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700' },
  cancel: { fontSize: 16 },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  hint: { lineHeight: 20 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, padding: 12 },
  payload: { minHeight: 140, textAlignVertical: 'top', fontFamily: 'monospace' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontWeight: '600' },
  warning: { lineHeight: 19 },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  secondary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  primaryText: { color: '#0A0A0A', fontWeight: '700' },
  camera: { minHeight: 320, overflow: 'hidden', borderRadius: 10, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 20 },
  status: { minHeight: 48, borderRadius: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  cameraStatus: { textAlign: 'center', lineHeight: 20 },
});
