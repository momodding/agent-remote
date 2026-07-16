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
