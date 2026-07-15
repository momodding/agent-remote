import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:xterm/xterm.dart';

import '../../services/agentic_remote_api.dart';
import 'shortcut_keyboard.dart';

class TerminalScreen extends StatefulWidget {
  const TerminalScreen({super.key, required this.api, required this.sessionId});

  final AgenticRemoteApi api;
  final String sessionId;

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  final Terminal terminal = Terminal(maxLines: 10000);

  @override
  void initState() {
    super.initState();
    terminal.onOutput = (data) =>
        widget.api.sendInput(widget.sessionId, utf8.encode(data));
    terminal.onResize = (cols, rows, _, _) =>
        widget.api.resizeSession(widget.sessionId, cols, rows);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(child: TerminalView(terminal)),
        ShortcutKeyboard(
          onBytes: (bytes) => widget.api.sendInput(widget.sessionId, bytes),
        ),
      ],
    );
  }
}
