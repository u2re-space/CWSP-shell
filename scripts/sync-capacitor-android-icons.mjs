/*
 * Filename: sync-capacitor-android-icons.mjs
 * FullPath: apps/CWSP-shell/scripts/sync-capacitor-android-icons.mjs
 * Change date and time: 05.40.00_20.08.2026
 * Reason for changes: Android launcher icons from PWA src/pwa/icons (same glyph as installable PWA).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON_SRC = path.join(APP_ROOT, "src/pwa/icons/icon.png");
const MASKABLE_SRC = path.join(APP_ROOT, "src/pwa/icons/maskable.png");
const RES_ROOT = path.join(APP_ROOT, "platforms/android/res");

const LAUNCHER_SIZES = {
    ldpi: 36,
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192
};

/** Adaptive foreground canvas (108dp baseline). */
const FOREGROUND_SIZES = {
    mdpi: 108,
    hdpi: 162,
    xhdpi: 216,
    xxhdpi: 324,
    xxxhdpi: 432
};

const STAT_SIZES = {
    mdpi: 24,
    hdpi: 36,
    xhdpi: 48,
    xxhdpi: 72,
    xxxhdpi: 96
};

function runMagick(args) {
    const r = spawnSync("magick", args, { stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`magick ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
}

function resizePng(src, dest, size) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    runMagick([src, "-background", "none", "-gravity", "center", "-resize", `${size}x${size}`, dest]);
}

function syncLauncherIcons() {
    if (!fs.existsSync(ICON_SRC)) {
        throw new Error(`missing PWA icon: ${ICON_SRC}`);
    }
    if (!fs.existsSync(MASKABLE_SRC)) {
        throw new Error(`missing PWA maskable icon: ${MASKABLE_SRC}`);
    }

    for (const [density, size] of Object.entries(LAUNCHER_SIZES)) {
        const dir = path.join(RES_ROOT, `mipmap-${density}`);
        resizePng(ICON_SRC, path.join(dir, "ic_launcher.png"), size);
        resizePng(ICON_SRC, path.join(dir, "ic_launcher_round.png"), size);
    }

    for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
        const dir = path.join(RES_ROOT, `mipmap-${density}`);
        resizePng(MASKABLE_SRC, path.join(dir, "ic_launcher_foreground.png"), size);
        resizePng(ICON_SRC, path.join(dir, "ic_launcher_monochrome.png"), size);
    }

    for (const [density, size] of Object.entries(STAT_SIZES)) {
        const dir = path.join(RES_ROOT, `drawable-${density}`);
        resizePng(ICON_SRC, path.join(dir, "ic_stat_cwsp.png"), size);
    }
    resizePng(ICON_SRC, path.join(RES_ROOT, "drawable/ic_stat_cwsp.png"), 24);

    console.log("[sync-capacitor-android-icons] synced launcher + notification icons from src/pwa/icons");
}

try {
    syncLauncherIcons();
} catch (err) {
    console.error("[sync-capacitor-android-icons]", err?.message || err);
    process.exit(1);
}
