import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { parsePairingPayload } from '../lib/auth';
import type { PairingPayload } from '../protocol';

type Props = { visible: boolean; onDismiss: () => void; onConnect: (payload: PairingPayload, clientName: string) => Promise<void> };

export function PairingSheet({ visible, onDismiss, onConnect }: Props) {
  const [name, setName] = useState('phone');
  const [payloadText, setPayloadText] = useState('');
  const [scan, setScan] = useState(false);
  const [skip, setSkip] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const connect = async (raw: string) => {
    try {
      const payload = parsePairingPayload(raw);
      await onConnect({ ...payload, skipFingerprintVerification: skip || payload.skipFingerprintVerification }, name);
      onDismiss();
    } catch (error) {
      Alert.alert('Pairing failed', error instanceof Error ? error.message : 'Invalid pairing data');
    }
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onDismiss}>
      <View style={styles.sheet}>
        <View style={styles.header}><Text style={styles.title}>Connect a daemon</Text><Pressable onPress={onDismiss}><Text style={styles.cancel}>Cancel</Text></Pressable></View>
        <Text style={styles.hint}>Give this device a name, then scan or paste the temporary pairing payload.</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Device name" placeholderTextColor="#888" autoCapitalize="none" />
        <View style={styles.row}><Text style={styles.label}>Skip fingerprint verification</Text><Switch value={skip} onValueChange={setSkip} /></View>
        <Text style={styles.warning}>Expo Go cannot dynamically trust a self-signed daemon certificate. Direct LAN pairing must enable this option.</Text>
        {scan ? (
          <View style={styles.camera}>{permission?.granted ? <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => { setScan(false); void connect(data); }} /> : <Pressable style={styles.primary} onPress={() => void requestPermission()}><Text style={styles.primaryText}>Allow camera</Text></Pressable>}</View>
        ) : <>
          <Pressable style={styles.secondary} onPress={() => setScan(true)}><Text style={styles.primaryText}>Scan QR code</Text></Pressable>
          <TextInput style={[styles.input, styles.payload]} value={payloadText} onChangeText={setPayloadText} placeholder="Paste pairing JSON" placeholderTextColor="#888" multiline autoCapitalize="none" />
          <Pressable style={styles.primary} onPress={() => void connect(payloadText)}><Text style={styles.primaryText}>Connect</Text></Pressable>
        </>}
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
  camera: { minHeight: 320, overflow: 'hidden', borderRadius: 10, backgroundColor: '#181818' },
});
