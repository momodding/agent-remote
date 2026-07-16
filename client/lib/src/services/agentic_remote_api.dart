import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart' hide Hmac;
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/messages.dart';
import 'agentic_remote_transport.dart';

@visibleForTesting
Uri agenticEndpointUri(String endpoint, String path, {String? scheme}) {
  final base = Uri.parse(endpoint);
  return base.replace(
    scheme: scheme ?? base.scheme,
    path: path,
    query: null,
    fragment: null,
  );
}

class AgenticRemoteApi {
  final StreamController<String> diagnostics =
      StreamController<String>.broadcast();
  final StreamController<List<SessionSummary>> sessions =
      StreamController<List<SessionSummary>>.broadcast();
  final StreamController<Map<String, dynamic>> terminalOutput =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<WaitState> waitStates =
      StreamController<WaitState>.broadcast();

  PairingPayload? pairing;
  WebSocketChannel? _channel;
  http.Client client = http.Client();
  String? bearerToken;
  String? _trustedFingerprint;
  bool _allowBadCertificates = false;

  Future<void> connectFromPayload(
    String raw, {
    required String clientName,
    required bool webTrustConfirmed,
    bool allowBadCertificates = false,
  }) async {
    pairing = PairingPayload.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    diagnostics.add('Resolving endpoint...');
    diagnostics.add('Initiating TLS Handshake...');
    _allowBadCertificates = allowBadCertificates;
    diagnostics.add(
      allowBadCertificates
          ? 'Skipping TLS certificate verification for internal connection...'
          : 'Validating Certificate Fingerprint...',
    );
    await _validateEndpointTrust(webTrustConfirmed: webTrustConfirmed);
    diagnostics.add('Executing Auth-v2 Challenge...');
    await _authenticate(clientName.trim());
    diagnostics.add('Session Established');
  }

  Future<void> _validateEndpointTrust({required bool webTrustConfirmed}) async {
    final uri = Uri.parse(pairing!.endpoint);
    _trustedFingerprint = null;
    if (_allowBadCertificates) {
      if (kIsWeb) {
        diagnostics.add(
          'Failed: Browser cannot disable TLS certificate verification',
        );
        throw StateError('Browser cannot disable TLS certificate verification');
      }
      client = createHttpClient(
        trustedFingerprint: null,
        formatFingerprint: _formatFingerprint,
        allowBadCertificates: true,
      );
      return;
    }
    if (kIsWeb) {
      diagnostics.add(
        'Browser TLS fingerprint access unavailable; relying on HTTPS origin trust for web',
      );
      if (!webTrustConfirmed) {
        diagnostics.add('Failed: Manual endpoint confirmation required');
        throw StateError('Manual endpoint confirmation required');
      }
      client = createHttpClient(
        trustedFingerprint: null,
        formatFingerprint: _formatFingerprint,
        allowBadCertificates: false,
      );
      return;
    }
    if (await platformTrustsEndpoint(uri)) {
      client = createHttpClient(
        trustedFingerprint: null,
        formatFingerprint: _formatFingerprint,
        allowBadCertificates: false,
      );
      return;
    }
    final der = await peerCertificateDer(uri);
    if (der == null) {
      throw StateError('No certificate presented');
    }
    final fingerprint = _formatFingerprint(der);
    if (fingerprint != pairing!.fingerprint) {
      diagnostics.add('Failed: Certificate fingerprint mismatch');
      throw StateError('Certificate fingerprint mismatch');
    }
    _trustedFingerprint = pairing!.fingerprint;
    client = createHttpClient(
      trustedFingerprint: _trustedFingerprint,
      formatFingerprint: _formatFingerprint,
      allowBadCertificates: _allowBadCertificates,
    );
  }

