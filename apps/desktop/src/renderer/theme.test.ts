// Scenario: Desktop theme selection across first launch and later restarts.
// Responsibilities: system-derived initial choice, persisted explicit choice, and two-state toggling.
// Wiring: pure theme helpers with an in-memory Storage boundary. Run with the Desktop Vitest config.
import { describe, expect, it } from 'vitest';

import { persistTheme, readTheme, THEME_STORAGE_KEY, toggleTheme } from './theme';

describe('Desktop theme selection (initialization and persistence)', () => {
  it('uses the current system preference when no explicit choice is stored', () => {
    const storage = memoryStorage();

    expect(readTheme(storage, true)).toBe('dark');
  });

  it('restores an explicit choice instead of following a later system change', () => {
    const storage = memoryStorage([[THEME_STORAGE_KEY, 'light']]);

    expect(readTheme(storage, true)).toBe('light');
  });

  it('ignores an invalid stored value and falls back to the system preference', () => {
    const storage = memoryStorage([[THEME_STORAGE_KEY, 'system']]);

    expect(readTheme(storage, false)).toBe('light');
  });

  it('persists an explicit selection for the next window', () => {
    const storage = memoryStorage();

    persistTheme(storage, 'dark');

    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('switches directly between light and dark themes', () => {
    expect(toggleTheme('light')).toBe('dark');
    expect(toggleTheme('dark')).toBe('light');
  });
});

function memoryStorage(initial: readonly (readonly [string, string])[] = []) {
  const values = new Map(initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
