import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

Future<bool> platformTrustsEndpoint(Uri uri) async => true;

Future<Uint8List?> peerCertificateDer(Uri uri) async => null;

http.Client createHttpClient({
  String? trustedFingerprint,
  required String Function(Uint8List) formatFingerprint,
}) => http.Client();

WebSocketChannel connectWebSocket(
  Uri uri, {
  String? trustedFingerprint,
  required String Function(Uint8List) formatFingerprint,
}) => WebSocketChannel.connect(uri);
