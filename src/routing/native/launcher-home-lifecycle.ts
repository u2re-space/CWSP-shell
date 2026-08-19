/*
 * Filename: launcher-home-lifecycle.ts
 * FullPath: apps/CWSP-shell/src/routing/native/launcher-home-lifecycle.ts
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher — Android HOME intent + back-on-home lifecycle.
 */

export type LauncherHomeLifecycleHooks = {
    navigateHome?: () => void;
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

let installed = false;

export function installLauncherHomeLifecycle(): void {
    if (installed || !isLauncherSku()) return;
    installed = true;

    const api = {
        isHomeVisible: isLauncherHomeVisible,
        handleHomePressed: handleLauncherHomePressed,
        handleBackPress: handleLauncherBackPress
    };
    (globalThis as Record<string, unknown>)[GLOBAL_API] = api;

    window.addEventListener("launcherHomePressed", () => {
        handleLauncherHomePressed();
    });
}
