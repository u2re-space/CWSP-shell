/*
 * Filename: sw-window-polyfill.ts
 * FullPath: apps/CWSP-shell/src/crx/sw-window-polyfill.ts
 * Change date and time: 14.45.00_19.07.2026
 * Reason for changes: MV3 SW has no `window`; Vite __vitePreload uses window.dispatchEvent.
 */

/**
 * WHY: Rolldown/Vite inject `__vitePreload` that does bare `window.dispatchEvent` on
 * dynamic-import failures. In the service worker that throws
 * `ReferenceError: window is not defined` and masks the real error.
 *
 * INVARIANT: must be the first import of `sw.ts` so it runs before Coordinator / fest.
 * Alias `window` → `globalThis` only when missing (never overwrite a real Window).
 */
const g = globalThis as typeof globalThis & { window?: typeof globalThis };

if (typeof g.window === "undefined") {
    g.window = g;
}

export {};
