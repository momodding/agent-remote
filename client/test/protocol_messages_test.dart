import 'package:flutter_test/flutter_test.dart';
import 'package:agentic_remote/src/protocol/messages.dart';

void main() {
  test('QR payload parsing accepts required fields', () {
    final payload = PairingPayload.fromJson({
      'v': 2,
      'endpoint': 'https://127.0.0.1:8765',
      'fingerprint': 'AA:BB',
      'pairingId': 'pairing',
      'token': 'token',
      'expiresAt': '2026-01-01T00:00:00Z',
    });
    expect(payload.fingerprint, 'AA:BB');
    expect(payload.skipFingerprintVerification, isFalse);

    final bypassPayload = PairingPayload.fromJson({
      'v': 2,
      'endpoint': 'https://127.0.0.1:8765',
      'fingerprint': 'AA:BB',
      'pairingId': 'pairing',
      'token': 'token',
      'expiresAt': '2026-01-01T00:00:00Z',
      'skipFingerprintVerification': true,
    });
    expect(bypassPayload.skipFingerprintVerification, isTrue);
  });

  test('QR payload parsing rejects missing fingerprint or token', () {
    expect(
      () => PairingPayload.fromJson({
        'v': 2,
        'endpoint': 'https://127.0.0.1:8765',
        'pairingId': 'pairing',
        'expiresAt': '2026-01-01T00:00:00Z',
      }),
      throwsFormatException,
    );
  });
}
