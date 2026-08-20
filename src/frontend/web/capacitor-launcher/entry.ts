/*
 * Filename: entry.ts
 * FullPath: apps/CWSP-shell/src/frontend/web/capacitor-launcher/entry.ts
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher Capacitor — environment-shell home desktop boot.
 */

import { bootEnvironment } from "boot/BootLoader";
import { installLauncherHomeLifecycle } from "com/routing/native/launcher-home-lifecycle";
import {
    launcherIcon,
    launcherIconPackIcons,
    launcherIconPacks,
    launcherIconVariants,
    launcherIsDefault,
    launcherLaunch,
    launcherList,
    launcherRequestDefault
} from "com/routing/native/launcher-bridge";
import { setLauncherBridgeForAppMenu } from "fl-ui/navigation/app-menu/AppMenu";
import { setLauncherBridgeForSpeedDial } from "fl-ui/speed-dial/action-registry";

const enabledViews = ["minimal", "home", "explorer", "settings", "viewer"] as const;

document.documentElement.dataset.cwspShellRole = "launcher";
document.documentElement.dataset.cwspNativeShell = "capacitor";
document.documentElement.dataset.cwspEnabledViews = enabledViews.join(",");
document.documentElement.dataset.cwspDefaultView = "home";

void import("shells/environment/components/statusbar/capacitor-native-safe-area")
    .then((m) => m.installCapacitorNativeSafeAreaInsets())
    .catch(() => {
        /* best-effort before shell mount */
    });

setLauncherBridgeForAppMenu({
    launcherIsDefault,
    launcherRequestDefault,
    launcherList,
    launcherLaunch,
    launcherIcon,
    launcherIconVariants,
    launcherIconPacks,
    launcherIconPackIcons
});

setLauncherBridgeForSpeedDial({
    launcherLaunch,
    launcherIcon,
    launcherIconVariants,
    launcherIconPacks,
    launcherIconPackIcons,
    launcherList
});

function showBootFailure(error: unknown): void {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error("[CW-i1] boot failed", error);
    const root = document.body;
    root.replaceChildren();
    root.style.cssText =
        "margin:0;padding:16px;font:14px/1.4 ui-monospace,monospace;background:#111;color:#f66;white-space:pre-wrap;";
    root.textContent = `[CW-i1] boot failed\n\n${message}`;
}

installLauncherHomeLifecycle();

void bootEnvironment(document.body, "home").catch(showBootFailure);
