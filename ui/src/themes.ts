import type { DiffsThemeNames, ThemesType } from '@pierre/diffs';

import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_DIFF_THEME,
  DEFAULT_LINE_HEIGHT,
  FONT_SIZES,
  LINE_HEIGHTS,
  diffThemeColorScheme,
  isDiffTheme,
  type DiffTheme,
} from '../../src/shared/themes';

export interface ViewerFontSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export function themeFromSearch(search: string): DiffTheme {
  const value = new URLSearchParams(search).get('theme');
  return value !== null && isDiffTheme(value) ? value : DEFAULT_DIFF_THEME;
}

export function fontSettingsFromSearch(search: string): ViewerFontSettings {
  const params = new URLSearchParams(search);
  const fontFamily = params.get('font-family')?.trim() || DEFAULT_FONT_FAMILY;
  const fontSize = numberFromSearch(params.get('font-size'), FONT_SIZES, DEFAULT_FONT_SIZE);
  const lineHeight = numberFromSearch(params.get('line-height'), LINE_HEIGHTS, DEFAULT_LINE_HEIGHT);
  return { fontFamily, fontSize, lineHeight };
}

function numberFromSearch(
  raw: string | null,
  choices: readonly number[],
  fallback: number,
): number {
  const value = Number(raw);
  return raw !== null && choices.includes(value) ? value : fallback;
}

export function codeViewTheme(theme: DiffTheme): DiffsThemeNames | ThemesType {
  return theme === 'system' ? { dark: 'pierre-dark', light: 'pierre-light' } : theme;
}

export function syncTheme(theme: DiffTheme): void {
  const url = new URL(window.location.href);
  if (theme === DEFAULT_DIFF_THEME) url.searchParams.delete('theme');
  else url.searchParams.set('theme', theme);
  window.history.replaceState(null, '', url);

  const colorScheme = diffThemeColorScheme(theme);
  if (colorScheme === 'system') delete document.documentElement.dataset.colorScheme;
  else document.documentElement.dataset.colorScheme = colorScheme;
}
