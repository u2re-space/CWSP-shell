/*
 * Filename: install-capacitor-apk.mjs
 * FullPath: apps/CWSP-shell/scripts/install-capacitor-apk.mjs
 * Change date and time: 02.48.00_20.08.2026
 * Reason for changes: adb install latest cwsp-launcher APK after build.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installApksOnFleet } from "./adb-install-apks.mjs";
import { loadPwaIdentity } from "./sync-capacitor-app-identity.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APK_DIR = path.join(APP_ROOT, "build/capacitor/apk");

function apkStem() {
    return (
        loadPwaIdentity()
            .appName.toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "cw-i1"
    );
}

function findLauncherApk() {
    if (!fs.existsSync(APK_DIR)) return null;
    const prefix = `${apkStem()}-`;
    const candidates = fs
        .readdirSync(APK_DIR)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".apk"))
        .map((name) => {
            const full = path.join(APK_DIR, name);
            return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.full ?? null;
}

function main() {
    const apk = findLauncherApk();
    if (!apk) {
        console.error(`[install:capacitor] no ${apkStem()}-*.apk under ${APK_DIR} — run npm run build:capacitor:launcher first`);
        process.exit(1);
    }
    installApksOnFleet([apk]);
    console.log(`[install:capacitor] OK — ${apk}`);
}

try {
    main();
} catch (err) {
    console.error("[install:capacitor]", err?.message || err);
    process.exit(1);
}
