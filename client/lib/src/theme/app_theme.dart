import 'package:flutter/widgets.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

ShadThemeData buildAppTheme() {
  const background = Color(0xFF0A0A0A);
  const surface = Color(0xFF181818);
  const foreground = Color(0xFFF0F0F0);
  const primary = Color(0xFFD19A2C);
  const accent = Color(0xFF46B8C4);
  const muted = Color(0xFFB8B8B8);

  return ShadThemeData(
    brightness: Brightness.dark,
    colorScheme: const ShadSlateColorScheme.dark().copyWith(
      background: background,
      card: surface,
      foreground: foreground,
      primary: primary,
      primaryForeground: background,
      accent: accent,
      muted: muted,
      border: Color(0xFF262626),
      ring: primary,
    ),
    textTheme: ShadTextTheme(family: 'Inter'),
  );
}
