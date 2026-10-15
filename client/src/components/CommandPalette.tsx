import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentCommandDescriptor } from "../protocol";

export function CommandPalette({
  query,
  commands,
  onSelect,
}: {
  query: string;
  commands: AgentCommandDescriptor[];
  onSelect: (command: AgentCommandDescriptor) => void;
}) {
  const normalized = query.replace(/^\//, "").toLowerCase();
  const matches = commands.filter((command) =>
    `${command.name} ${command.description}`.toLowerCase().includes(normalized),
  );
  if (!matches.length) return null;
  return (
    <View accessibilityLabel="Slash command palette" style={styles.palette}>
      {matches.map((command) => (
        <Pressable
          key={command.name}
          accessibilityLabel={`Run command ${command.name}`}
          accessibilityState={{ disabled: !command.enabled }}
          disabled={!command.enabled}
          onPress={() => onSelect(command)}
          style={[styles.row, !command.enabled && styles.disabled]}
        >
          <View style={styles.copy}>
            <Text style={styles.name}>/{command.name}</Text>
            <Text style={styles.description}>{command.description}</Text>
            {!command.enabled && <Text style={styles.reason}>{command.disabledReason || "Unavailable"}</Text>}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  palette: { marginHorizontal: 12, padding: 6, gap: 2, backgroundColor: "#1E1E1E", borderWidth: 1, borderColor: "#444", borderRadius: 8 },
  row: { minHeight: 48, padding: 8, borderRadius: 6 },
  disabled: { opacity: 0.5 },
  copy: { gap: 2 },
  name: { color: "#D19A2C", fontWeight: "700" },
  description: { color: "#D1D5DB", fontSize: 12 },
  reason: { color: "#FCA5A5", fontSize: 11 },
});
