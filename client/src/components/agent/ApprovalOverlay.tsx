import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ScrollView } from 'react-native';
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '../../lib/tabs/rpc-types';
import Feather from '@expo/vector-icons/Feather';

interface Props {
  request: RpcExtensionUIRequest | null;
  onRespond: (response: RpcExtensionUIResponse) => void;
}

export function ApprovalOverlay({ request, onRespond }: Props) {
  if (!request) return null;

  if (request.method === 'cancel') {
    return null;
  }

  return <ApprovalModalContent request={request} onRespond={onRespond} />;
}

function ApprovalModalContent({ request, onRespond }: { request: RpcExtensionUIRequest; onRespond: (response: RpcExtensionUIResponse) => void }) {
  const [inputValue, setInputValue] = useState(
    request.method === 'editor' ? request.prefill || '' : ''
  );
  const [selectedOption, setSelectedOption] = useState<string>(
    request.method === 'select' && request.options.length > 0 ? request.options[0] : ''
  );

  const handleApprove = () => {
    if (request.method === 'confirm') {
      onRespond({ type: 'extension_ui_response', id: request.id, confirmed: true });
    } else if (request.method === 'select') {
      onRespond({ type: 'extension_ui_response', id: request.id, value: selectedOption });
    } else if (request.method === 'input' || request.method === 'editor') {
      onRespond({ type: 'extension_ui_response', id: request.id, value: inputValue });
    } else {
      onRespond({ type: 'extension_ui_response', id: request.id, confirmed: true });
    }
  };

  const handleDeny = () => {
    if (request.method === 'confirm') {
      onRespond({ type: 'extension_ui_response', id: request.id, confirmed: false });
    } else {
      onRespond({ type: 'extension_ui_response', id: request.id, cancelled: true });
    }
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={styles.header}>
          <Feather name="shield" size={16} color="#D19A2C" />
          <Text style={styles.title}>Approval Required</Text>
        </View>
        <Text style={styles.text}>{'title' in request ? request.title : 'Action Required'}</Text>
        {'message' in request && request.message ? <Text style={styles.subtext}>{request.message}</Text> : null}

        {request.method === 'select' && (
          <ScrollView style={styles.selectList}>
            {request.options.map((opt) => (
              <Pressable
                key={opt}
                style={[styles.selectItem, selectedOption === opt && styles.selectItemSelected]}
                onPress={() => setSelectedOption(opt)}
              >
                <Text style={[styles.selectItemText, selectedOption === opt && styles.selectItemTextSelected]}>
                  {opt}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {(request.method === 'input' || request.method === 'editor') && (
          <TextInput
            style={styles.textInput}
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={'placeholder' in request ? request.placeholder : 'Enter value...'}
            placeholderTextColor="#666"
            multiline={request.method === 'editor'}
          />
        )}

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
  card: { backgroundColor: '#181818', width: 320, maxHeight: '80%', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#262626' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  title: { color: '#F0F0F0', fontSize: 16, fontWeight: '700' },
  text: { color: '#F0F0F0', fontSize: 14, marginBottom: 8 },
  subtext: { color: '#aaa', fontSize: 13, marginBottom: 12 },
  selectList: { maxHeight: 160, marginBottom: 16 },
  selectItem: { padding: 10, borderRadius: 6, backgroundColor: '#222', marginBottom: 6, borderWidth: 1, borderColor: '#333' },
  selectItemSelected: { borderColor: '#D19A2C', backgroundColor: '#2d2416' },
  selectItemText: { color: '#bbb', fontSize: 13 },
  selectItemTextSelected: { color: '#F0F0F0', fontWeight: '600' },
  textInput: { backgroundColor: '#222', borderColor: '#333', borderWidth: 1, borderRadius: 6, color: '#F0F0F0', padding: 10, marginBottom: 16, fontSize: 14 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 8 },
  denyBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  approveBtn: { backgroundColor: '#D19A2C', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  btnText: { color: '#F0F0F0', fontSize: 14, fontWeight: '600' },
  btnTextPrimary: { color: '#0A0A0A', fontSize: 14, fontWeight: '600' },
});
