// Light / dark / system.
//
// `data-theme` on <html> always holds the *resolved* theme, so CSS only needs one dark block;
// `data-theme-preference` remembers what the user asked for. "system" is resolved here and
// re-resolved when the OS setting changes, which is the behaviour people expect from a desktop
// application and the reason this is a store instead of a class toggle.

export const THEME_PREFERENCES = ['light', 'dark', 'system'];
const STORAGE_KEY = 'hve.theme';

export function resolveTheme(preference, prefersDark = false) {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

export function readStoredTheme(storage) {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return THEME_PREFERENCES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function createThemeStore({
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  root = typeof document === 'undefined' ? null : document.documentElement,
  media = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)'),
} = {}) {
  let preference = readStoredTheme(storage);
  const listeners = new Set();
  const query = media;

  function apply() {
    const resolved = resolveTheme(preference, Boolean(query?.matches));
    if (root) {
      root.dataset.theme = resolved;
      root.dataset.themePreference = preference;
    }
    for (const listener of listeners) listener({ preference, resolved });
    return resolved;
  }

  function set(next) {
    if (!THEME_PREFERENCES.includes(next)) return apply();
    preference = next;
    try {
      storage?.setItem(STORAGE_KEY, next);
    } catch {
      // A storage that refuses to remember the choice is not a reason to refuse the choice.
    }
    return apply();
  }

  function toggle() {
    const resolved = root?.dataset.theme ?? resolveTheme(preference, Boolean(query?.matches));
    return set(resolved === 'dark' ? 'light' : 'dark');
  }

  // The editor switches theme from three places (the top bar, the status bar, the palette), so
  // the store owns the OS listener rather than any one component.
  query?.addEventListener?.('change', () => {
    if (preference === 'system') apply();
  });

  apply();

  return {
    get preference() {
      return preference;
    },
    get resolved() {
      return root?.dataset.theme ?? resolveTheme(preference, Boolean(query?.matches));
    },
    set,
    toggle,
    apply,
    // A listener that arrives late still gets the current state, so a component that subscribes
    // in onMounted does not have to also read the store once by hand.
    subscribe(listener) {
      listeners.add(listener);
      listener({ preference, resolved: root?.dataset.theme ?? resolveTheme(preference, Boolean(query?.matches)) });
      return () => listeners.delete(listener);
    },
  };
}
