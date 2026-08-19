/*
 * Filename: install-capacitor-apk.mjs
 * FullPath: apps/CWSP-shell/scripts/install-capacitor-apk.mjs
 * Change date and time: 02.48.00_20.08.2026
 * Reason for changes: adb install latest cwsp-launcher APK after build.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APK_DIR = path.join(APP_ROOT, "build/capacitor/apk");

function findLauncherApk() {
    if (!fs.existsSync(APK_DIR)) return null;
    const candidates = fs
        .readdirSync(APK_DIR)
        .filter((name) => name.startsWith("cwsp-launcher-") && name.endsWith(".apk"))
        .map((name) => {
            const full = path.join(APK_DIR, name);
            return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.full ?? null;
}

function run(cmd, args) {
    console.log(`[install:capacitor] ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    if (r.status !== 0) {
        throw new Error(`${cmd} failed with status ${r.status}`);
    }
}

function main() {
    const apk = findLauncherApk();
    if (!apk) {
        console.error(`[install:capacitor] no cwsp-launcher-*.apk under ${APK_DIR} — run npm run build:capacitor:launcher first`);
        process.exit(1);
    }
    run("adb", ["install", "-r", apk]);
    console.log(`[install:capacitor] OK — ${apk}`);
}

try {
    main();
} catch (err) {
    console.error("[install:capacitor]", err?.message || err);
    process.exit(1);
}
