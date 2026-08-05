import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { parsePairingPayload } from '../lib/auth';
import type { PairingPayload } from '../protocol';

type Props = { visible: boolean; onDismiss: () => void; onConnect: (payload: PairingPayload, clientName: string, onStage: (message: string) => void) => Promise<void> };

// Camera readiness beyond the OS permission grant: unknown while checking, then available/unavailable.
type Availability = 'checking' | 'available' | 'unavailable';

export function PairingSheet({ visible, onDismiss, onConnect }: Props) {
  const insets = useSafeAreaInsets();
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
    if (!scan || !permission?.granted) return;
    if (Platform.OS !== 'web') { setAvailability('available'); return; }
    let cancelled = false;
    setAvailability('checking');
    CameraView.isAvailableAsync()
      .then((ok) => { if (!cancelled) setAvailability(ok ? 'available' : 'unavailable'); })
      .catch(() => { if (!cancelled) setAvailability('unavailable'); });
    return () => { cancelled = true; };
  }, [scan, permission?.granted]);

  useEffect(() => {
    if (!visible) { setScan(false); setAvailability('checking'); scanLock.current = false; }
  }, [visible]);

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
      return <View style={styles.camera}><Text style={styles.cameraStatus} accessibilityLabel="camera-loading">Checking camera permission…</Text></View>;
    }
    if (!permission.granted && permission.canAskAgain) {
      return (
        <View style={styles.camera}>
          <Pressable style={styles.primary} accessibilityLabel="allow-camera" onPress={() => void requestPermission()}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </Pressable>
        </View>
      );
    }
    if (!permission.granted) {
      return (
        <View style={styles.camera}>
          <Text style={styles.cameraStatus}>Camera access was denied. Enable it in system settings to scan.</Text>
          <Pressable style={styles.primary} accessibilityLabel="open-camera-settings" onPress={() => void Linking.openSettings()}>
            <Text style={styles.primaryText}>Open camera settings</Text>
          </Pressable>
        </View>
      );
    }
    if (availability === 'checking') {
      return <View style={styles.camera}><Text style={styles.cameraStatus} accessibilityLabel="camera-checking">Checking camera availability…</Text></View>;
    }
    if (availability === 'unavailable') {
      return (
        <View style={styles.camera}>
          <Text style={styles.cameraStatus}>Camera is unavailable right now.</Text>
          <Pressable style={styles.primary} accessibilityLabel="retry-camera" onPress={openScan}>
            <Text style={styles.primaryText}>Retry camera</Text>
          </Pressable>
        </View>
      );
    }
    if (busy) {
      return <View style={styles.camera}><Text style={styles.cameraStatus} accessibilityLabel="camera-connecting">{stage || 'Connecting…'}</Text></View>;
    }
    return (
      <View style={styles.camera}>
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
      <View style={[styles.sheet, { paddingTop: Math.max(insets.top, 20) }]}>
        <View style={styles.header}><Text style={styles.title}>Connect a daemon</Text><Pressable accessibilityLabel="cancel-pairing" disabled={busy} onPress={dismiss}><Text style={styles.cancel}>Cancel</Text></Pressable></View>
        <Text style={styles.hint}>Give this device a name, then scan or paste the temporary pairing payload.</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Device name" placeholderTextColor="#888" autoCapitalize="none" editable={!busy} />
        <View style={styles.row}><Text style={styles.label}>Skip fingerprint verification</Text><Switch value={skip} onValueChange={setSkip} disabled={busy} /></View>
        <Text style={styles.warning}>Expo Go cannot dynamically trust a self-signed daemon certificate. Direct LAN pairing must enable this option.</Text>
        {scan ? (
          <>
            {renderCamera()}
            <Pressable style={styles.secondary} accessibilityLabel="use-pasted-json" disabled={busy} onPress={usePastedJSON}><Text style={styles.primaryText}>Use pasted JSON</Text></Pressable>
          </>
        ) : (
          <>
            <Pressable style={styles.secondary} disabled={busy} onPress={openScan}><Text style={styles.primaryText}>Scan QR code</Text></Pressable>
            <TextInput style={[styles.input, styles.payload]} value={payloadText} onChangeText={setPayloadText} placeholder="Paste pairing JSON" placeholderTextColor="#888" multiline autoCapitalize="none" editable={!busy} />
            {busy
              ? <View style={styles.status}><Text style={styles.cameraStatus} accessibilityLabel="paste-connecting">{stage || 'Connecting…'}</Text></View>
              : <Pressable style={styles.primary} onPress={onPaste}><Text style={styles.primaryText}>Connect</Text></Pressable>}
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, gap: 14, padding: 20, backgroundColor: '#0A0A0A' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#F0F0F0', fontSize: 22, fontWeight: '700' },
  cancel: { color: '#46B8C4', fontSize: 16 },
  hint: { color: '#B8B8B8', lineHeight: 20 },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#3A3A3A', borderRadius: 8, color: '#F0F0F0', padding: 12 },
  payload: { minHeight: 140, textAlignVertical: 'top', fontFamily: 'monospace' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#F0F0F0', fontWeight: '600' },
  warning: { color: '#D19A2C', lineHeight: 19 },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#D19A2C' },
  secondary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#264E54' },
  primaryText: { color: '#0A0A0A', fontWeight: '700' },
  camera: { minHeight: 320, overflow: 'hidden', borderRadius: 10, backgroundColor: '#181818', justifyContent: 'center', alignItems: 'center', gap: 12, padding: 20 },
  status: { minHeight: 48, borderRadius: 8, backgroundColor: '#181818', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  cameraStatus: { color: '#B8B8B8', textAlign: 'center', lineHeight: 20 },
});