  Future<void> _authenticate(String clientName) async {
    final endpoint = agenticEndpointUri(
      pairing!.endpoint,
      '/v1/ws/sessions/bootstrap',
      scheme: 'wss',
    );
    _channel = connectWebSocket(
      endpoint,
      trustedFingerprint: _trustedFingerprint,
      formatFingerprint: _formatFingerprint,
      allowBadCertificates: _allowBadCertificates,
    );
    final clientNonce = base64UrlEncode(
      List<int>.generate(32, (index) => index + 1),
    ).replaceAll('=', '');
    _channel!.sink.add(
      jsonEncode({
        'type': 'auth.hello',
        'pairingId': pairing!.pairingId,
        'clientNonce': clientNonce,
        'clientName': clientName,
      }),
    );
    final challenge =
        jsonDecode(await _channel!.stream.first as String)
            as Map<String, dynamic>;
    if (challenge['type'] == 'error') {
      throw StateError(challenge['message'] as String);
    }
    final proof = await _clientProof(
      token: pairing!.token,
      pairingId: pairing!.pairingId,
      clientNonce: clientNonce,
      serverNonce: challenge['serverNonce'] as String,
      challengeId: challenge['challengeId'] as String,
      salt: challenge['salt'] as String,
    );
    _channel!.sink.add(
      jsonEncode({
        'type': 'auth.proof',
        'pairingId': pairing!.pairingId,
        'challengeId': challenge['challengeId'],
        'proof': proof,
      }),
    );
    final ok =
        jsonDecode(await _channel!.stream.first as String)
            as Map<String, dynamic>;
    if (ok['type'] != 'auth.ok') {
      throw StateError(ok['message'] as String? ?? 'authentication failed');
    }
    bearerToken = ok['sessionToken'] as String;
  }

  Future<void> resizeSession(String sessionId, int cols, int rows) async {
    _channel?.sink.add(
      jsonEncode({
        'type': 'pty.resize',
        'sessionId': sessionId,
        'cols': cols,
        'rows': rows,
      }),
    );
  }

  Future<void> sendInput(String sessionId, List<int> bytes) async {
    _channel?.sink.add(
      jsonEncode({
        'type': 'pty.input',
        'sessionId': sessionId,
        'data': base64Encode(bytes),
      }),
    );
  }

  Future<List<SessionSummary>> fetchSessions() async {
    final response = await client.get(
      agenticEndpointUri(pairing!.endpoint, '/v1/sessions'),
      headers: {'Authorization': 'Bearer $bearerToken'},
    );
    final decoded = jsonDecode(response.body) as List<dynamic>;
    final items = decoded
        .map((item) => SessionSummary.fromJson(item as Map<String, dynamic>))
        .toList();
    sessions.add(items);
    return items;
  }

  String _formatFingerprint(Uint8List der) {
    final digest = sha256
        .convert(der)
        .bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0').toUpperCase())
        .toList();
    final out = <String>[];
    for (var i = 0; i < digest.length; i += 2) {
      out.add('${digest[i]}${digest[i + 1]}');
    }
    return out.join(':');
  }

  Future<String> _clientProof({
    required String token,
    required String pairingId,
    required String clientNonce,
    required String serverNonce,
    required String challengeId,
    required String salt,
  }) async {
    final verifier = await _argonLike(token, salt);
    final hmacBytes = Hmac(sha256, verifier)
        .convert(
          utf8.encode(
            'agenticRemote-auth-v2$pairingId$clientNonce$serverNonce$challengeId',
          ),
        )
        .bytes;
    return base64UrlEncode(hmacBytes).replaceAll('=', '');
  }

  Future<List<int>> _argonLike(String token, String salt) async {
    final algorithm = Argon2id(
      parallelism: 1,
      memory: 64 * 1024,
      iterations: 3,
      hashLength: 32,
    );
    final key = await algorithm.deriveKey(
      secretKey: SecretKey(utf8.encode(token)),
      nonce: _base64UrlBytes(salt),
    );
    return key.extractBytes();
  }

  List<int> _base64UrlBytes(String value) {
    final padded = value.padRight(
      value.length + (4 - value.length % 4) % 4,
      '=',
    );
    return base64Url.decode(padded);
  }
}
