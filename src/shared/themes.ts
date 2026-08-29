export const DIFF_THEMES = [
  { value: 'system', label: 'Pierre (system)', colorScheme: 'system' },
  { value: 'pierre-dark', label: 'Pierre Dark', colorScheme: 'dark' },
  { value: 'pierre-light', label: 'Pierre Light', colorScheme: 'light' },
  { value: 'pierre-dark-soft', label: 'Pierre Dark Soft', colorScheme: 'dark' },
  { value: 'pierre-light-soft', label: 'Pierre Light Soft', colorScheme: 'light' },
  { value: 'pierre-dark-vibrant', label: 'Pierre Dark Vibrant', colorScheme: 'dark' },
  { value: 'pierre-light-vibrant', label: 'Pierre Light Vibrant', colorScheme: 'light' },
  {
    value: 'pierre-dark-protanopia-deuteranopia',
    label: 'Pierre Dark (red-green colorblind)',
    colorScheme: 'dark',
  },
  {
    value: 'pierre-light-protanopia-deuteranopia',
    label: 'Pierre Light (red-green colorblind)',
    colorScheme: 'light',
  },
  {
    value: 'pierre-dark-tritanopia',
    label: 'Pierre Dark (blue-yellow colorblind)',
    colorScheme: 'dark',
  },
  {
    value: 'pierre-light-tritanopia',
    label: 'Pierre Light (blue-yellow colorblind)',
    colorScheme: 'light',
  },
  { value: 'one-dark-pro', label: 'One Dark Pro', colorScheme: 'dark' },
  { value: 'github-dark-default', label: 'GitHub Dark', colorScheme: 'dark' },
  { value: 'github-light-default', label: 'GitHub Light', colorScheme: 'light' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha', colorScheme: 'dark' },
  { value: 'catppuccin-latte', label: 'Catppuccin Latte', colorScheme: 'light' },
  { value: 'dracula', label: 'Dracula', colorScheme: 'dark' },
  { value: 'nord', label: 'Nord', colorScheme: 'dark' },
  { value: 'tokyo-night', label: 'Tokyo Night', colorScheme: 'dark' },
  { value: 'gruvbox-dark-medium', label: 'Gruvbox Dark', colorScheme: 'dark' },
  { value: 'gruvbox-light-medium', label: 'Gruvbox Light', colorScheme: 'light' },
  { value: 'rose-pine', label: 'Rose Pine', colorScheme: 'dark' },
  { value: 'rose-pine-dawn', label: 'Rose Pine Dawn', colorScheme: 'light' },
  { value: 'solarized-dark', label: 'Solarized Dark', colorScheme: 'dark' },
  { value: 'solarized-light', label: 'Solarized Light', colorScheme: 'light' },
  { value: 'material-theme-ocean', label: 'Material Ocean', colorScheme: 'dark' },
  { value: 'everforest-dark', label: 'Everforest Dark', colorScheme: 'dark' },
  { value: 'everforest-light', label: 'Everforest Light', colorScheme: 'light' },
  { value: 'kanagawa-wave', label: 'Kanagawa Wave', colorScheme: 'dark' },
  { value: 'vitesse-dark', label: 'Vitesse Dark', colorScheme: 'dark' },
  { value: 'vitesse-light', label: 'Vitesse Light', colorScheme: 'light' },
] as const;

export type DiffTheme = (typeof DIFF_THEMES)[number]['value'];
export type DiffThemeColorScheme = (typeof DIFF_THEMES)[number]['colorScheme'];

export const DEFAULT_DIFF_THEME: DiffTheme = 'system';
export const DEFAULT_FONT_FAMILY = 'Commit Mono, ui-monospace, monospace';
export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20] as const;
export const DEFAULT_FONT_SIZE = 13;
export const LINE_HEIGHTS = [16, 18, 20, 22, 24, 26, 28, 30] as const;
export const DEFAULT_LINE_HEIGHT = 20;

export function isDiffTheme(value: string): value is DiffTheme {
  return DIFF_THEMES.some((theme) => theme.value === value);
}

export function diffThemeColorScheme(theme: DiffTheme): DiffThemeColorScheme {
  return DIFF_THEMES.find((option) => option.value === theme)!.colorScheme;
}
