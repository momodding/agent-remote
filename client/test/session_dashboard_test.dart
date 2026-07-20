import 'package:agentic_remote/src/features/dashboard/session_dashboard.dart';
import 'package:agentic_remote/src/features/terminal/terminal_screen.dart';
import 'package:agentic_remote/src/services/agentic_remote_api.dart';
import 'package:agentic_remote/src/protocol/messages.dart';
import 'package:agentic_remote/src/state/app_state.dart';
import 'package:flutter/widgets.dart';
import 'package:shadcn_ui/shadcn_ui.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('search filters cards and preview text appears in top block', (
    tester,
  ) async {
    final state = AppState();
    state.sessions.value = [
      SessionSummary(
        id: '1',
        name: 'alpha',
        command: 'claude',
        cwd: '.',
        state: 'running',
        createdAt: DateTime.parse('2026-01-01T00:00:00Z'),
        updatedAt: DateTime.parse('2026-01-01T00:00:00Z'),
        preview: const ['hello world'],
      ),
      SessionSummary(
        id: '2',
        name: 'beta',
        command: 'gemini',
        cwd: '.',
        state: 'idle',
        createdAt: DateTime.parse('2026-01-01T00:00:00Z'),
        updatedAt: DateTime.parse('2026-01-01T00:00:00Z'),
        preview: const ['goodbye'],
      ),
    ];

    await tester.pumpWidget(SessionDashboard(state: state));
    expect(find.text('New session'), findsOneWidget);
    expect(find.text('hello world'), findsOneWidget);
    await tester.enterText(
      find.widgetWithText(ShadInput, 'Search sessions'),
      'alp',
    );
    await tester.pump();
    expect(find.text('alpha'), findsOneWidget);
    expect(
      find.ancestor(
        of: find.text('alpha'),
        matching: find.byType(GestureDetector),
      ),
      findsOneWidget,
    );
    expect(find.text('beta'), findsNothing);
  });

  testWidgets('tapping a session card opens terminal screen', (tester) async {
    final api = _RecordingApi();
    final state = AppState(api: api);
    state.sessions.value = [
      SessionSummary(
        id: '1',
        name: 'alpha',
        command: 'claude',
        cwd: '.',
        state: 'running',
        createdAt: DateTime.parse('2026-01-01T00:00:00Z'),
        updatedAt: DateTime.parse('2026-01-01T00:00:00Z'),
        preview: const ['hello world'],
      ),
    ];

    await tester.pumpWidget(SessionDashboard(state: state));
    await tester.tap(find.text('hello world'));
    await tester.pumpAndSettle();

    expect(find.byType(TerminalScreen), findsOneWidget);
    expect(api.connectedSessionId, '1');
  });

  testWidgets('shows fingerprint bypass checkbox', (tester) async {
    await tester.pumpWidget(SessionDashboard(state: AppState()));
    expect(find.text('Skip fingerprint verification'), findsOneWidget);
  });
}

class _RecordingApi extends AgenticRemoteApi {
  String? connectedSessionId;

  @override
  void connectSession(String sessionId) {
    connectedSessionId = sessionId;
  }
}
