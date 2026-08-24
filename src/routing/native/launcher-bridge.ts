/*
 * Filename: launcher-bridge.ts
 * FullPath: apps/CWSP-shell/src/routing/native/launcher-bridge.ts
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher SKU IPC wrappers (shell-owned native bridge).
 */
import { invokeCwsPlatformIPC } from "com/routing/native/cws-bridge";

export interface LauncherAppEntry {
    packageName: string;
    label: string;
    componentName: string;
    iconCacheKey: string;
}

export type LauncherIconVariantId = "default" | "monochrome" | "foreground";

export type LauncherIconVariantInfo = {
    id: LauncherIconVariantId | string;
    label: string;
    available: boolean;
};

type LauncherListEcho = { apps?: LauncherAppEntry[]; reason?: string };
type LauncherIconEcho = {
    base64?: string;
    mime?: string;
    cacheKey?: string;
    variant?: string;
    reason?: string;
};
type LauncherIconVariantsEcho = {
    packageName?: string;
    variants?: LauncherIconVariantInfo[];
    reason?: string;
};

export async function launcherIsDefault(): Promise<boolean> {
    const r = await invokeCwsPlatformIPC({ channel: "launcher:is-default" });
    return Boolean(r.ok && (r.echo as { isDefault?: boolean })?.isDefault);
}

export async function launcherRequestDefault(): Promise<boolean> {
    const r = await invokeCwsPlatformIPC({ channel: "launcher:request-default" });
    return r.ok === true;
}

export async function launcherList(query?: string): Promise<LauncherAppEntry[]> {
    const trimmed = query?.trim();
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:list",
        payload: trimmed ? { query: trimmed } : {}
    });
    if (!r.ok) return [];
    const echo = r.echo as LauncherListEcho | undefined;
    const apps = echo?.apps ?? (r as { apps?: LauncherAppEntry[] }).apps;
    return Array.isArray(apps) ? apps : [];
}

/** Which Android packages are installed (sibling SKU settings tabs). */
export async function launcherHasPackages(pkgs: string[]): Promise<Record<string, boolean>> {
    const packages = [
        ...new Set(pkgs.map((p) => String(p || "").trim()).filter(Boolean))
    ];
    if (!packages.length) return {};
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:has-packages",
        payload: { packages }
    });
    if (!r.ok) return {};
    const echo = r.echo as { installed?: Record<string, boolean> } | undefined;
    const installed = echo?.installed;
    return installed && typeof installed === "object" ? installed : {};
}

export async function launcherLaunch(pkg: string, component?: string): Promise<boolean> {
    const packageName = String(pkg || "").trim();
    if (!packageName) return false;
    const componentName = component?.trim();
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:launch",
        payload: componentName ? { packageName, componentName } : { packageName }
    });
    return r.ok === true;
}

/** Material Files document pins — LauncherApps.startShortcut(package, id). */
export async function launcherStartShortcut(
    pkg: string,
    shortcutId: string
): Promise<boolean> {
    const packageName = String(pkg || "").trim();
    const id = String(shortcutId || "").trim();
    if (!packageName || !id) return false;
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:start-shortcut",
        payload: { packageName, shortcutId: id }
    });
    return r.ok === true;
}

/** Shortcut-specific icon (not the publisher app icon). */
export async function launcherShortcutIcon(
    pkg: string,
    shortcutId: string,
    size = 96
): Promise<string> {
    const packageName = String(pkg || "").trim();
    const id = String(shortcutId || "").trim();
    if (!packageName || !id) return "";
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:shortcut-icon",
        payload: {
            packageName,
            shortcutId: id,
            size: Math.max(16, Math.min(512, Math.round(Number(size) || 96)))
        }
    });
    if (!r.ok) return "";
    const echo = r.echo as { base64?: string; mime?: string } | undefined;
    const base64 = String(echo?.base64 || (r as { base64?: string }).base64 || "").trim();
    if (!base64) return "";
    const mime = String(echo?.mime || (r as { mime?: string }).mime || "image/png").trim() || "image/png";
    return `data:${mime};base64,${base64}`;
}

