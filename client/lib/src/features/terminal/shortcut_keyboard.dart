import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

const Map<String, List<int>> keySequences = {
  '^C': [0x03],
  'Esc': [0x1b],
  'Tab': [0x09],
  '↑': [0x1b, 0x5b, 0x41],
  '↓': [0x1b, 0x5b, 0x42],
  '→': [0x1b, 0x5b, 0x43],
  '←': [0x1b, 0x5b, 0x44],
  'Home': [0x1b, 0x5b, 0x48],
  'End': [0x1b, 0x5b, 0x46],
  'Pg Up': [0x1b, 0x5b, 0x35, 0x7e],
  'Pg Dn': [0x1b, 0x5b, 0x36, 0x7e],
  'Insert': [0x1b, 0x5b, 0x32, 0x7e],
  'Delete': [0x1b, 0x5b, 0x33, 0x7e],
  'F1': [0x1b, 0x4f, 0x50],
  'F2': [0x1b, 0x4f, 0x51],
  'F3': [0x1b, 0x4f, 0x52],
  'F4': [0x1b, 0x4f, 0x53],
  'F5': [0x1b, 0x5b, 0x31, 0x35, 0x7e],
  'F6': [0x1b, 0x5b, 0x31, 0x37, 0x7e],
  'F7': [0x1b, 0x5b, 0x31, 0x38, 0x7e],
  'F8': [0x1b, 0x5b, 0x31, 0x39, 0x7e],
  'F9': [0x1b, 0x5b, 0x32, 0x30, 0x7e],
  'F10': [0x1b, 0x5b, 0x32, 0x31, 0x7e],
  'F11': [0x1b, 0x5b, 0x32, 0x33, 0x7e],
  'F12': [0x1b, 0x5b, 0x32, 0x34, 0x7e],
};

class ShortcutKeyboard extends StatefulWidget {
  const ShortcutKeyboard({super.key, required this.onBytes});

  final ValueChanged<List<int>> onBytes;

  @override
  State<ShortcutKeyboard> createState() => _ShortcutKeyboardState();
}

class _ShortcutKeyboardState extends State<ShortcutKeyboard> {
  bool expanded = true;
  bool ctrl = false;
  bool alt = false;
  bool shiftTab = false;
  bool lockCtrl = false;
  bool lockAlt = false;
  bool lockShiftTab = false;

  @override
  Widget build(BuildContext context) {
    final topRow = ['↑', '↓', '←', '→', '^C', 'Esc', 'Tab', '⚙', '...'];
    final symbols = ['{}', '[]', '()', '<', '>', '*', '\\', '/', '|'];
    final nav = ['Home', 'Pg Up', 'Pg Dn', 'End', 'Insert', 'Delete'];
    final functions = List<String>.generate(12, (index) => 'F${index + 1}');
    return ShadCard(
      padding: const EdgeInsets.all(8),
      child: Column(
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: topRow.map(_keyButton).toList(),
          ),
          if (expanded) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: symbols.map(_textKey).toList(),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: nav.map(_keyButton).toList(),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _modifierButton(
                  'Ctrl',
                  ctrl,
                  (locked) => _toggleModifier('ctrl', locked),
                ),
                _modifierButton(
                  'Alt',
                  alt,
                  (locked) => _toggleModifier('alt', locked),
                ),
                _modifierButton(
                  'shift tab',
                  shiftTab,
                  (locked) => _toggleModifier('shiftTab', locked),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: functions.map(_keyButton).toList(),
            ),
            const SizedBox(height: 8),
          ],
          ShadButton.ghost(
            onPressed: () => setState(() => expanded = !expanded),
            child: Text(expanded ? '⌄' : '⌃'),
          ),
        ],
      ),
    );
  }

  Widget _modifierButton(
    String label,
    bool active,
    ValueChanged<bool> onToggle,
  ) {
    return GestureDetector(
      onLongPress: () => onToggle(true),
      child: ShadButton.outline(
        onPressed: () => onToggle(false),
        child: Text(active ? '$label*' : label),
      ),
    );
  }

  void _toggleModifier(String modifier, bool locked) {
    setState(() {
      switch (modifier) {
        case 'ctrl':
          lockCtrl = locked ? !lockCtrl : lockCtrl;
          ctrl = locked ? lockCtrl : !ctrl;
          break;
        case 'alt':
          lockAlt = locked ? !lockAlt : lockAlt;
          alt = locked ? lockAlt : !alt;
          break;
        case 'shiftTab':
          lockShiftTab = locked ? !lockShiftTab : lockShiftTab;
          shiftTab = locked ? lockShiftTab : !shiftTab;
          break;
      }
    });
  }

  Widget _keyButton(String label) {
    return ShadButton.outline(
      onPressed: () => _emitSequence(label),
      child: Text(label),
    );
  }

  Widget _textKey(String label) {
    return ShadButton.outline(
      onPressed: () => widget.onBytes(utf8.encode(label)),
      child: Text(label),
    );
  }

  void _emitSequence(String label) {
    var bytes = List<int>.from(keySequences[label] ?? utf8.encode(label));
    if (shiftTab) {
      bytes = [0x1b, 0x5b, 0x5a];
    } else if (ctrl && label.length == 1) {
      bytes = [label.toUpperCase().codeUnitAt(0) & 0x1f];
    } else if (alt && label.length == 1) {
      bytes = [0x1b, ...utf8.encode(label)];
    }
    widget.onBytes(bytes);
    setState(() {
      if (!lockCtrl) ctrl = false;
      if (!lockAlt) alt = false;
      if (!lockShiftTab) shiftTab = false;
    });
  }
}
