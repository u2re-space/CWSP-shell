/*
 * Filename: environment-shell.ts
 * FullPath: apps/CWSP-shell/src/frontend/ai-slop/window/environment-shell.ts
 * Change date and time: 07.15.00_29.07.2026
 * Reason for changes: Fix env-shell-container createElement crash that aborted mount.
 */
/**
 * WHY: Hybrid SoT (plan 1C): wallpaper / SpeedDial / OrientDesktop / taskbar / statusbar /
 * `ui-window` layer come from `environment-shell` modules; CWSP views load from app `views/*`.
 *
 * INVARIANT: Do **not** mount workspace under `cw-shell-*` closed/open shadow. Document-adopted
 * SpeedDial + viewer SCSS cannot pierce that shadow — labels/toolbars look “unstyled”.
 * Match `environment-shell/demo/boot.ts`: `<env-shell-container>` + light-DOM slotted layers.
 */
import { observe, ref } from "fest/object";
import { preloadStyle, loadInlineStyle } from "fest/dom";
import { ensureStyleSheet } from "fest/icon";
import { initializeAppCanvasLayer } from "fest/image";
import type { ShellId, ShellLayoutConfig, ViewId, ViewOptions } from "shells/types";
import { ShellBase } from "boot/shells";
import { SHELL_SLOT } from "boot/shell-slots";
import { initBootShellWindowActivity } from "boot/shell-preference";
import { isEnabledView } from "com/routing/core/views";
import {
    createEnvironmentShellContainer,
    createWorkspaceWindowLayer,
    defineEnvironmentShellContainer,
    mountEnvironmentChrome,
    seedEnvironmentWallpaperIfUnset,
    type EnvWindowTaskDescriptor,
    type WorkspaceViewLoaderMap
} from "../../shells/environment/index";
import { mountViewModule } from "../../shells/environment/window/views/view-mount";

// @ts-ignore — Material-ish tokens used by env chrome / home
import wfDemoCss from "../../../../../../modules/shells/window-frame/public/demo/wf-demo.css?inline";
// @ts-ignore — shell chrome styles (document-level)
import envShellStyles from "../../shells/environment/scss/main.scss?inline";

defineEnvironmentShellContainer();

const CWSP_VIEW_LOADERS: WorkspaceViewLoaderMap = {
    network: () => import("views/network") as any,
    settings: () => import("views/settings") as any,
    explorer: () => import("views/explorer") as any,
    viewer: () => import("views/viewer") as any,
    markdown: () => import("views/viewer") as any,
    history: () => import("views/history") as any,
    workcenter: () => import("views/workcenter") as any,
    editor: () => import("views/editor") as any,
    home: () => import("views/home") as any
};

/** Views allowed as Speed Dial / floating windows (no airpad). */
const CWSP_LAUNCHER_VIEWS = [
    "home",
    "network",
    "settings",
    "explorer",
    "viewer",
    "history",
    "workcenter",
    "editor"
] as const;

async function seedCwspLauncherTiles(): Promise<void> {
    try {
        const mod = await import("views/home/ts/launcher-state");
        const items = mod.speedDialItems as any;
        if (!items || typeof items.findIndex !== "function") return;

        let removedAirpad = false;
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            const view = String(it?.meta?.view || "").toLowerCase();
            const id = String(it?.id || "").toLowerCase();
            if (view === "airpad" || id.includes("airpad")) {
                items.splice(i, 1);
                removedAirpad = true;
            }
        }

        const ensure = (
            id: string,
            cell: [number, number],
            icon: string,
            label: string,
            view: string
        ): void => {
            if (!isEnabledView(view) && view !== "home") return;
            const exists = items.find?.(
                (it: any) =>
                    String(it?.id) === id ||
                    String(it?.meta?.view || "").toLowerCase() === view
            );
            if (exists) return;
            mod.addSpeedDialItem({
                id,
                cell: observe(cell) as any,
                icon,
                label,
                action: "open-view",
                meta: { view }
            } as any);
        };

        ensure("shortcut-network", [0, 0], "wifi-high", "Network", "network");
        ensure("shortcut-settings", [1, 0], "gear-six", "Settings", "settings");
        ensure("shortcut-explorer", [2, 0], "books", "Explorer", "explorer");
        ensure("shortcut-viewer", [3, 0], "article", "Markdown", "viewer");
        ensure("shortcut-history", [0, 1], "clock-counter-clockwise", "History", "history");

        if (removedAirpad) mod.persistSpeedDialItems?.();
    } catch (err) {
        console.warn("[EnvironmentShell] speed-dial seed skipped", err);
    }
}

export class EnvironmentShell extends ShellBase {
    id: ShellId = "environment";
    name = "Environment";
    layout: ShellLayoutConfig = {
        hasSidebar: false,
        hasToolbar: false,
        hasTabs: false,
        supportsMultiView: true,
        supportsWindowing: true
    };

