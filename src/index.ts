/**
 * CWSP-shell Main Entry Point
 *
 * Canonical URL mode:
 * - pathname always `/`
 * - legacy `/${view}` routes are accepted as entry links and normalized to `/`
 * - active view/process is stored in `history.state` and (for focused windows) in `location.hash`
 */

import { initPWA, checkForUpdates, forceRefreshAssets } from "core/pwa/pwa-handling";
import type { ShellId, ViewId } from "shared/boot/types";
import { initializeLayers } from "shared/routing/layer-manager";
import { pickEnabledView } from "shared/routing/views";
import { loadAsAdopted } from "fest/dom";
import { ensureAppLayers } from "shared/routing/app-layers";

// Import PWA handlers
import {
    ensureAppCss,
    initServiceWorker,
    initReceivers,
    handleShareTarget,
    setupLaunchQueueConsumer,
    checkPendingShareData
} from "core/pwa/sw-handling";

// Import uniform channel manager
// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get normalized pathname (remove base href)
 */
const getNormalizedPathname = (): string => {
    const pathname = location.pathname || '';
    const baseElement = document.querySelector('base');
    const baseHref = baseElement?.getAttribute('href') || '/';

    let normalizedPath = pathname;
    if (baseHref !== '/' && pathname.startsWith(baseHref.replace(/\/$/, ''))) {
        normalizedPath = pathname.slice(baseHref.replace(/\/$/, '').length);
    }

    return normalizedPath.replace(/^\/+|\/+$/g, '').toLowerCase();
};

const isExtension = (): boolean => {
    try {
        const location = globalThis.location;
        const chromeApi = (globalThis as any).chrome;
        return location.protocol === "chrome-extension:" || Boolean(chromeApi?.runtime?.id);
    } catch {
        return false;
    }
};

const isPwaDisplayMode = (): boolean => {
    if (isExtension()) return false;
    return matchMedia("(display-mode: standalone)").matches ||
           (globalThis?.navigator as any)?.standalone === true;
};

// ============================================================================
// LOADING STATE MANAGEMENT
// ============================================================================

const setLoadingState = (mountElement: HTMLElement, message: string = "Loading...") => {
    mountElement.innerHTML = `
        <div class="app-loading" style="
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            inline-size: 100%;
            block-size: 100%;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 1.1rem;
            color: #666;
            background: #fff;
            position: absolute;
            inset: 0;
            z-index: 10000;
        ">
            <div class="loading-spinner" style="
                inline-size: 32px;
                block-size: 32px;
                border: 3px solid #f3f3f3;
                border-top: 3px solid #007acc;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin-bottom: 1rem;
            "></div>
            <div class="loading-text">${message}</div>
            <style>
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        </div>
    `;
};

const clearLoadingState = (mountElement: HTMLElement) => {
    const loading = mountElement.querySelector('.app-loading') as HTMLElement | null;
    if (loading) {
        loading.style.transition = 'opacity 0.3s ease-out';
        loading.style.opacity = '0';
        setTimeout(() => loading.remove(), 300);
    }
    /* index.html static splash (not wrapped in .app-loading) */
    mountElement.querySelector(":scope > .loading-spinner")?.remove();
    mountElement.querySelector(":scope > .loading-message")?.remove();
};

