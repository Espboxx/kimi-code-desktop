export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'kimi-desktop.theme.v1';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readTheme(storage: ThemeStorage, prefersDark: boolean): Theme {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be unavailable in restricted renderer contexts.
  }
  return prefersDark ? 'dark' : 'light';
}

export function persistTheme(storage: ThemeStorage, theme: Theme): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The active theme still applies for this window when persistence fails.
  }
}

export function toggleTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light';
}