    private workspaceEl: HTMLElement | null = null;
    private homeMountEl: HTMLElement | null = null;
    private windowLayer: ReturnType<typeof createWorkspaceWindowLayer> | null = null;
    private chromeDispose: (() => void) | null = null;
    private homeUnmount: (() => void) | null = null;
    private shellActivityDispose: (() => void) | null = null;
    private focusedTaskId = ref<string>("home");
    private setFocusedTaskId: ((id: string) => void) | null = null;
    private syncWindowTasks: ((windows: EnvWindowTaskDescriptor[]) => void) | null = null;
    private navEcho = ref("");
    private mqLabel = ref("desktop");

    /** Unused — light-DOM mount builds nodes imperatively (see {@link mount}). */
    protected createLayout(): HTMLElement {
        return document.createElement("div");
    }

    protected getStylesheet(): string | null {
        return envShellStyles as unknown as string;
    }

    /**
     * Light-DOM environment host (demo parity). Avoids `cw-shell-environment` shadow so
     * document-adopted SpeedDial / viewer / veela styles reach launcher + window bodies.
     */
    async mount(container: HTMLElement): Promise<void> {
        if (this.mounted) {
            console.warn(`[${this.id}] Shell already mounted`);
            return;
        }
        this.container = container;
        seedEnvironmentWallpaperIfUnset("/assets/stock.jpg");
        defineEnvironmentShellContainer();

        // Document-level styles (not shadow-only).
        try {
            await preloadStyle(wfDemoCss as unknown as string);
            loadInlineStyle(wfDemoCss as unknown as string);
        } catch (err) {
            console.warn("[EnvironmentShell] wf-demo tokens failed", err);
        }
        const envCss = this.getStylesheet();
        if (envCss) {
            try {
                await preloadStyle(envCss);
                loadInlineStyle(envCss);
            } catch (err) {
                console.warn("[EnvironmentShell] env shell styles failed", err);
            }
        }
        try {
            ensureStyleSheet();
        } catch {
            /* icons optional */
        }

        // WHY: never set attrs inside CE constructor; create via factory then style host here.
        const host = createEnvironmentShellContainer();
        host.className = "env-shell-root wf-demo-root";
        host.setAttribute("data-shell", "environment");
        host.setAttribute("data-shell-system", "task-tab");
        host.style.gridColumn = "content-column";
        host.style.gridRow = "content-row";
        host.style.alignSelf = "stretch";
        host.style.justifySelf = "stretch";
        host.style.minInlineSize = "0";
        host.style.minBlockSize = "0";
        host.style.inlineSize = "100%";
        host.style.blockSize = "100%";
        host.style.pointerEvents = "auto";

        const wallpaper = document.createElement("div");
        wallpaper.slot = SHELL_SLOT.underlying;
        wallpaper.className = "env-shell-wallpaper";
        wallpaper.setAttribute("data-env-wallpaper", "");

        const workspace = document.createElement("div");
        workspace.className = "env-shell-workspace";
        workspace.setAttribute("data-shell-content", "");

        const homeMount = document.createElement("div");
        homeMount.className = "env-shell-home-mount";
        homeMount.style.display = "flex";
        homeMount.style.flex = "1 1 auto";
        homeMount.style.flexDirection = "column";
        homeMount.style.alignSelf = "stretch";
        homeMount.style.minHeight = "0";
        homeMount.style.minWidth = "0";
        workspace.appendChild(homeMount);

        host.append(wallpaper, workspace);
        container.replaceChildren(host);

        this.rootElement = host as any;
        this.workspaceEl = workspace;
        this.homeMountEl = homeMount;
        this.contentContainer = workspace;
        this.overlayContainer =
            (host as any).overlayMount ??
            host.shadowRoot?.querySelector?.("[data-shell-overlays]") ??
            null;
        this.mounted = true;
        this.shellActivityDispose = initBootShellWindowActivity(this.id);

        try {
            initializeAppCanvasLayer(wallpaper);
        } catch (err) {
            console.warn("[EnvironmentShell] wallpaper init failed", err);
        }

        const loaders: WorkspaceViewLoaderMap = {};
        for (const id of CWSP_LAUNCHER_VIEWS) {
            if (id === "home") continue;
            if (!isEnabledView(id) && id !== "viewer") continue;
            const loader = CWSP_VIEW_LOADERS[id];
            if (loader) loaders[id] = loader;
        }
        if (loaders.viewer) loaders.markdown = loaders.viewer;

        const mobileMq = matchMedia("(max-width: 640px)");
        this.mqLabel.value = mobileMq.matches ? "mobile" : "desktop";
        mobileMq.addEventListener("change", () => {
            this.mqLabel.value = mobileMq.matches ? "mobile" : "desktop";
        });

        const chrome = mountEnvironmentChrome(host, {
            shell: {
                selectedPath: ref(""),
                viewerStatus: ref(""),
                navEcho: this.navEcho,
                mqLabel: this.mqLabel
            },
            introHtml: `<p><strong>CWSP environment</strong> — Speed Dial / desktop launcher. Views open in <code>ui-window</code>.</p>`,
            taskbar: {
                focusedTaskId: this.focusedTaskId,
                onHome: () => this.focusHome(),
                onViewer: () => {
                    void this.openInWindow("viewer");
                },
                onWindowTask: (viewId) => {
                    void this.openInWindow(viewId);
                }
            }
        });
        this.setFocusedTaskId = chrome.taskbar?.setFocusedTaskId ?? null;
        this.syncWindowTasks = chrome.taskbar?.syncWindowTasks ?? null;
        this.chromeDispose = () => {
            chrome.disposeDevice();
            chrome.taskbar?.dispose?.();
            chrome.root.remove();
        };

        this.windowLayer = createWorkspaceWindowLayer(workspace, {
            overlayMountHost: host,
            environmentShellHost: host,
            viewLoaders: loaders,
            viewTitles: {
                network: "Network",
                settings: "Settings",
                explorer: "Explorer",
                viewer: "Markdown",
                history: "History",
                workcenter: "Work Center",
                editor: "Editor"
            },
            onTaskingChange: (windows) => {
                this.syncWindowTasks?.(windows);
                const focused = windows.find((w) => w.focused);
                if (focused) this.setFocusedTaskId?.(focused.id);
            }
        });

        const shellContext = {
            ...this.windowLayer.shellContext,
            navigate: (viewId: string, opts?: ViewOptions) => {
                this.navEcho.value = `shell.navigate("${viewId}")`;
                void this.routeView(String(viewId), opts);
            },
            openView: (viewId: string, opts?: ViewOptions) => {
                this.navEcho.value = `shell.openView("${viewId}")`;
                void this.routeView(String(viewId), opts);
            },
            showMessage: (msg: unknown) => {
                this.showMessage(typeof msg === "string" ? msg : String(msg ?? ""));
            }
        };

        void seedCwspLauncherTiles();

        void mountViewModule(() => import("views/home") as any, homeMount, { shellContext })
            .then((unmount) => {
                this.homeUnmount = unmount;
            })
            .catch((err) => {
                console.warn("[EnvironmentShell] home-view failed", err);
                homeMount.innerHTML =
                    `<p style="color:#eee;padding:1rem;font-family:system-ui">Home view failed to load.</p>`;
            });
    }

