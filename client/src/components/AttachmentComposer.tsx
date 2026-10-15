import { Pressable, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import type { AgentAttachment } from "../protocol";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentComposer({
  attachments,
  error,
  onRemove,
}: {
  attachments: AgentAttachment[];
  error: string | null;
  onRemove: (storageRef: string) => void;
}) {
  return (
    <>
      {error && <Text accessibilityLabel="Attachment error" style={styles.error}>{error}</Text>}
      {attachments.length > 0 && (
        <View accessibilityLabel="Attachment chips" style={styles.chips}>
          {attachments.map((attachment) => {
            const image = attachment.mimeType.startsWith("image/");
            return (
              <View key={attachment.storageRef} style={styles.chip}>
                <Feather name={image ? "image" : "file"} size={14} color="#D19A2C" />
                <Text style={styles.name} numberOfLines={1}>{attachment.name}</Text>
                <Text style={styles.size}>{formatBytes(attachment.sizeBytes)}</Text>
                <Pressable accessibilityLabel={`Remove ${attachment.name}`} onPress={() => onRemove(attachment.storageRef)} hitSlop={8}>
                  <Feather name="x" size={15} color="#D1D5DB" />
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingTop: 6 },
  chip: { maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#1E1E1E", borderWidth: 1, borderColor: "#444", borderRadius: 14, paddingHorizontal: 8, paddingVertical: 5 },
  name: { maxWidth: 140, color: "#F0F0F0", fontSize: 12 },
  size: { color: "#9CA3AF", fontSize: 11 },
  error: { color: "#FCA5A5", backgroundColor: "#3A1515", marginHorizontal: 12, marginTop: 6, padding: 8, borderRadius: 6, fontSize: 12 },
});
