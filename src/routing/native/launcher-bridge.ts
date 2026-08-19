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

type LauncherListEcho = { apps?: LauncherAppEntry[]; reason?: string };
type LauncherIconEcho = { base64?: string; mime?: string; cacheKey?: string; reason?: string };

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

export async function launcherIcon(cacheKey: string, size = 64): Promise<string> {
    const key = String(cacheKey || "").trim();
    if (!key) return "";
    const r = await invokeCwsPlatformIPC({
        channel: "launcher:icon",
        payload: { packageName: key, cacheKey: key, size }
    });
    if (!r.ok) return "";
    const echo = r.echo as LauncherIconEcho | undefined;
    const base64 = echo?.base64 ?? (r as { base64?: string }).base64;
    if (!base64) return "";
    const mime = echo?.mime ?? (r as { mime?: string }).mime ?? "image/png";
    return `data:${mime};base64,${base64}`;
}

/** PNG (or native mime) as blob: object URL — preferred for WebView `<img src>`. */
export async function launcherIconBlobUrl(cacheKey: string, size = 64): Promise<string> {
    const dataUrl = await launcherIcon(cacheKey, size);
    if (!dataUrl) return "";
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
    const normalized =
        blob.type === type ? blob : new Blob([await blob.arrayBuffer()], { type });
    return URL.createObjectURL(normalized);
}
