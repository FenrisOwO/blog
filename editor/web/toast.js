// Notifications.
//
// One place decides how long a message stays, how it is classified, and that the same message
// never stacks twice. Errors carry "what happened / why / what to do next" instead of a stack
// trace, which is the only form of error a user of this editor can act on.

export const TOAST_KINDS = ['success', 'info', 'warning', 'error'];

const DEFAULT_TIMEOUTS = { success: 4000, info: 5000, warning: 8000, error: 12000 };

export function createToastStore({ now = () => Date.now(), timeouts = DEFAULT_TIMEOUTS } = {}) {
  const items = [];
  const listeners = new Set();
  let nextId = 1;

  function emit() {
    for (const listener of listeners) listener([...items]);
  }

  function push(kind, title, { text = '', timeout = null, action = null, key = null } = {}) {
    const type = TOAST_KINDS.includes(kind) ? kind : 'info';
    if (key) {
      const existing = items.findIndex((item) => item.key === key);
      if (existing !== -1) items.splice(existing, 1);
    }
    const entry = {
      id: nextId++,
      kind: type,
      title,
      text,
      action,
      key,
      at: now(),
      timeout: timeout ?? timeouts[type] ?? 5000,
    };
    items.push(entry);
    emit();
    return entry.id;
  }

  function dismiss(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index !== -1) {
      items.splice(index, 1);
      emit();
    }
  }

  function clear() {
    items.length = 0;
    emit();
  }

  return {
    get items() {
      return items;
    },
    push,
    dismiss,
    clear,
    success: (title, options) => push('success', title, options),
    info: (title, options) => push('info', title, options),
    warning: (title, options) => push('warning', title, options),
    error: (title, options) => push('error', title, options),
    subscribe(listener) {
      listeners.add(listener);
      listener([...items]);
      return () => listeners.delete(listener);
    },
  };
}
