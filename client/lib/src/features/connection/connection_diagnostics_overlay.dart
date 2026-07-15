import 'package:flutter/widgets.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

class ConnectionDiagnosticsOverlay extends StatelessWidget {
  const ConnectionDiagnosticsOverlay({super.key, required this.lines});

  final List<String> lines;

  static const orderedDefaults = <String>[
    'Resolving endpoint...',
    'Initiating TLS Handshake...',
    'Validating Certificate Fingerprint...',
    'Executing Auth-v2 Challenge...',
    'Session Established',
  ];

  @override
  Widget build(BuildContext context) {
    return ShadCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Connection diagnostics'),
          const SizedBox(height: 12),
          for (final line in lines) ...[Text(line), const SizedBox(height: 4)],
        ],
      ),
    );
  }
}
