import 'package:agentic_remote/src/services/agentic_remote_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
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

  test('agenticEndpointUri builds sessions path', () {
    expect(
      agenticEndpointUri('https://host.example', '/v1/sessions').toString(),
      'https://host.example/v1/sessions',
    );
  });
}