export async function launcherIcon(
    cacheKey: string,
    size = 64,
    variant: LauncherIconVariantId | string = "default",
    pack = "",
    drawable = ""
): Promise<string> {
    const key = String(cacheKey || "").trim();
    if (!key) return "";
    const v = String(variant || "default").trim() || "default";
    const packPkg = String(pack || "").trim();
    const draw = String(drawable || "").trim();
    const payload: Record<string, unknown> = { packageName: key, cacheKey: key, size, variant: v };
    if (packPkg) {
        payload.pack = packPkg;
        payload.iconPack = packPkg;
    }
    if (draw) payload.drawable = draw;
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:icon",
        payload
    });
    if (!r.ok) return "";
    const echo = r.echo as LauncherIconEcho | undefined;
    const base64 = echo?.base64 ?? (r as { base64?: string }).base64;
    if (!base64) return "";
    const mime = echo?.mime ?? (r as { mime?: string }).mime ?? "image/png";
    return `data:${mime};base64,${base64}`;
}

/** Which adaptive / Material You variants PackageManager can supply for this package. */
export async function launcherIconVariants(cacheKey: string): Promise<LauncherIconVariantInfo[]> {
    const key = String(cacheKey || "").trim();
    if (!key) return [];
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:icon-variants",
        payload: { packageName: key, cacheKey: key }
    });
    if (!r.ok) return [];
    const echo = r.echo as LauncherIconVariantsEcho | undefined;
    const variants = echo?.variants ?? (r as { variants?: LauncherIconVariantInfo[] }).variants;
    return Array.isArray(variants) ? variants : [];
}

export type LauncherIconPackEntry = {
    packageName: string;
    label: string;
    iconCacheKey?: string;
};

type LauncherIconPacksEcho = {
    packs?: LauncherIconPackEntry[];
    reason?: string;
};

/** Installed launcher icon packs (ADW / Nova / GO theme intents). */
export async function launcherIconPacks(): Promise<LauncherIconPackEntry[]> {
    const r = await invokeCwsPlatformIPC({ channel: "launcher:icon-packs" });
    if (!r.ok) return [];
    const echo = r.echo as LauncherIconPacksEcho | undefined;
    const packs = echo?.packs ?? (r as { packs?: LauncherIconPackEntry[] }).packs;
    return Array.isArray(packs) ? packs : [];
}

export type LauncherIconPackIconEntry = {
    drawable: string;
    label: string;
};

type LauncherIconPackIconsEcho = {
    icons?: LauncherIconPackIconEntry[];
    reason?: string;
};

/** Browse drawable names declared in a pack's appfilter. */
export async function launcherIconPackIcons(
    pack: string,
    query = "",
    limit = 120
): Promise<LauncherIconPackIconEntry[]> {
    const packPkg = String(pack || "").trim();
    if (!packPkg) return [];
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:icon-pack-icons",
        payload: { pack: packPkg, packageName: packPkg, query: String(query || "").trim(), limit }
    });
    if (!r.ok) return [];
    const echo = r.echo as LauncherIconPackIconsEcho | undefined;
    const icons = echo?.icons ?? (r as { icons?: LauncherIconPackIconEntry[] }).icons;
    return Array.isArray(icons) ? icons : [];
}

/** PNG (or native mime) as blob: object URL — preferred for WebView `<img src>`. */
export async function launcherIconBlobUrl(
    cacheKey: string,
    size = 64,
    variant: LauncherIconVariantId | string = "default",
    pack = "",
    drawable = ""
): Promise<string> {
    const dataUrl = await launcherIcon(cacheKey, size, variant, pack, drawable);
    if (!dataUrl) return "";
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
    const normalized =
        blob.type === type ? blob : new Blob([await blob.arrayBuffer()], { type });
    return URL.createObjectURL(normalized);
}

