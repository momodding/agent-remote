import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:shadcn_ui/shadcn_ui.dart';
import '../../protocol/messages.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../connection/connection_diagnostics_overlay.dart';

class SessionDashboard extends StatefulWidget {
  const SessionDashboard({super.key, required this.state});

  final AppState state;

  @override
  State<SessionDashboard> createState() => _SessionDashboardState();
}

class _SessionDashboardState extends State<SessionDashboard> {
  final TextEditingController controller = TextEditingController();
  final TextEditingController payloadController = TextEditingController();
  final TextEditingController nameController = TextEditingController();
  String query = '';
  String connectionError = '';
  bool scanning = false;
  bool skipFingerprintVerification =
      AppState.defaultSkipFingerprintVerification;

  @override
  Widget build(BuildContext context) {
    return ShadApp(
      theme: buildAppTheme(),
      home: Directionality(
        textDirection: TextDirection.ltr,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _PairingPanel(
                payloadController: payloadController,
                nameController: nameController,
                scanning: scanning,
                error: connectionError,
                skipFingerprintVerification: skipFingerprintVerification,
                onScanToggle: () => setState(() => scanning = !scanning),
                onPayloadScanned: (value) {
                  payloadController.text = value;
                  setState(() => scanning = false);
                },
                onSkipFingerprintChanged: (value) {
                  setState(() => skipFingerprintVerification = value);
                },
                onConnect: () async {
                  try {
                    setState(() => connectionError = '');
                    await widget.state.connectFromPayload(
                      payloadController.text,
                      clientName: nameController.text,
                      webTrustConfirmed: true,
                      skipFingerprintVerification: skipFingerprintVerification,
                    );
                  } catch (error) {
                    setState(() => connectionError = error.toString());
                  }
                },
              ),
              const SizedBox(height: 16),
              ShadButton(
                onPressed: () async {
                  try {
                    setState(() => connectionError = '');
                    await widget.state.api.createSession(
                      name: 'remote session',
                    );
                    widget.state.sessions.value = await widget.state.api
                        .fetchSessions();
                  } catch (error) {
                    setState(() => connectionError = error.toString());
                  }
                },
                child: const Text('New session'),
              ),
              const SizedBox(height: 16),
              ShadInput(
                controller: controller,
                placeholder: const Text('Search sessions'),
                onChanged: (value) => setState(() => query = value),
              ),
              const SizedBox(height: 16),
              Expanded(
                child: ValueListenableBuilder<List<SessionSummary>>(
                  valueListenable: widget.state.sessions,
                  builder: (context, sessions, _) {
                    final filtered = sessions.where((session) {
                      if (query.isEmpty) {
                        return true;
                      }
                      final q = query.toLowerCase();
                      return session.name.toLowerCase().contains(q) ||
                          session.command.toLowerCase().contains(q);
                    }).toList();
                    return LayoutBuilder(
                      builder: (context, constraints) {
                        final columns = constraints.maxWidth < 640
                            ? 1
                            : (constraints.maxWidth / 280).floor().clamp(1, 4);
                        return GridView.builder(
                          gridDelegate:
                              SliverGridDelegateWithFixedCrossAxisCount(
                                crossAxisCount: columns,
                                crossAxisSpacing: 12,
                                mainAxisSpacing: 12,
                                mainAxisExtent: 220,
                              ),
                          itemCount: filtered.length,
                          itemBuilder: (context, index) =>
                              _SessionCard(session: filtered[index]),
                        );
                      },
                    );
                  },
                ),
              ),
              ValueListenableBuilder<List<String>>(
                valueListenable: widget.state.diagnostics,
                builder: (context, lines, _) =>
                    ConnectionDiagnosticsOverlay(lines: lines),
              ),
            ],
          ),
        ),
      ),
      debugShowCheckedModeBanner: false,
    );
  }
}

class _PairingPanel extends StatelessWidget {
  const _PairingPanel({
    required this.payloadController,
    required this.nameController,
    required this.scanning,
    required this.skipFingerprintVerification,
    required this.error,
    required this.onScanToggle,
    required this.onPayloadScanned,
    required this.onSkipFingerprintChanged,
    required this.onConnect,
  });

  final TextEditingController payloadController;
  final TextEditingController nameController;
  final bool scanning;
  final bool skipFingerprintVerification;
  final String error;
  final VoidCallback onScanToggle;
  final ValueChanged<String> onPayloadScanned;
  final ValueChanged<bool> onSkipFingerprintChanged;
  final Future<void> Function() onConnect;

  @override
  Widget build(BuildContext context) {
    return ShadCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Pair this device'),
          const SizedBox(height: 12),
          ShadInput(
            controller: nameController,
            placeholder: const Text('Device name'),
          ),
          const SizedBox(height: 8),
          ShadInput(
            controller: payloadController,
            placeholder: const Text('Paste QR payload JSON'),
            maxLines: 3,
          ),
          if (!kIsWeb) ...[
            const SizedBox(height: 8),
            ShadCheckbox(
              value: skipFingerprintVerification,
              onChanged: onSkipFingerprintChanged,
              label: const Text('Skip fingerprint verification'),
              sublabel: const Text('Internal Tailscale/VPN only'),
            ),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              ShadButton(onPressed: onConnect, child: const Text('Connect')),
              const SizedBox(width: 8),
              if (!kIsWeb)
                ShadButton.outline(
                  onPressed: onScanToggle,
                  child: Text(scanning ? 'Hide scanner' : 'Scan QR'),
                ),
            ],
          ),
          if (error.isNotEmpty) ...[const SizedBox(height: 8), Text(error)],
          if (scanning && !kIsWeb) ...[
            const SizedBox(height: 12),
            SizedBox(
              height: 220,
              child: MobileScanner(
                onDetect: (capture) {
                  final value = capture.barcodes.firstOrNull?.rawValue;
                  if (value != null && value.isNotEmpty) {
                    onPayloadScanned(value);
                  }
                },
                errorBuilder: (context, error) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(
                        'Camera error: ${error.errorDetails?.message ?? error.errorCode.message}',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.session});

  final SessionSummary session;

  @override
  Widget build(BuildContext context) {
    return ShadCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              color: const Color(0xFF111111),
              child: DefaultTextStyle(
                style: const TextStyle(
                  fontFamily: 'monospace',
                  color: Color(0xFFF0F0F0),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: session.preview.map(Text.new).toList(),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              const Text('>_'),
              const SizedBox(width: 8),
              Expanded(child: Text(session.name)),
              const Text('local daemon'),
              const SizedBox(width: 8),
              ShadButton.outline(onPressed: () {}, child: const Text('Close')),
            ],
          ),
        ],
      ),
    );
  }
}
