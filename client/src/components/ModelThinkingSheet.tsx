import { forwardRef, useImperativeHandle, useRef } from 'react';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { ActivityIndicator, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { AgentModelInfo } from '../protocol';
import { GlassBottomSheet, type GlassBottomSheetHandle } from './GlassBottomSheet';

export type ModelThinkingSheetHandle = {
  present: () => void;
  dismiss: () => void;
};

export const DEFAULT_THINKING_LEVELS = [
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type Props = {
  currentModel?: AgentModelInfo;
  currentThinking?: string;
  availableModels?: AgentModelInfo[];
  availableThinking?: string[];
  modelEnabled: boolean;
  thinkingEnabled: boolean;
  onSelectModel: (modelId: string) => Promise<void> | void;
  onSelectThinking: (level: string) => Promise<void> | void;
  loadingModel?: boolean;
  loadingThinking?: boolean;
};

export const ModelThinkingSheet = forwardRef<ModelThinkingSheetHandle, Props>(function ModelThinkingSheet(
  {
    currentModel,
    currentThinking,
    availableModels = [],
    availableThinking = DEFAULT_THINKING_LEVELS,
    modelEnabled,
    thinkingEnabled,
    onSelectModel,
    onSelectThinking,
    loadingModel = false,
    loadingThinking = false,
  },
  ref,
) {
  const sheet = useRef<GlassBottomSheetHandle>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const palette = isDark
    ? {
        text: '#F0F0F0',
        muted: '#A3A3A3',
        subtle: '#6B7280',
        accent: '#818CF8',
        selectedBg: 'rgba(129, 140, 248, 0.16)',
        border: 'rgba(255, 255, 255, 0.12)',
        chipBg: 'rgba(255, 255, 255, 0.06)',
        chipSelectedBg: 'rgba(129, 140, 248, 0.24)',
        disabled: 'rgba(255, 255, 255, 0.38)',
      }
    : {
        text: '#1A1A1A',
        muted: '#5A5A5A',
        subtle: '#9CA3AF',
        accent: '#4F46E5',
        selectedBg: 'rgba(79, 70, 229, 0.12)',
        border: 'rgba(0, 0, 0, 0.1)',
        chipBg: 'rgba(0, 0, 0, 0.04)',
        chipSelectedBg: 'rgba(79, 70, 229, 0.18)',
        disabled: 'rgba(0, 0, 0, 0.35)',
      };

  useImperativeHandle(
    ref,
    () => ({
      present: () => sheet.current?.present(),
      dismiss: () => sheet.current?.dismiss(),
    }),
    [],
  );

  const displayModels =
    availableModels.length > 0
      ? availableModels
      : currentModel
        ? [currentModel]
        : [];

  const displayThinkingLevels =
    availableThinking.length > 0 ? availableThinking : DEFAULT_THINKING_LEVELS;

  return (
    <GlassBottomSheet ref={sheet} title="Model & Thinking">
      <BottomSheetScrollView contentContainerStyle={styles.list}>
        {/* Model Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: palette.muted }]}>MODEL</Text>
            {loadingModel && <ActivityIndicator size="small" color={palette.accent} />}
          </View>

          {!modelEnabled ? (
            <Text style={[styles.disabledNotice, { color: palette.disabled }]}>
              Model switching is not supported by the current agent connection.
            </Text>
          ) : displayModels.length === 0 ? (
            <Text style={[styles.emptyNotice, { color: palette.muted }]}>
              No models available.
            </Text>
          ) : (
            <View style={styles.modelsContainer}>
              {displayModels.map((model) => {
                const isSelected =
                  currentModel?.id === model.id ||
                  (Boolean(model.provider) && `${model.provider}/${model.id}` === currentModel?.id);

                return (
                  <Pressable
                    key={`${model.provider || 'unknown'}:${model.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Select model ${model.name || model.id}`}
                    accessibilityState={{ selected: isSelected, disabled: loadingModel }}
                    disabled={loadingModel}
                    onPress={() => onSelectModel(model.id)}
                    style={({ pressed }) => [
                      styles.modelRow,
                      { borderColor: palette.border },
                      isSelected && {
                        backgroundColor: palette.selectedBg,
                        borderColor: palette.accent,
                      },
                      pressed && !isSelected && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.modelInfo}>
                      <Text
                        style={[
                          styles.modelName,
                          { color: isSelected ? palette.accent : palette.text },
                        ]}
                      >
                        {model.name || model.id}
                      </Text>
                      {Boolean(model.provider) && (
                        <Text style={[styles.modelProvider, { color: palette.subtle }]}>
                          {model.provider}
                        </Text>
                      )}
                    </View>
                    {isSelected && (
                      <Feather name="check" size={18} color={palette.accent} />
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        {/* Thinking Level Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: palette.muted }]}>THINKING LEVEL</Text>
            {loadingThinking && <ActivityIndicator size="small" color={palette.accent} />}
          </View>

          {!thinkingEnabled ? (
            <Text style={[styles.disabledNotice, { color: palette.disabled }]}>
              Thinking level adjustment is not supported by the current agent connection.
            </Text>
          ) : (
            <View style={styles.chipsWrap}>
              {displayThinkingLevels.map((level) => {
                const isSelected = currentThinking === level;
                return (
                  <Pressable
                    key={level}
                    accessibilityRole="button"
                    accessibilityLabel={`Select thinking level ${level}`}
                    accessibilityState={{ selected: isSelected, disabled: loadingThinking }}
                    disabled={loadingThinking}
                    onPress={() => onSelectThinking(level)}
                    style={({ pressed }) => [
                      styles.chip,
                      {
                        backgroundColor: isSelected ? palette.chipSelectedBg : palette.chipBg,
                        borderColor: isSelected ? palette.accent : palette.border,
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        {
                          color: isSelected ? palette.accent : palette.text,
                          fontWeight: isSelected ? '700' : '500',
                        },
                      ]}
                    >
                      {level}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </BottomSheetScrollView>
    </GlassBottomSheet>
  );
});

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: 20,
    paddingBottom: 36,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  disabledNotice: {
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
  },
  emptyNotice: {
    fontSize: 13,
  },
  modelsContainer: {
    gap: 8,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  modelInfo: {
    flex: 1,
    marginRight: 10,
  },
  modelName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  modelProvider: {
    fontSize: 12,
    textTransform: 'capitalize',
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
  },
});
