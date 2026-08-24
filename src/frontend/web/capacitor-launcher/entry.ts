/*
 * Filename: entry.ts
 * FullPath: apps/CWSP-shell/src/frontend/web/capacitor-launcher/entry.ts
 * Change date and time: 22.56.00_22.08.2026
 * Reason for changes: Launcher SKU — home+settings only; sibling APKs own explorer/document.
 */

import { SystemBarType, SystemBars } from "@capacitor/core";
import { bootEnvironment } from "boot/BootLoader";
import { installLauncherHomeLifecycle } from "com/routing/native/launcher-home-lifecycle";
import { readClipboardTextFromDevice } from "com/routing/native/clipboard-device";
import {
    launcherIcon,
    launcherIconPackIcons,
    launcherIconPacks,
    launcherIconVariants,
    launcherIsDefault,
    launcherLaunch,
    launcherList,
    launcherOpenUri,
    widgetAttach,
    widgetBind,
    widgetDelete,
    widgetDetach,
    widgetHideAll,
    widgetLayout,
    widgetList,
    launcherRequestDefault,
    launcherStartShortcut,
    launcherShortcutIcon
} from "com/routing/native/launcher-bridge";
import { applyCwspSku } from "com/config/ecosystem-skus";
import { setLauncherBridgeForAppMenu } from "fl-ui/navigation/app-menu/AppMenu";
import { setLauncherBridgeForSpeedDial } from "fl-ui/speed-dial/action-registry";
import { setAndroidWidgetBridge } from "fl-ui/speed-dial/widgets";

const enabledViews = ["home", "settings"] as const;

applyCwspSku("launcher");
document.documentElement.dataset.cwspShellRole = "launcher";
document.documentElement.dataset.cwspNativeShell = "capacitor";
document.documentElement.dataset.cwspSurface = "environment";
document.documentElement.dataset.cwspEnabledViews = enabledViews.join(",");
document.documentElement.dataset.cwspDefaultView = "home";

void SystemBars.hide({ bar: SystemBarType.NavigationBar }).catch(() => {
    /* native-only; web preview ignores */
});

/** WHY: WebView clipboard.readText is empty/denied on Android; Speed Dial Paste uses this hook. */
(globalThis as Record<string, unknown>).__CWSP_READ_CLIPBOARD_TEXT__ = () =>
    readClipboardTextFromDevice();

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
    launcherStartShortcut,
    launcherShortcutIcon,
    launcherOpenUri,
    launcherIcon,
    launcherIconVariants,
    launcherIconPacks,
    launcherIconPackIcons,
    launcherList,
    widgetList,
    widgetBind,
    widgetAttach,
    widgetLayout,
    widgetDetach,
    widgetDelete,
    widgetHideAll
});

setAndroidWidgetBridge({
    widgetList,
    widgetBind,
    widgetAttach,
    widgetLayout,
    widgetDetach,
    widgetDelete,
    widgetHideAll
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

void import("views/settings")
    .then((m) => m.refreshInstalledSiblingSettingsSections?.())
    .catch(() => {
        /* settings module optional at boot */
    });

void bootEnvironment(document.body, "home").catch(showBootFailure);
