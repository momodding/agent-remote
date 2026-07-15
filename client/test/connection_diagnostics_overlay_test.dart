import 'package:agentic_remote/src/features/connection/connection_diagnostics_overlay.dart';
import 'package:agentic_remote/src/theme/app_theme.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

void main() {
  testWidgets('overlay renders all five connection status lines', (
    tester,
  ) async {
    await tester.pumpWidget(
      ShadApp(
        theme: buildAppTheme(),
        home: const Directionality(
          textDirection: TextDirection.ltr,
          child: ConnectionDiagnosticsOverlay(
            lines: ConnectionDiagnosticsOverlay.orderedDefaults,
          ),
        ),
      ),
    );

    for (final line in ConnectionDiagnosticsOverlay.orderedDefaults) {
      expect(find.text(line), findsOneWidget);
    }
  });
}
