import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIFF_THEME,
  DIFF_THEMES,
  diffThemeColorScheme,
  isDiffTheme,
} from '../src/shared/themes.js';
import { codeViewTheme, fontSettingsFromSearch, themeFromSearch } from '../ui/src/themes';

describe('viewer themes', () => {
  it('has unique names and labels', () => {
    expect(new Set(DIFF_THEMES.map((theme) => theme.value)).size).toBe(DIFF_THEMES.length);
    expect(new Set(DIFF_THEMES.map((theme) => theme.label)).size).toBe(DIFF_THEMES.length);
  });

  it('validates and classifies configured themes', () => {
    expect(isDiffTheme('one-dark-pro')).toBe(true);
    expect(diffThemeColorScheme('one-dark-pro')).toBe('dark');
    expect(diffThemeColorScheme('github-light-default')).toBe('light');
    expect(isDiffTheme('not-a-theme')).toBe(false);
  });

  it('reads the theme from the viewer URL', () => {
    expect(themeFromSearch('?theme=one-dark-pro')).toBe('one-dark-pro');
    expect(themeFromSearch('?theme=not-a-theme')).toBe(DEFAULT_DIFF_THEME);
    expect(themeFromSearch('')).toBe(DEFAULT_DIFF_THEME);
  });

  it('maps the system option to adaptive Pierre themes', () => {
    expect(codeViewTheme('system')).toEqual({ dark: 'pierre-dark', light: 'pierre-light' });
    expect(codeViewTheme('dracula')).toBe('dracula');
  });

  it('reads font settings from the viewer URL', () => {
    expect(fontSettingsFromSearch('?font-family=Dank+Mono&font-size=14&line-height=22')).toEqual({
      fontFamily: 'Dank Mono',
      fontSize: 14,
      lineHeight: 22,
    });
    expect(fontSettingsFromSearch('?font-size=99&line-height=nope')).toEqual({
      fontFamily: 'Commit Mono, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 20,
    });
  });
});
