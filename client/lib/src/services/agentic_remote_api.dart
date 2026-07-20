import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:http/http.dart' as http;
import 'package:crypto/crypto.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/messages.dart';
import 'agentic_remote_transport.dart';

@visibleForTesting
Uri agenticEndpointUri(String endpoint, String path, {String? scheme}) {
  final base = Uri.parse(endpoint);
  return Uri(
    scheme: scheme ?? base.scheme,
    userInfo: base.userInfo,
    host: base.host,
    port: base.hasPort && base.port != 0 ? base.port : null,
    path: path,
  );
}

@visibleForTesting
String agenticWebSocketScheme(String endpoint) =>
    Uri.parse(endpoint).scheme == 'http' ? 'ws' : 'wss';

const bool clientConfigSkipFingerprintVerification = bool.fromEnvironment(
  'AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION',
);

@visibleForTesting
bool shouldSkipFingerprintVerification(
  PairingPayload payload,
  bool requestedSkip,
) =>
    requestedSkip ||
    payload.skipFingerprintVerification ||
    clientConfigSkipFingerprintVerification;

@visibleForTesting
String formatCertificateFingerprint(Uint8List der) => sha256
    .convert(der)
    .bytes
    .map((byte) => byte.toRadixString(16).padLeft(2, '0').toUpperCase())
    .join(':');

@visibleForTesting
String? fingerprintForTransport({
  required String fingerprint,
  required bool skipFingerprintVerification,
  required bool platformTrusted,
}) {
  if (skipFingerprintVerification || platformTrusted) {
    return null;
  }
  return fingerprint;
}

class AgenticRemoteApi {
  AgenticRemoteApi({http.Client? client}) : client = client ?? http.Client();

  final StreamController<String> diagnostics =
      StreamController<String>.broadcast();
  final StreamController<List<SessionSummary>> sessions =
      StreamController<List<SessionSummary>>.broadcast();
  final StreamController<Map<String, dynamic>> terminalOutput =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<WaitState> waitStates =
      StreamController<WaitState>.broadcast();

  PairingPayload? pairing;
  WebSocketChannel? _sessionChannel;
  http.Client client;
  List<SessionSummary> _lastSessions = const <SessionSummary>[];
  String? bearerToken;
  bool _skipFingerprintVerification = false;
  String? _trustedFingerprint;

  Future<void> connectFromPayload(
    String raw, {
    required String clientName,
    required bool webTrustConfirmed,
    bool skipFingerprintVerification = false,
  }) async {
    pairing = PairingPayload.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    _skipFingerprintVerification = shouldSkipFingerprintVerification(
      pairing!,
      skipFingerprintVerification,
    );
    final endpoint = Uri.parse(pairing!.endpoint);
    final endpointScheme = endpoint.scheme;
    diagnostics.add('Resolving endpoint...');
    if (endpointScheme == 'http') {
      diagnostics.add('Using plaintext HTTP endpoint...');
    } else {
      diagnostics.add('Initiating TLS Handshake...');
      if (!_skipFingerprintVerification) {
        diagnostics.add('Validating Certificate Fingerprint...');
      }
    }
    final platformTrusted =
        endpointScheme == 'https' &&
        !_skipFingerprintVerification &&
        await platformTrustsEndpoint(endpoint);
    _trustedFingerprint = fingerprintForTransport(
      fingerprint: pairing!.fingerprint,
      skipFingerprintVerification: _skipFingerprintVerification,
      platformTrusted: platformTrusted,
    );
    client = createHttpClient(
      trustedFingerprint: _trustedFingerprint,
      formatFingerprint: formatCertificateFingerprint,
      skipFingerprintVerification: _skipFingerprintVerification,
    );
    if (_skipFingerprintVerification) {
      diagnostics.add('Fingerprint verification skipped');
    }
    await _authenticate(clientName.trim());
    diagnostics.add('Session Established');
  }

  Future<void> _authenticate(String clientName) async {
    clientName;
    bearerToken = 'dev-no-auth';
  }

  void connectSession(String sessionId) {
    final endpoint = agenticEndpointUri(
      pairing!.endpoint,
      '/v1/ws/sessions/$sessionId',
      scheme: agenticWebSocketScheme(pairing!.endpoint),
    );
    _sessionChannel?.sink.close();
    _sessionChannel = connectWebSocket(
      endpoint,
      trustedFingerprint: _trustedFingerprint,
      formatFingerprint: formatCertificateFingerprint,
      skipFingerprintVerification: _skipFingerprintVerification,
    );
    _sessionChannel!.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      if (msg['type'] == 'pty.output') {
        terminalOutput.add(msg);
      }
    });
  }

  Future<void> resizeSession(String sessionId, int cols, int rows) async {
    _sessionChannel?.sink.add(
      jsonEncode({
        'type': 'pty.resize',
        'sessionId': sessionId,
        'cols': cols,
        'rows': rows,
      }),
    );
  }

  Future<void> sendInput(String sessionId, List<int> bytes) async {
    _sessionChannel?.sink.add(
      jsonEncode({
        'type': 'pty.input',
        'sessionId': sessionId,
        'data': base64Encode(bytes),
      }),
    );
  }

  Future<SessionSummary> createSession({
    String name = '',
    String command = '',
    String cwd = '',
  }) async {
    final response = await client.post(
      agenticEndpointUri(pairing!.endpoint, '/v1/sessions'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'name': name,
        'command': command,
        'args': <String>[],
        'cwd': cwd,
        'cols': 80,
        'rows': 24,
      }),
    );
    if (response.statusCode != 201) {
      throw StateError('create session failed: ${response.statusCode}');
    }
    final summary = SessionSummary.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
    await fetchSessions();
    return summary;
  }

  Future<List<SessionSummary>> fetchSessions() async {
    final uri = agenticEndpointUri(pairing!.endpoint, '/v1/sessions');
    var response = await client.get(uri);
    if (response.statusCode == 502) {
      response = await client.get(uri);
    }
    if (response.statusCode == 502) {
      diagnostics.add(_lastSessions.isEmpty
          ? 'Session fetch failed (502); showing no sessions'
          : 'Session fetch failed (502); showing last known sessions');
      sessions.add(_lastSessions);
      return _lastSessions;
    }
    if (response.statusCode != 200) {
      throw StateError('fetch sessions failed: ${response.statusCode}');
    }
    final decoded = jsonDecode(response.body) as List<dynamic>;
    final items = decoded
        .map((item) => SessionSummary.fromJson(item as Map<String, dynamic>))
        .toList();
    _lastSessions = items;
    sessions.add(items);
    return items;
  }
}
