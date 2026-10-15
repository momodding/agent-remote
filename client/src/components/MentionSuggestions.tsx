import { Pressable, StyleSheet, Text, View } from "react-native";
import type { FileEntry } from "../protocol";

export function MentionSuggestions({
  entries,
  onSelect,
}: {
  entries: FileEntry[];
  onSelect: (entry: FileEntry) => void;
}) {
  if (!entries.length) return null;
  return (
    <View accessibilityLabel="Mention file suggestions" style={styles.list}>
      {entries.map((entry) => (
        <Pressable
          key={entry.path}
          accessibilityLabel={`Mention file ${entry.path}`}
          style={styles.row}
          onPress={() => onSelect(entry)}
        >
          <Text style={styles.path} numberOfLines={1}>{entry.path}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginHorizontal: 12, padding: 6, gap: 2, backgroundColor: "#1E1E1E", borderWidth: 1, borderColor: "#444", borderRadius: 8 },
  row: { minHeight: 40, padding: 8, borderRadius: 6 },
  path: { color: "#D1D5DB", fontSize: 12 },
});
