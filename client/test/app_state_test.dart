import 'package:agentic_remote/src/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('device name validation trims and rejects invalid names', () {
    expect(AppState.validateClientName(' phone '), 'phone');
    expect(() => AppState.validateClientName('   '), throwsArgumentError);
    expect(
      () => AppState.validateClientName(List.filled(65, 'x').join()),
      throwsArgumentError,
    );
  });
}
