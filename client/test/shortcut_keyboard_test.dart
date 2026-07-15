import 'package:agentic_remote/src/features/terminal/shortcut_keyboard.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('key labels map to expected escape sequences', () {
    expect(keySequences['^C'], [0x03]);
    expect(keySequences['Esc'], [0x1b]);
    expect(keySequences['Tab'], [0x09]);
    expect(keySequences['↑'], [0x1b, 0x5b, 0x41]);
    expect(keySequences['F12'], [0x1b, 0x5b, 0x32, 0x34, 0x7e]);
  });
}
