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
