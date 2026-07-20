import 'dart:convert';
import 'dart:typed_data';

import 'package:agentic_remote/src/protocol/messages.dart';
import 'package:agentic_remote/src/services/agentic_remote_api.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
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

  test('clientProof matches fixed server-generated vector', () async {
    final proof = await clientProof(
      token: 'token-abc',
      pairingId: 'pairing-1',
      salt: 'c2FsdC1ieXRlcy0xNi1sZw',
      clientNonce: 'client-nonce-value',
      serverNonce: 'server-nonce-value',
      challengeId: 'challenge-1',
    );
    expect(proof, '-Ok2V-w-Ds6LXfKpVvKxYHz2kBAR_Vji5zNeXutu8cA');
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

  test('agenticEndpointUri builds session websocket path', () {
    expect(
      agenticEndpointUri(
        'https://host.example',
        '/v1/ws/sessions/session-1',
        scheme: 'wss',
      ).toString(),
      'wss://host.example/v1/ws/sessions/session-1',
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

  // -- 502 retry / cache tests --

  final sessionJson = jsonEncode([
    {
      'id': 'active-1',
      'name': 'dev',
      'command': '/bin/sh',
      'cwd': '/home',
      'state': 'running',
      'createdAt': '2026-01-01T00:00:00Z',
      'updatedAt': '2026-01-01T00:00:01Z',
      'preview': <String>[],
    },
  ]);

  test(
    'fetchSessions retries one gateway error and returns active sessions',
    () async {
      var callCount = 0;
      final api = AgenticRemoteApi(
        client: http_testing.MockClient((request) async {
          callCount++;
          if (callCount == 1) {
            return http.Response('bad gateway', 502);
          }
          return http.Response(sessionJson, 200);
        }),
      );
      api.pairing = payload;

      final result = await api.fetchSessions();
      expect(result, hasLength(1));
      expect(result.first.id, 'active-1');
      expect(callCount, 2);
    },
  );

  test(
    'fetchSessions returns empty sessions after repeated initial gateway errors',
    () async {
      var callCount = 0;
      final api = AgenticRemoteApi(
        client: http_testing.MockClient((request) async {
          callCount++;
          return http.Response('bad gateway', 502);
        }),
      );
      api.pairing = payload;
      final diagnostic = api.diagnostics.stream.first;

      final result = await api.fetchSessions();
      expect(result, isEmpty);
      expect(
        await diagnostic,
        'Session fetch failed (502); showing no sessions',
      );
      expect(callCount, 2);
    },
  );

  test(
    'fetchSessions reuses cached sessions after repeated gateway errors',
    () async {
      var callCount = 0;
      final api = AgenticRemoteApi(
        client: http_testing.MockClient((request) async {
          callCount++;
          if (callCount == 1) {
            return http.Response(sessionJson, 200);
          }
          return http.Response('bad gateway', 502);
        }),
      );
      api.pairing = payload;

      // First fetch succeeds, populating the cache.
      final first = await api.fetchSessions();
      expect(first.first.id, 'active-1');

      // Subscribe before the second call so the broadcast event is captured.
      final diagnostic = api.diagnostics.stream.first;

      // Second fetch hits 502 twice (initial + retry) but returns cached.
      final second = await api.fetchSessions();
      expect(second.first.id, 'active-1');
      expect(
        await diagnostic,
        'Session fetch failed (502); showing last known sessions',
      );
      expect(callCount, 3); // 1 success + 2 retried 502s
    },
  );

  test('fetchSessions sends Authorization bearer header', () async {
    http.Request? captured;
    final api = AgenticRemoteApi(
      client: http_testing.MockClient((request) async {
        captured = request;
        return http.Response(sessionJson, 200);
      }),
    );
    api.pairing = payload;
    api.bearerToken = 'sess-token';

    await api.fetchSessions();
    expect(captured?.headers['Authorization'], 'Bearer sess-token');
  });

  test('closeSession posts close endpoint and refreshes sessions', () async {
    final requests = <http.Request>[];
    final api = AgenticRemoteApi(
      client: http_testing.MockClient((request) async {
        requests.add(request);
        if (request.url.path.endsWith('/close')) {
          return http.Response('', 200);
        }
        return http.Response(sessionJson, 200);
      }),
    );
    api.pairing = payload;
    api.bearerToken = 'sess-token';

    await api.closeSession('active-1');
    expect(requests, hasLength(2));
    expect(requests[0].method, 'POST');
    expect(requests[0].url.path, '/v1/sessions/active-1/close');
    expect(requests[0].headers['Authorization'], 'Bearer sess-token');
    expect(requests[1].url.path, '/v1/sessions');
  });
}