export type LauncherOpenUriOptions = {
    /** Prefer a specific package (e.g. YouTube). Empty → any handler / chooser. */
    packageName?: string;
    /** When true (default) and no package, show the Android Open-with sheet. */
    chooser?: boolean;
    title?: string;
    /** MIME for content:// (e.g. text/plain) — avoids defaulting to Files. */
    mimeType?: string;
};

/** ACTION_VIEW for http(s)/deep links — browsers, YouTube, etc. */
export async function launcherOpenUri(
    uri: string,
    options: LauncherOpenUriOptions = {}
): Promise<boolean> {
    const url = String(uri || "").trim();
    if (!url) return false;
    const packageName = String(options.packageName || "").trim();
    const mimeType = String(options.mimeType || "").trim();
    const chooser = options.chooser !== false;
    const title = String(options.title || "Open with").trim() || "Open with";
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:open-uri",
        payload: {
            uri: url,
            url,
            ...(packageName ? { packageName } : {}),
            ...(mimeType ? { mimeType } : {}),
            chooser,
            title
        }
    });
    return r.ok === true;
}

export type LauncherPendingPin = {
    url?: string;
    href?: string;
    label?: string;
    text?: string;
    source?: string;
    action?: string;
    packageName?: string;
    componentName?: string;
    intentUri?: string;
    shortcutId?: string;
    mimeType?: string;
    iconUrl?: string;
    iconDisplay?: string;
    stashedAt?: number;
};

/** Peek Share / VIEW / pin-shortcut queued before the WebView was ready. */
export async function launcherConsumePendingPin(): Promise<LauncherPendingPin | null> {
    const r = await invokeCwsPlatformIPC({ channel: "launcher:pending-pin" });
    if (!r.ok) return null;
    const echo = r.echo as { pin?: LauncherPendingPin } | undefined;
    const pin = echo?.pin ?? (r as { pin?: LauncherPendingPin }).pin;
    if (!pin || typeof pin !== "object") return null;
    const url = String(pin.url || pin.href || "").trim();
    const pkg = String(pin.packageName || "").trim();
    const shortcutId = String(pin.shortcutId || "").trim();
    if (!url && !pkg && !shortcutId) return null;
    return pin;
}

/** Shortcuts the OS already pinned to this launcher (Files will not re-send them). */
export async function launcherListPinnedShortcuts(): Promise<LauncherPendingPin[]> {
    const r = await invokeCwsPlatformIPC({ channel: "launcher:list-pinned" });
    if (!r.ok) return [];
    const echo = r.echo as { shortcuts?: LauncherPendingPin[] } | undefined;
    const list = echo?.shortcuts ?? (r as { shortcuts?: LauncherPendingPin[] }).shortcuts;
    return Array.isArray(list) ? list : [];
}

/** Drop the native stash after the Speed Dial tile is actually added. */
export async function launcherAckPendingPin(): Promise<void> {
    try {
        await invokeCwsPlatformIPC({ channel: "launcher:ack-pin" });
    } catch {
        /* stash retries on next consume */
    }
}

export type AndroidWidgetProvider = {
    provider: string;
    packageName: string;
    className?: string;
    label: string;
    minWidth?: number;
    minHeight?: number;
    spanCols: number;
    spanRows: number;
    configure?: boolean;
    preview?: string;
};

export type AndroidWidgetBindResult = AndroidWidgetProvider & {
    widgetId: number;
};

export type AndroidWidgetBox = {
    widgetId: number;
    x: number;
    y: number;
    w: number;
    h: number;
};

export async function widgetList(query?: string): Promise<AndroidWidgetProvider[]> {
    const trimmed = query?.trim();
    const r = await invokeCwsPlatformIPC({
        channel: "widget:list",
        payload: trimmed ? { query: trimmed } : {}
    });
    if (!r.ok) return [];
    const echo = r.echo as { widgets?: AndroidWidgetProvider[] } | undefined;
    const widgets = echo?.widgets ?? (r as { widgets?: AndroidWidgetProvider[] }).widgets;
    return Array.isArray(widgets) ? widgets : [];
}

