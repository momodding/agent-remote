import 'package:flutter/foundation.dart';

import '../protocol/messages.dart';
import '../services/agentic_remote_api.dart';

class AppState extends ChangeNotifier {
  AppState({AgenticRemoteApi? api}) : api = api ?? AgenticRemoteApi();

  final AgenticRemoteApi api;
  final ValueNotifier<List<String>> diagnostics = ValueNotifier<List<String>>(
    <String>[],
  );
  final ValueNotifier<List<SessionSummary>> sessions =
      ValueNotifier<List<SessionSummary>>(<SessionSummary>[]);
  final ValueNotifier<Map<String, WaitState>> waitStates =
      ValueNotifier<Map<String, WaitState>>(<String, WaitState>{});

  Future<void> connectFromPayload(
    String payload, {
    required String clientName,
    required bool webTrustConfirmed,
    bool skipFingerprintVerification = false,
  }) async {
    final name = validateClientName(clientName);
    await api.connectFromPayload(
      payload,
      clientName: name,
      webTrustConfirmed: webTrustConfirmed,
      skipFingerprintVerification: skipFingerprintVerification,
    );
    sessions.value = await api.fetchSessions();
  }

  static String validateClientName(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError('Device name is required');
    }
    if (trimmed.runes.length > 64) {
      throw ArgumentError('Device name must be 64 characters or fewer');
    }
    return trimmed;
  }
}
