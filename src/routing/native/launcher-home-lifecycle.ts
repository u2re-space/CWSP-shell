/*
 * Filename: launcher-home-lifecycle.ts
 * FullPath: apps/CWSP-shell/src/routing/native/launcher-home-lifecycle.ts
 * Change date and time: 20.05.00_20.08.2026
 * Reason for changes: CWSP Launcher — HOME + Share/VIEW pin-to-desktop lifecycle.
 */

import {
    launcherConsumePendingPin,
    type LauncherPendingPin
} from "com/routing/native/launcher-bridge";

export type LauncherHomeLifecycleHooks = {
    navigateHome?: () => void;
    openAppMenu?: () => void;
    closeAppMenu?: () => void;
    isAppMenuOpen?: () => boolean;
    focusSpeedDial?: () => void;
    /** Modals, switcher, explorer menus — return true when back was handled. */
    tryConsumeBack?: () => boolean;
};

const HOOKS_BOOT = "__CWSP_LAUNCHER_HOME_HOOKS_V1__";
const GLOBAL_API = "__CWSP_LAUNCHER_HOME__";

const hookSlot = (): {
    get(): LauncherHomeLifecycleHooks | null;
    set(v: LauncherHomeLifecycleHooks | null): void;
} => {
    const g = globalThis as Record<string, LauncherHomeLifecycleHooks | null>;
    return {
        get: () => (HOOKS_BOOT in g ? g[HOOKS_BOOT] : null),
        set: (v) => {
            g[HOOKS_BOOT] = v;
        }
    };
};

export function isLauncherSku(): boolean {
    return (
        document.documentElement.dataset.cwspShellRole === "launcher" ||
        (globalThis as { __RS_SHELL_ROLE__?: string }).__RS_SHELL_ROLE__ === "launcher"
    );
}

export function registerLauncherHomeLifecycleHooks(hooks: LauncherHomeLifecycleHooks | null): void {
    hookSlot().set(hooks);
}

export function focusLauncherSpeedDial(): void {
    const hooks = hookSlot().get();
    if (typeof hooks?.focusSpeedDial === "function") {
        hooks.focusSpeedDial();
        return;
    }
    const home = document.querySelector<HTMLElement>("#home");
    if (!home) return;
    try {
        home.focus({ preventScroll: true });
    } catch {
        try {
            home.focus();
        } catch {
            /* ignore */
        }
    }
}

export function isLauncherHomeVisible(): boolean {
    if (!isLauncherSku()) return false;
    const workspace = document.querySelector(".env-shell-workspace");
    if (!workspace) return false;

    const windows = workspace.querySelectorAll("ui-window");
    for (const node of windows) {
        if (!(node instanceof HTMLElement)) continue;
        if (
            node.hidden ||
            node.hasAttribute("hidden-window") ||
            node.hasAttribute("minimized") ||
            node.hasAttribute("data-minimized")
        ) {
            continue;
        }
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (Number.parseFloat(style.opacity || "1") <= 0) continue;
        return false;
    }

    return Boolean(document.querySelector(".env-shell-home-mount"));
}

export function handleLauncherHomePressed(): void {
    const hooks = hookSlot().get();
    hooks?.closeAppMenu?.();
    hooks?.navigateHome?.();
    focusLauncherSpeedDial();
}

export function handleLauncherBackPress(): boolean {
    if (!isLauncherSku()) return false;
    const hooks = hookSlot().get();

    if (hooks?.isAppMenuOpen?.()) {
        hooks.closeAppMenu?.();
        return true;
    }

    if (hooks?.tryConsumeBack?.()) {
        return true;
    }

    if (!isLauncherHomeVisible()) {
        /* Collapse open app — not the HOME intent (no focusSpeedDial). */
        hooks?.navigateHome?.();
        return true;
    }

    /* On desktop home — consume; do not fall through to WebView.goBack(). */
    return true;
}

let lastPinKey = "";
let lastPinAt = 0;

