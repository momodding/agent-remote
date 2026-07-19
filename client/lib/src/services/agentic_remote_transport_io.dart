import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

Future<bool> platformTrustsEndpoint(Uri uri) async {
  try {
    final socket = await SecureSocket.connect(uri.host, _endpointPort(uri));
    socket.destroy();
    return true;
  } on HandshakeException {
    return false;
  }
}

Future<Uint8List?> peerCertificateDer(Uri uri) async {
  final socket = await SecureSocket.connect(
    uri.host,
    _endpointPort(uri),
    onBadCertificate: (_) => true,
  );
  try {
    return socket.peerCertificate?.der;
  } finally {
    socket.destroy();
  }
}

http.Client createHttpClient({
  String? trustedFingerprint,
  required String Function(Uint8List) formatFingerprint,
  bool skipFingerprintVerification = false,
}) => IOClient(
  _httpClient(
    trustedFingerprint: trustedFingerprint,
    formatFingerprint: formatFingerprint,
    skipFingerprintVerification: skipFingerprintVerification,
  ),
);

WebSocketChannel connectWebSocket(
  Uri uri, {
  String? trustedFingerprint,
  required String Function(Uint8List) formatFingerprint,
  bool skipFingerprintVerification = false,
}) => IOWebSocketChannel.connect(
  uri,
  customClient: _httpClient(
    trustedFingerprint: trustedFingerprint,
    formatFingerprint: formatFingerprint,
    skipFingerprintVerification: skipFingerprintVerification,
  ),
);

HttpClient _httpClient({
  String? trustedFingerprint,
  required String Function(Uint8List) formatFingerprint,
  required bool skipFingerprintVerification,
}) {
  final client = HttpClient();
  if (skipFingerprintVerification) {
    // ponytail: internal-only escape hatch; remove when managed CA trust exists.
    client.badCertificateCallback = (cert, host, port) => true;
    return client;
  }
  client.badCertificateCallback = (cert, host, port) {
    if (trustedFingerprint == null || trustedFingerprint.isEmpty) {
      return false;
    }
    return formatFingerprint(cert.der) == trustedFingerprint.toUpperCase();
  };
  return client;
}

int _endpointPort(Uri uri) {
  if (uri.hasPort) {
    return uri.port;
  }
  return switch (uri.scheme) {
    'https' || 'wss' => 443,
    'http' || 'ws' => 80,
    _ => uri.port,
  };
}
