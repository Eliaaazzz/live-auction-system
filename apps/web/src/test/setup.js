import '@testing-library/jest-dom/vitest';

// Vitest 4 + jsdom 29 ships a `localStorage` global that has `getItem` /
// `setItem` but is missing `removeItem` / `clear` on the prototype. Patch
// with a tiny in-memory Storage shim so tests can reset between runs.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.removeItem !== 'function') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}
