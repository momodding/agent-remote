class PairingPayload {
  const PairingPayload({
    required this.version,
    required this.endpoint,
    required this.fingerprint,
    required this.pairingId,
    required this.token,
    required this.expiresAt,
  });

  final int version;
  final String endpoint;
  final String fingerprint;
  final String pairingId;
  final String token;
  final DateTime expiresAt;

  factory PairingPayload.fromJson(Map<String, dynamic> json) {
    for (final key in [
      'v',
      'endpoint',
      'fingerprint',
      'pairingId',
      'token',
      'expiresAt',
    ]) {
      if (!json.containsKey(key) ||
          json[key] == null ||
          json[key].toString().isEmpty) {
        throw FormatException('Missing required field: $key');
      }
    }
    return PairingPayload(
      version: json['v'] as int,
      endpoint: json['endpoint'] as String,
      fingerprint: json['fingerprint'] as String,
      pairingId: json['pairingId'] as String,
      token: json['token'] as String,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }
}

class WaitState {
  const WaitState({
    required this.kind,
    required this.label,
    required this.confidence,
    required this.matched,
  });

  final String kind;
  final String label;
  final double confidence;
  final String matched;

  factory WaitState.fromJson(Map<String, dynamic> json) => WaitState(
    kind: json['kind'] as String,
    label: json['label'] as String,
    confidence: (json['confidence'] as num).toDouble(),
    matched: json['matched'] as String,
  );
}

class SessionSummary {
  const SessionSummary({
    required this.id,
    required this.name,
    required this.command,
    required this.cwd,
    required this.state,
    required this.createdAt,
    required this.updatedAt,
    required this.preview,
    this.waitState,
  });

  final String id;
  final String name;
  final String command;
  final String cwd;
  final String state;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<String> preview;
  final WaitState? waitState;

  factory SessionSummary.fromJson(Map<String, dynamic> json) => SessionSummary(
    id: json['id'] as String,
    name: json['name'] as String,
    command: json['command'] as String,
    cwd: json['cwd'] as String,
    state: json['state'] as String,
    createdAt: DateTime.parse(json['createdAt'] as String),
    updatedAt: DateTime.parse(json['updatedAt'] as String),
    preview: (json['preview'] as List<dynamic>? ?? const []).cast<String>(),
    waitState: json['waitState'] == null
        ? null
        : WaitState.fromJson(json['waitState'] as Map<String, dynamic>),
  );
}
