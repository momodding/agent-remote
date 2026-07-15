import 'package:flutter/widgets.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import 'src/features/dashboard/session_dashboard.dart';
import 'src/state/app_state.dart';
import 'src/theme/app_theme.dart';

void main() {
  runApp(const AgenticRemoteApp());
}

class AgenticRemoteApp extends StatefulWidget {
  const AgenticRemoteApp({super.key});

  @override
  State<AgenticRemoteApp> createState() => _AgenticRemoteAppState();
}

class _AgenticRemoteAppState extends State<AgenticRemoteApp> {
  final AppState state = AppState();

  @override
  Widget build(BuildContext context) {
    return ShadApp(
      theme: buildAppTheme(),
      home: SessionDashboard(state: state),
      debugShowCheckedModeBanner: false,
    );
  }
}
