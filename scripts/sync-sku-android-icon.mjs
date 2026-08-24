/*
 * Filename: sync-sku-android-icon.mjs
 * FullPath: apps/CWSP-shell/scripts/sync-sku-android-icon.mjs
 * FIND:sku
 * Change date and time: 13.55.00_24.08.2026
 * Reason for changes: Launcher APK icon = Phosphor cross.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(APP_ROOT, "scripts/render-sku-android-icon.mjs");
const res = path.join(APP_ROOT, "platforms/android/res");
const r = spawnSync(process.execPath, [renderer, "--icon", "cross", "--res", res], { stdio: "inherit" });
process.exit(r.status ?? 1);