const showErrorState = (mountElement: HTMLElement, error: any, retryFn?: () => void) => {
    const errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
    mountElement.innerHTML = `
        <div class="app-error" style="
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            inline-size: 100%;
            block-size: 100%;
            padding: 2rem;
            font-family: system-ui, sans-serif;
            text-align: center;
            background: #fff;
            color: #333;
        ">
            <div style="font-size: 3rem; margin-bottom: 1rem;">⚠️</div>
            <h2 style="margin: 0 0 1rem 0; color: #d32f2f;">Application Error</h2>
            <p style="margin: 0 0 1.5rem 0; color: #666; max-inline-size: 500px;">${errorMessage}</p>
            ${retryFn ? `<button data-action="retry" style="
                padding: 0.75rem 1.5rem;
                background: #007acc;
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 1rem;
                cursor: pointer;
                margin-bottom: 1rem;
            ">Try Again</button>` : ''}
            <button data-action="reload" style="
                padding: 0.5rem 1rem;
                background: #666;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 0.9rem;
                cursor: pointer;
            ">Reload Page</button>
        </div>
    `;

    const retryBtn = mountElement.querySelector('[data-action="retry"]') as HTMLButtonElement | null;
    if (retryBtn && retryFn) {
        retryBtn.addEventListener("click", retryFn);
    }

    const reloadBtn = mountElement.querySelector('[data-action="reload"]') as HTMLButtonElement | null;
    if (reloadBtn) {
        reloadBtn.addEventListener("click", () => location.reload());
    }
};

const withTimeout = async <T>(
    task: Promise<T>,
    label: string,
    timeoutMs: number,
    fallback: T,
    options: { warnOnTimeout?: boolean } = {}
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const warnOnTimeout = options.warnOnTimeout !== false;
    try {
        return await Promise.race<T>([
            task,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => {
                    const log = warnOnTimeout ? console.warn : console.info;
                    log(`[Index] ${label} timed out after ${timeoutMs}ms`);
                    resolve(fallback);
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

// ============================================================================
// MAIN INDEX FUNCTION
// ============================================================================

export default async function index(mountElement: HTMLElement) {
    // CRITICAL: Initialize CSS layer hierarchy FIRST
    // This must happen before any styles are loaded
    initializeLayers();

    // WHY: Keep `shells/boot` off the static graph of this module so `html-boot` can `import(index.ts)`
    // quickly over slow LAN / reverse-proxy dev — the barrel pulls registry + BootLoader + routing.
    const viewMod = await import("boot/ts/views.scss?inline");
    await loadAsAdopted(viewMod.default);

    //
    console.log('[Index] Starting CWSP-shell frontend loader');

    // Initialize uniform channel manager
    console.log('[Index] Initializing uniform channels...');
    //initializeAppChannels();
    /* Hub CWSP socket: gated by Settings → shell.maintainHubSocketConnection (default off).
     * {@link BootLoader} calls applyHubSocketFromSettings after loadSettings — avoid duplicate preload here. */

    setLoadingState(mountElement, 'Initializing CWSP-shell...');

    try {
        const {
            loadSubAppWithShell,
            VALID_VIEWS,
            getShellFromQuery,
            getSavedShellPreference
        } = await import("shells/boot");

        const isValidViewPath = (path: string): path is ViewId =>
            (VALID_VIEWS as readonly string[]).includes(path);

        // Initialize PWA features (non-blocking)
        const pwaPromise = initPWA();

        // Load CSS (non-extension only)
        if (!isExtension()) {
            setLoadingState(mountElement, 'Loading styles...');
            await ensureAppCss();
        }

        // Initialize broadcast receivers
        initReceivers();
        handleShareTarget();
        // SW is initialized by initPWA(); avoid dual SW managers causing update loops.
        // Keep pre-shell work short so the shell spinner / first paint stays < ~3s on slow devices.
        const PRE_SHELL_BUDGET_MS = 1200;
        try {
            await Promise.race([
                Promise.all([
                    withTimeout(setupLaunchQueueConsumer(), "setupLaunchQueueConsumer", PRE_SHELL_BUDGET_MS, undefined),
                    withTimeout(checkPendingShareData(), "checkPendingShareData", PRE_SHELL_BUDGET_MS, null)
                ]),
                new Promise<void>((r) => globalThis.setTimeout(r, PRE_SHELL_BUDGET_MS))
            ]);
        } catch (e) {
            console.warn("[Index] Pre-boot share/launch queue failed:", e);
        }

        // Warm viewer markdown engine chunk early when route targets viewer (non-blocking).
        const prePath = getNormalizedPathname();
        if (!prePath || prePath === "viewer" || prePath === "share-target" || prePath === "share_target") {
            void import("views/viewer")
                .then((m: { warmViewerMarkdownEngine?: () => void }) => m.warmViewerMarkdownEngine?.())
                .catch(() => { /* optional */ });
        }
        void withTimeout(pwaPromise, "initPWA", 5000, null, { warnOnTimeout: false })
            .then(() => {
                console.log('[Index] PWA initialization complete');
            })
            .catch((error) => {
                console.warn('[Index] PWA initialization failed (non-blocking):', error);
            });

        // Get current route
        const pathname = getNormalizedPathname();
        const urlParams = new URLSearchParams(globalThis?.location?.search);
        const sharedFlag = urlParams.get('shared');
        const markdownContent = urlParams.get('markdown-content');

        console.log('[Index] Route:', pathname || '(root)');

        // ====================================================================
        // ROUTE HANDLING (canonical root)
        // ====================================================================

        // Legacy /{view} links are accepted as entry points.
        const isLegacyViewRoute = Boolean(pathname && isValidViewPath(pathname));
        // Explicit `?view=<id>` selects the initial view (Capacitor minimal shell
        // boots Network status this way; also matches the minimal-shell demo convention).
        const queryViewRaw = urlParams.get("view");
        const queryView: ViewId | null =
            queryViewRaw && isValidViewPath(queryViewRaw) ? pickEnabledView(queryViewRaw as ViewId, "home") : null;
        const explicitRequestedView: ViewId | null = queryView
            ? queryView
            : isLegacyViewRoute
                ? pickEnabledView(pathname as ViewId, "home")
                : (sharedFlag === "1" || sharedFlag === "true" || markdownContent)
                    ? pickEnabledView("viewer", "home")
                    : null;
        // WHY: u2re.space (`vds-main`) always boots environment — never honor ?shell=minimal.
        const forceEnvironmentSurface =
            document.documentElement.dataset.cwspSurface === "vds-main";
        const queryShell = forceEnvironmentSurface ? null : getShellFromQuery();
        if (queryShell) {
            try {
                localStorage.setItem("rs-boot-shell", queryShell);
            } catch {
                /* localStorage unavailable */
            }
        }
        if (forceEnvironmentSurface) {
            try {
                localStorage.setItem("rs-boot-shell", "environment");
            } catch {
                /* localStorage unavailable */
            }
        }
        const nativeMono =
            urlParams.get("native") === "1" || urlParams.get("native") === "true";
        const preferredShell: ShellId = forceEnvironmentSurface
            ? "environment"
            : queryShell ||
              (explicitRequestedView === "print"
                  ? "base"
                  : // WHY: mono native tasks need environment ui-window layer (WCO / full-bleed).
                    nativeMono
                      ? "environment"
                      : (getSavedShellPreference() ?? "environment"));
        // WHY: environment / window shells open on home (Speed Dial); minimal keeps Capacitor Network home.
        // Mono `?native=1` with `/explorer` (or ?view=) opens that view in native-mode window.
        const requestedView = explicitRequestedView || (
            preferredShell === "minimal"
                ? pickEnabledView("network", "viewer")
                : preferredShell === "base" || preferredShell === "immersive"
                    ? pickEnabledView("viewer", "home")
                    : pickEnabledView("home", "home")
        );
        const allowPathRoutedShell =
            preferredShell === "base" ||
            preferredShell === "minimal" ||
            preferredShell === "immersive";
        const useDesktopLayers =
            preferredShell === "window" ||
            preferredShell === "environment" ||
            preferredShell === "tabbed";
        // WHY: environment owns wallpaper via env-shell underlying `ui-canvas` — avoid a second app canvas.
        const layers = ensureAppLayers(mountElement, {
            enableOrientLayer: useDesktopLayers,
            enableCanvasLayer: preferredShell === "window" || preferredShell === "tabbed",
        });
        clearLoadingState(mountElement);

        // For window/environment/tabbed shells: normalize /{view}?params to
        // canonical root. Query params are preserved so the shell's syncInitialRoute
        // can forward them as ProcessOpenParams to the view's process window.
        // The shell will further normalize to /#pid after process creation.
        if (!allowPathRoutedShell && (isLegacyViewRoute || pathname === "share-target" || pathname === "share_target")) {
            const queryParams = Object.fromEntries(urlParams);
            const state = {
                ...(globalThis?.history?.state || {}),
                viewId: requestedView,
                params: queryParams,
                redirectedFrom: pathname || null
            };
            const search = globalThis?.location?.search || "";
            const hash = globalThis?.location?.hash || "";
            globalThis?.history?.replaceState?.(state, "", `/${search}${hash}`);
        } else if (!allowPathRoutedShell && pathname && pathname !== "") {
            const state = {
                ...(globalThis?.history?.state || {}),
                viewId: pickEnabledView("home", "home"),
                redirectedFrom: pathname
            };
            globalThis?.history?.replaceState?.(state, "", "/");
        }

        const appLoader = await loadSubAppWithShell(preferredShell, requestedView);
        await appLoader.mount(layers.shellLayer);
        return;

    } catch (error) {
        console.error('[Index] Frontend loader failed:', error);
        showErrorState(mountElement, error, () => index(mountElement));
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { checkForUpdates, forceRefreshAssets, index };