    private focusHome(): void {
        this.windowLayer?.blurWindows?.();
        this.setFocusedTaskId?.("home");
        this.focusedTaskId.value = "home";
        this.currentView.value = "home" as ViewId;
    }

    private openInWindow(viewId: string, opts?: ViewOptions): void {
        const id = String(viewId || "").trim().toLowerCase();
        if (!id || id === "airpad") return;
        if (!this.windowLayer?.focusWindow(id)) {
            void this.windowLayer?.shellContext.openView?.(id, opts);
        }
        this.setFocusedTaskId?.(id === "markdown" ? "viewer" : id);
        this.currentView.value = id as ViewId;
    }

    private async routeView(viewId: string, opts?: ViewOptions): Promise<void> {
        const id = String(viewId || "").trim().toLowerCase();
        if (!id || id === "airpad") return;
        if (id === "home") {
            this.focusHome();
            return;
        }
        this.openInWindow(id, opts);
    }

    async navigate(
        viewId: ViewId,
        params?: Record<string, string>,
        _navOptions?: unknown
    ): Promise<void> {
        const id = String(viewId || "home").toLowerCase();
        if (id === "airpad") {
            this.showMessage("AirPad view is disabled in environment shell");
            return;
        }
        if (id === "home") {
            this.focusHome();
            try {
                const searchParams = new URLSearchParams(params || {});
                searchParams.set("shell", this.id);
                const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
                const next = `${location.pathname}${search}`;
                if (`${location.pathname}${location.search}` !== next) {
                    history.replaceState({ viewId: "home", params }, "", next);
                }
            } catch {
                /* ignore */
            }
            return;
        }
        this.openInWindow(id, params ? ({ params } as ViewOptions) : undefined);
    }

    unmount(): void {
        try {
            this.homeUnmount?.();
        } catch {
            /* ignore */
        }
        this.homeUnmount = null;
        try {
            this.windowLayer?.dispose();
        } catch {
            /* ignore */
        }
        this.windowLayer = null;
        try {
            this.chromeDispose?.();
        } catch {
            /* ignore */
        }
        this.chromeDispose = null;
        try {
            this.shellActivityDispose?.();
        } catch {
            /* ignore */
        }
        this.shellActivityDispose = null;

        if (this.mounted && this.container && this.rootElement) {
            try {
                if (this.container.contains(this.rootElement)) {
                    this.rootElement.remove();
                }
            } catch {
                /* ignore */
            }
        }
        this.rootElement = null;
        this.contentContainer = null;
        this.overlayContainer = null;
        this.workspaceEl = null;
        this.homeMountEl = null;
        this.container = null;
        this.mounted = false;
    }
}

export function createEnvironmentShell(_container: HTMLElement): EnvironmentShell {
    return new EnvironmentShell();
}

export default createEnvironmentShell;