export async function widgetBind(provider: string): Promise<AndroidWidgetBindResult | null> {
    const id = String(provider || "").trim();
    if (!id) return null;
    const r = await invokeCwsPlatformIPC({
        channel: "widget:bind",
        payload: { provider: id, componentName: id }
    });
    if (!r.ok) return null;
    const echo = (r.echo || r) as Partial<AndroidWidgetBindResult>;
    const widgetId = Number(echo.widgetId || (r as { widgetId?: number }).widgetId || 0);
    if (!widgetId) return null;
    return {
        provider: String(echo.provider || id),
        packageName: String(echo.packageName || ""),
        label: String(echo.label || "Widget"),
        spanCols: Math.max(1, Number(echo.spanCols) || 2),
        spanRows: Math.max(1, Number(echo.spanRows) || 1),
        widgetId,
        preview: echo.preview ? String(echo.preview) : undefined
    };
}

export async function widgetAttach(box: AndroidWidgetBox): Promise<boolean> {
    if (!box?.widgetId) return false;
    const r = await invokeCwsPlatformIPC({
        channel: "widget:attach",
        payload: box
    });
    return r.ok === true;
}

export async function widgetLayout(box: AndroidWidgetBox): Promise<boolean> {
    if (!box?.widgetId) return false;
    const r = await invokeCwsPlatformIPC({
        channel: "widget:layout",
        payload: box
    });
    return r.ok === true;
}

export async function widgetDetach(widgetId: number): Promise<boolean> {
    const id = Number(widgetId) || 0;
    if (!id) return false;
    const r = await invokeCwsPlatformIPC({
        channel: "widget:detach",
        payload: { widgetId: id }
    });
    return r.ok === true;
}

export async function widgetDelete(widgetId: number): Promise<boolean> {
    const id = Number(widgetId) || 0;
    if (!id) return false;
    const r = await invokeCwsPlatformIPC({
        channel: "widget:delete",
        payload: { widgetId: id }
    });
    return r.ok === true;
}

export async function widgetHideAll(): Promise<boolean> {
    const r = await invokeCwsPlatformIPC({ channel: "widget:hide" });
    return r.ok === true;
}

export type StorageListEntry = {
    name: string;
    kind: "file" | "directory";
    path?: string;
    size?: number;
    lastModified?: number;
};

export async function storageList(
    root: "sdcard" | "saf",
    path = "/"
): Promise<StorageListEntry[]> {
    const r = await invokeCwsPlatformIPC({
        channel: "storage:list",
        payload: { root, path }
    });
    const echo = (r.echo || r) as { entries?: StorageListEntry[] };
    return Array.isArray(echo.entries) ? echo.entries : [];
}

export async function storagePickSaf(): Promise<string> {
    const r = await invokeCwsPlatformIPC({ channel: "storage:pick-saf" });
    const echo = (r.echo || r) as { uri?: string; treeUri?: string; incomingDir?: string };
    return String(echo.uri || echo.treeUri || echo.incomingDir || "");
}

export async function storageAllFilesStatus(): Promise<{
    allFilesAccess: boolean;
    runtimeGranted?: boolean;
    note?: string;
}> {
    const r = await invokeCwsPlatformIPC({ channel: "storage:all-files-status" });
    const echo = (r.echo || r) as {
        allFilesAccess?: boolean;
        runtimeGranted?: boolean;
        note?: string;
    };
    return {
        allFilesAccess: echo.allFilesAccess === true,
        runtimeGranted: echo.runtimeGranted === true,
        note: echo.note ? String(echo.note) : undefined
    };
}

export async function storageRequestAllFiles(): Promise<boolean> {
    const r = await invokeCwsPlatformIPC({ channel: "storage:all-files-request" });
    const echo = (r.echo || r) as { opened?: boolean };
    return r.ok === true || echo.opened === true;
}
