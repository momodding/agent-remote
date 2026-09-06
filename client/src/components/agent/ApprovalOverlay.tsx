import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '../../lib/tabs/rpc-types';
import Feather from '@expo/vector-icons/Feather';

interface Props {
  request: RpcExtensionUIRequest | null;
  onRespond: (response: RpcExtensionUIResponse) => void;
}

export function ApprovalOverlay({ request, onRespond }: Props) {
  if (!request) return null;

  const handleApprove = () => {
    if (request.method === 'confirm') onRespond({ type: 'extension_ui_response', id: request.id, confirmed: true });
    // ponytail: full select/input UI rendering skipped for now; default to first option or placeholder confirmation since mock fixture primarily uses confirm
    else if (request.method === 'select') onRespond({ type: 'extension_ui_response', id: request.id, value: request.options[0] ?? '' });
    else if (request.method === 'input') onRespond({ type: 'extension_ui_response', id: request.id, value: 'mocked input' });
    else onRespond({ type: 'extension_ui_response', id: request.id, confirmed: true });
  };

  const handleDeny = () => {
    if (request.method === 'confirm') onRespond({ type: 'extension_ui_response', id: request.id, confirmed: false });
    else onRespond({ type: 'extension_ui_response', id: request.id, cancelled: true });
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={styles.header}>
          <Feather name="shield" size={16} color="#D19A2C" />
          <Text style={styles.title}>Approval Required</Text>
        </View>
        <Text style={styles.text}>{'title' in request ? request.title : request.method}</Text>
        {'message' in request && request.message ? <Text style={styles.subtext}>{request.message}</Text> : null}
        
        <View style={styles.actions}>
          <Pressable accessibilityLabel="Deny" style={styles.denyBtn} onPress={handleDeny}>
            <Text style={styles.btnText}>Deny</Text>
          </Pressable>
          <Pressable accessibilityLabel="Approve" style={styles.approveBtn} onPress={handleApprove}>
            <Text style={styles.btnTextPrimary}>Approve</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
  card: { backgroundColor: '#181818', width: 300, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#262626' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  title: { color: '#F0F0F0', fontSize: 16, fontWeight: '700' },
  text: { color: '#F0F0F0', fontSize: 14, marginBottom: 8 },
  subtext: { color: '#aaa', fontSize: 13, marginBottom: 20 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  denyBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  approveBtn: { backgroundColor: '#D19A2C', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  btnText: { color: '#F0F0F0', fontSize: 14, fontWeight: '600' },
  btnTextPrimary: { color: '#0A0A0A', fontSize: 14, fontWeight: '600' },
});
