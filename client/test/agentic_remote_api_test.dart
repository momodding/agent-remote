import 'dart:typed_data';

import 'package:agentic_remote/src/protocol/messages.dart';
import 'package:agentic_remote/src/services/agentic_remote_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final payload = PairingPayload(
    version: 2,
    endpoint: 'https://127.0.0.1:8765',
    fingerprint: 'AA:BB',
    pairingId: 'pairing',
    token: 'token',
    expiresAt: DateTime.parse('2026-01-01T00:00:00Z'),
  );

  test('formatCertificateFingerprint hashes DER bytes', () {
    expect(
      formatCertificateFingerprint(Uint8List.fromList([1, 2, 3])),
      '03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81',
    );
  });

  test('shouldSkipFingerprintVerification defaults false', () {
    expect(shouldSkipFingerprintVerification(payload, false), isFalse);
  });

  test('shouldSkipFingerprintVerification honors requested skip', () {
    expect(shouldSkipFingerprintVerification(payload, true), isTrue);
  });

  test('shouldSkipFingerprintVerification honors QR payload skip', () {
    expect(
      shouldSkipFingerprintVerification(
        PairingPayload(
          version: 2,
          endpoint: 'https://127.0.0.1:8765',
          fingerprint: 'AA:BB',
          pairingId: 'pairing',
          token: 'token',
          expiresAt: DateTime.parse('2026-01-01T00:00:00Z'),
          skipFingerprintVerification: true,
        ),
        false,
      ),
      isTrue,
    );
  });

  test('fingerprintForTransport skips pinning for platform-trusted TLS', () {
    expect(
      fingerprintForTransport(
        fingerprint: 'AA:BB',
        skipFingerprintVerification: false,
        platformTrusted: true,
      ),
      isNull,
    );
  });

  test('fingerprintForTransport pins self-signed TLS', () {
    expect(
      fingerprintForTransport(
        fingerprint: 'AA:BB',
        skipFingerprintVerification: false,
        platformTrusted: false,
      ),
      'AA:BB',
    );
  });

  test('fingerprintForTransport skips pinning for explicit bypass', () {
    expect(
      fingerprintForTransport(
        fingerprint: 'AA:BB',
        skipFingerprintVerification: true,
        platformTrusted: false,
      ),
      isNull,
    );
  });
  test('agenticEndpointUri builds bootstrap websocket path', () {
    expect(
      agenticEndpointUri(
        'https://host.example',
        '/v1/ws/sessions/bootstrap',
        scheme: 'wss',
      ).toString(),
      'wss://host.example/v1/ws/sessions/bootstrap',
    );
  });

  test('agenticEndpointUri builds plaintext bootstrap websocket path', () {
    expect(
      agenticEndpointUri(
        'http://host.example',
        '/v1/ws/sessions/bootstrap',
        scheme: agenticWebSocketScheme('http://host.example'),
      ).toString(),
      'ws://host.example/v1/ws/sessions/bootstrap',
    );
  });

  test('agenticEndpointUri drops explicit zero port', () {
    expect(
      agenticEndpointUri(
        'https://host.example:0',
        '/v1/ws/sessions/bootstrap',
        scheme: 'wss',
      ).toString(),
      'wss://host.example/v1/ws/sessions/bootstrap',
    );
    expect(
      agenticEndpointUri('https://host.example:0', '/v1/sessions').toString(),
      'https://host.example/v1/sessions',
    );
  });

  test('agenticWebSocketScheme maps http and https', () {
    expect(agenticWebSocketScheme('https://host.example'), 'wss');
    expect(agenticWebSocketScheme('http://host.example'), 'ws');
  });

  test('agenticEndpointUri builds sessions path', () {
    expect(
      agenticEndpointUri('https://host.example', '/v1/sessions').toString(),
      'https://host.example/v1/sessions',
    );
  });
}