async function applyPinPayload(raw: LauncherPendingPin | Record<string, unknown> | null | undefined): Promise<boolean> {
    if (!raw || typeof raw !== "object") return false;
    const url = String(
        (raw as LauncherPendingPin).url ||
            (raw as LauncherPendingPin).href ||
            (raw as LauncherPendingPin).intentUri ||
            ""
    ).trim();
    const pkg = String((raw as LauncherPendingPin).packageName || "").trim();
    const shortcutId = String((raw as LauncherPendingPin).shortcutId || "").trim();
    if (!url && !pkg) return false;
    const key = `${url}::${pkg}::${shortcutId}::${String((raw as LauncherPendingPin).label || "")}`;
    const now = Date.now();
    /* WHY: only dedupe successful pins — failed attempts must retry (boot race). */
    if (key === lastPinKey && now - lastPinAt < 2500) return false;

    try {
        const mod = await import("fl-ui/speed-dial/launcher-state");
        /* WHY: wait for OPFS hydrate so pin is not spliced away mid-boot. */
        try {
            await mod.linkStoreReady?.();
        } catch {
            /* OPFS optional */
        }
        const pinArgs = {
            url,
            href: url,
            intentUri: String((raw as LauncherPendingPin).intentUri || "").trim() || undefined,
            label: String((raw as LauncherPendingPin).label || "").trim() || undefined,
            text: String((raw as LauncherPendingPin).text || "").trim() || undefined,
            source: String((raw as LauncherPendingPin).source || "intent"),
            action: String((raw as LauncherPendingPin).action || "").trim() || undefined,
            packageName: pkg || undefined,
            componentName: String((raw as LauncherPendingPin).componentName || "").trim() || undefined,
            mimeType: String((raw as LauncherPendingPin).mimeType || "").trim() || undefined,
            shortcutId: String((raw as LauncherPendingPin).shortcutId || "").trim() || undefined,
            iconUrl: String((raw as LauncherPendingPin & { iconUrl?: string }).iconUrl || "").trim() || undefined,
            iconDisplay: String((raw as LauncherPendingPin & { iconDisplay?: string }).iconDisplay || "").trim() || undefined
        };
        let pinned = mod.pinSpeedDialLinkFromIntent(pinArgs);
        if (!pinned) return false;
        try {
            await mod.flushSpeedDialLinkStore?.();
        } catch {
            /* LS already written by addSpeedDialItem */
        }
        /* WHY: dual-graph hydrate could still race; re-pin once if the tile vanished. */
        const pinnedId = String(pinned.id || "");
        if (pinnedId) {
            await new Promise((r) => setTimeout(r, 320));
            if (!mod.hasSpeedDialItemId?.(pinnedId)) {
                console.warn("[launcher] pin tile missing after hydrate race — re-pinning");
                pinned = mod.pinSpeedDialLinkFromIntent(pinArgs);
                try {
                    await mod.flushSpeedDialLinkStore?.();
                } catch {
                    /* ignore */
                }
            }
        }
        if (!pinned) return false;
        lastPinKey = key;
        lastPinAt = Date.now();
        handleLauncherHomePressed();
        try {
            const toast = await import("fl-ui/speed-dial/toast");
            toast.showSuccess?.(`Added “${String(pinned.label?.value || pinned.label || "shortcut")}” to desktop`);
        } catch {
            /* toast optional */
        }
        return true;
    } catch (e) {
        console.warn("[launcher] pin shortcut failed", e);
        return false;
    }
}

function parsePinEventDetail(detail: unknown): LauncherPendingPin | null {
    if (!detail) return null;
    if (typeof detail === "string") {
        try {
            const parsed = JSON.parse(detail);
            return parsed && typeof parsed === "object" ? (parsed as LauncherPendingPin) : null;
        } catch {
            return null;
        }
    }
    if (typeof detail === "object") return detail as LauncherPendingPin;
    return null;
}

async function consumePendingPinSoon(): Promise<void> {
    const tryOnce = async (): Promise<void> => {
        try {
            const pin = await launcherConsumePendingPin();
            if (pin) await applyPinPayload(pin);
        } catch {
            /* ignore */
        }
    };
    await tryOnce();
    /* WHY: WebView may receive the Intent before home-view modules finish hydrating. */
    window.setTimeout(() => {
        void tryOnce();
    }, 800);
    window.setTimeout(() => {
        void tryOnce();
    }, 2500);
}

let installed = false;

export function installLauncherHomeLifecycle(): void {
    if (installed || !isLauncherSku()) return;
    installed = true;

    const api = {
        isHomeVisible: isLauncherHomeVisible,
        handleHomePressed: handleLauncherHomePressed,
        handleBackPress: handleLauncherBackPress,
        openAppMenu: () => {
            hookSlot().get()?.openAppMenu?.();
        },
        pinShortcut: (payload: LauncherPendingPin) => {
            void applyPinPayload(payload);
        }
    };
    (globalThis as Record<string, unknown>)[GLOBAL_API] = api;

    window.addEventListener("launcherHomePressed", () => {
        handleLauncherHomePressed();
    });

    window.addEventListener("launcherPinShortcut", ((ev: Event) => {
        const detail = (ev as CustomEvent).detail ?? (ev as { data?: unknown }).data;
        const pin = parsePinEventDetail(detail);
        void applyPinPayload(pin);
    }) as EventListener);

    void consumePendingPinSoon();
}
