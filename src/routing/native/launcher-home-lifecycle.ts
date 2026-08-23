/*
 * Filename: launcher-home-lifecycle.ts
 * FullPath: apps/CWSP-shell/src/routing/native/launcher-home-lifecycle.ts
 * Change date and time: 22.18.00_23.08.2026
 * Reason for changes: Home Remove of an OS-pinned Files shortcut must stick (no import revive).
 */

import {
    launcherAckPendingPin,
    launcherConsumePendingPin,
    launcherListPinnedShortcuts,
    type LauncherPendingPin
} from "com/routing/native/launcher-bridge";

export type LauncherHomeLifecycleHooks = {
    navigateHome?: () => void;
    openAppMenu?: () => void;
    openAppMenuPage?: () => void;
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
    /* WHY: do not call hooks.focusSpeedDial — environment-shell wired that
     * back to this function and HOME/pin overflowed the stack. */
    const home =
        document.querySelector<HTMLElement>("#home") ||
        document.querySelector<HTMLElement>(".speed-dial-root");
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

let homePressDepth = 0;

export function handleLauncherHomePressed(): void {
    if (homePressDepth > 0) return;
    homePressDepth += 1;
    try {
        const hooks = hookSlot().get();
        hooks?.closeAppMenu?.();
        hooks?.navigateHome?.();
        focusLauncherSpeedDial();
    } finally {
        homePressDepth -= 1;
    }
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

function isUnsafePinHref(raw: string): boolean {
    return /^(intent:|android-app:|data:|blob:)/i.test(String(raw || "").trim());
}

async function applyPinPayload(raw: LauncherPendingPin | Record<string, unknown> | null | undefined): Promise<boolean> {
    if (!raw || typeof raw !== "object") return false;
    const incomingUrl = String(
        (raw as LauncherPendingPin).url ||
            (raw as LauncherPendingPin).href ||
            ""
    ).trim();
    /* WHY: intent: URIs must not become href — they skipped launch-shortcut and crashed persist. */
    const url = incomingUrl && !isUnsafePinHref(incomingUrl) ? incomingUrl : "";
    const pkg = String((raw as LauncherPendingPin).packageName || "").trim();
    const shortcutId = String((raw as LauncherPendingPin).shortcutId || "").trim();
    if (!url && !pkg && !shortcutId) {
        console.warn("[launcher] pin ignored: empty payload");
        return false;
    }
    const key = `${url}::${pkg}::${shortcutId}::${String((raw as LauncherPendingPin).label || "")}`;
    const now = Date.now();
    /* WHY: only dedupe successful pins — failed attempts must retry (boot race). */
    if (key === lastPinKey && now - lastPinAt < 2500) {
        console.warn("[launcher] pin deduped", key);
        return false;
    }

    try {
        const mod = await import("fl-ui/speed-dial/launcher-state");
        /* WHY: never await linkStoreReady/OPFS here — getDirectory() hangs on Cap WebView,
         * so the tile never reached addSpeedDialItem. Dirty flags already skip hydrate splice. */
        const silent = String((raw as LauncherPendingPin).source || "") === "pinned-import";
        if (pkg && shortcutId && mod.isAndroidShortcutDismissed?.(pkg, shortcutId)) {
            const stashedAt = Number((raw as LauncherPendingPin & { stashedAt?: number }).stashedAt || 0);
            const dismissedAt = Number(mod.androidShortcutDismissedAt?.(pkg, shortcutId) || 0);
            /* WHY: leftover consume has the old stash timestamp — do not revive. */
            if (silent || !stashedAt || stashedAt <= dismissedAt) {
                console.info("[launcher] pin skipped (removed)", shortcutId);
                if (!silent) {
                    try {
                        await launcherAckPendingPin();
                    } catch {
                        /* ignore */
                    }
                }
                return false;
            }
            mod.forgetDismissedAndroidShortcut?.(pkg, shortcutId);
        }
        if (silent && pkg && shortcutId && mod.findSpeedDialShortcutItem?.(pkg, shortcutId)) {
            return false;
        }
        try {
            const pages = await import("fl-ui/speed-dial/workspace-pages");
            pages.bootWorkspacePages?.();
        } catch {
            /* pages optional on non-home hosts */
        }
        const actionHint = String((raw as LauncherPendingPin).action || "").trim();
        const pinArgs = {
            url,
            href: url,
            label: String((raw as LauncherPendingPin).label || "").trim() || undefined,
            source: String((raw as LauncherPendingPin).source || "intent"),
            action:
                shortcutId && pkg && actionHint !== "launch-app"
                    ? "launch-shortcut"
                    : actionHint || undefined,
            packageName: pkg || undefined,
            componentName: String((raw as LauncherPendingPin).componentName || "").trim() || undefined,
            mimeType: String((raw as LauncherPendingPin).mimeType || "").trim() || undefined,
            shortcutId: shortcutId || undefined,
            iconDisplay: String((raw as LauncherPendingPin & { iconDisplay?: string }).iconDisplay || "").trim() || undefined
        };
        let pinned = mod.pinSpeedDialLinkFromIntent(pinArgs);
        if (!pinned) {
            console.warn("[launcher] pinSpeedDial returned null", pinArgs);
            return false;
        }
        lastPinKey = key;
        lastPinAt = Date.now();
        if (!silent) {
            try {
                await launcherAckPendingPin();
            } catch {
                /* retry consume will no-op once lastPinKey is set */
            }
        }
        void mod.flushSpeedDialLinkStore?.();
        console.info(
            "[launcher] pinned",
            String(pinned.id || ""),
            String(pinArgs.label || pinArgs.shortcutId || "")
        );
        if (!silent) handleLauncherHomePressed();
        if (!silent) {
            try {
                const toast = await import("fl-ui/speed-dial/toast");
                toast.showSuccess?.(`Added “${String(pinned.label?.value || pinned.label || "shortcut")}” to desktop`);
            } catch {
                /* toast optional */
            }
        }
        return true;
    } catch (e) {
        console.warn("[launcher] pin shortcut failed", e);
        return false;
    }
}

async function importPinnedShortcuts(): Promise<void> {
    const g = globalThis as { __CWSP_PINNED_IMPORT_V1__?: boolean };
    if (g.__CWSP_PINNED_IMPORT_V1__) return;
    g.__CWSP_PINNED_IMPORT_V1__ = true;
    try {
        const pins = await launcherListPinnedShortcuts();
        if (!pins.length) return;
        for (const pin of pins) {
            await applyPinPayload({
                ...pin,
                action: "launch-shortcut",
                source: "pinned-import"
            });
        }
    } catch (e) {
        console.warn("[launcher] import pinned failed", e);
    }
}

async function consumePendingPinSoon(): Promise<void> {
    const tryOnce = async (): Promise<void> => {
        try {
            const pin = await launcherConsumePendingPin();
            if (pin) await applyPinPayload(pin);
        } catch (e) {
            console.warn("[launcher] consume pending pin failed", e);
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
        openAppMenuPage: () => {
            hookSlot().get()?.openAppMenuPage?.();
        },
        pinShortcut: (payload: LauncherPendingPin) => {
            void applyPinPayload(payload);
        }
    };
    (globalThis as Record<string, unknown>)[GLOBAL_API] = api;

    window.addEventListener("launcherHomePressed", () => {
        handleLauncherHomePressed();
    });

    window.addEventListener("launcherPinShortcut", () => {
        /* Event is only a ping — payload stays in native stash (too large for evaluateJavascript). */
        void consumePendingPinSoon();
    });

    window.addEventListener("cwsp:speed-dial-mutation", () => {
        const g = globalThis as { __CWSP_ACK_PIN_AFTER_REMOVE__?: boolean };
        if (!g.__CWSP_ACK_PIN_AFTER_REMOVE__) return;
        g.__CWSP_ACK_PIN_AFTER_REMOVE__ = false;
        void launcherAckPendingPin();
    });

    void consumePendingPinSoon();
    void importPinnedShortcuts();
}
