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
  bool allowBadCertificates = false,
}) {
  if (allowBadCertificates) {
    return IOClient(_insecureHttpClient());
  }
  if (trustedFingerprint == null) {
    return http.Client();
  }
  return IOClient(_pinnedHttpClient(trustedFingerprint, formatFingerprint));
}

WebSocketChannel connectWebSocket(
  Uri uri, {
  String? trustedFingerprint,
  required String Function(Uint8List) formatFingerprint,
  bool allowBadCertificates = false,
}) {
  if (allowBadCertificates) {
    return IOWebSocketChannel.connect(uri, customClient: _insecureHttpClient());
  }
  if (trustedFingerprint == null) {
    return WebSocketChannel.connect(uri);
  }
  return IOWebSocketChannel.connect(
    uri,
    customClient: _pinnedHttpClient(trustedFingerprint, formatFingerprint),
  );
}

HttpClient _insecureHttpClient() {
  final client = HttpClient();
  // ponytail: internal-only escape hatch; replace with managed CA trust before external use.
  client.badCertificateCallback = (cert, host, port) => true;
  return client;
}

HttpClient _pinnedHttpClient(
  String trustedFingerprint,
  String Function(Uint8List) formatFingerprint,
) {
  final client = HttpClient();
  client.badCertificateCallback = (cert, host, port) {
    return trustedFingerprint == formatFingerprint(cert.der);
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
