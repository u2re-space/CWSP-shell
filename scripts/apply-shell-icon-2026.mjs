/*
 * Filename: apply-shell-icon-2026.mjs
 * FullPath: apps/CWSP-shell/scripts/apply-shell-icon-2026.mjs
 * FIND:pwa-icons
 * TAG:sku,pwa-icons
 * Change date and time: 17.20.00_06.09.2026
 * Reason for changes: Wire assets/shell-icon-2026 into PWA, Capacitor, and CWSP-crx with pack padding.
 *
 * Usage:
 *   node scripts/apply-shell-icon-2026.mjs
 *
 * WHY: the pack already has platform padding (any ~9%, maskable ~17%, adaptive ~54%).
 * INVARIANT: do not re-inset those bitmaps — copy mipmaps / maskable as authored.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(SHELL_ROOT, "assets/shell-icon-2026");
const PWA_ICONS = path.join(SHELL_ROOT, "src/pwa/icons");
const ANDROID_RES = path.join(SHELL_ROOT, "platforms/android/res");
const CRX_ICONS = path.resolve(SHELL_ROOT, "../CWSP-crx/src/crx/icons");
const CRX_ROOT = path.resolve(SHELL_ROOT, "../CWSP-crx");

const STAT_SIZES = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };

function runMagick(args) {
    const r = spawnSync("magick", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`magick failed: ${r.stderr || r.stdout}`);
}

function copyFile(src, dest) {
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function resize(src, dest, size) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    runMagick([src, "-background", "none", "-gravity", "center", "-resize", `${size}x${size}`, dest]);
}

function applyPwa() {
    copyFile(path.join(PACK, "icon.svg"), path.join(PWA_ICONS, "icon.svg"));
    copyFile(path.join(PACK, "android-chrome-512x512.png"), path.join(PWA_ICONS, "icon.png"));
    copyFile(path.join(PACK, "maskable-icon.png"), path.join(PWA_ICONS, "maskable.png"));
    copyFile(path.join(PACK, "apple-touch-icon.png"), path.join(PWA_ICONS, "apple-touch-icon.png"));
    copyFile(path.join(PACK, "favicon.ico"), path.join(PWA_ICONS, "favicon.ico"));
    copyFile(path.join(PACK, "icon.ico"), path.join(PWA_ICONS, "icon.ico"));
    copyFile(path.join(PACK, "favicon-16x16.png"), path.join(PWA_ICONS, "favicon-16x16.png"));
    copyFile(path.join(PACK, "favicon-32x32.png"), path.join(PWA_ICONS, "favicon-32x32.png"));
    copyFile(path.join(PACK, "favicon-96x96.png"), path.join(PWA_ICONS, "favicon-96x96.png"));
    copyFile(path.join(PACK, "favicon-96x96.png"), path.join(PWA_ICONS, "icon-96.png"));
    copyFile(path.join(PACK, "web-app-manifest-192x192.png"), path.join(PWA_ICONS, "web-app-manifest-192x192.png"));
    copyFile(path.join(PACK, "web-app-manifest-512x512.png"), path.join(PWA_ICONS, "web-app-manifest-512x512.png"));
    console.log("[apply-shell-icon-2026] PWA icons ← pack");
}

function applyAndroid() {
    const packAndroid = path.join(PACK, "android");
    for (const name of fs.readdirSync(packAndroid)) {
        const src = path.join(packAndroid, name);
        if (!name.startsWith("mipmap-") && name !== "values") continue;
        const dest = path.join(ANDROID_RES, name);
        fs.cpSync(src, dest, { recursive: true });
    }
    const iconSrc = path.join(PWA_ICONS, "icon.png");
    for (const [density, size] of Object.entries(STAT_SIZES)) {
        resize(iconSrc, path.join(ANDROID_RES, `drawable-${density}`, "ic_stat_cwsp.png"), size);
    }
    resize(iconSrc, path.join(ANDROID_RES, "drawable/ic_stat_cwsp.png"), 24);
    console.log("[apply-shell-icon-2026] Capacitor mipmaps ← pack (authored padding)");
}

function applyCrx() {
    const src512 = path.join(PWA_ICONS, "icon.png");
    copyFile(path.join(PACK, "icon.svg"), path.join(CRX_ICONS, "icon.svg"));
    copyFile(src512, path.join(CRX_ICONS, "icon.png"));
    copyFile(path.join(PWA_ICONS, "maskable.png"), path.join(CRX_ICONS, "maskable.png"));
    copyFile(path.join(PACK, "icon.ico"), path.join(CRX_ICONS, "icon.ico"));
    for (const size of [16, 32, 48, 96, 128]) {
        resize(src512, path.join(CRX_ICONS, `icon-${size}.png`), size);
    }
    copyFile(path.join(PACK, "icon.svg"), path.join(CRX_ROOT, "favicon.svg"));
    copyFile(src512, path.join(CRX_ROOT, "favicon.png"));
    copyFile(path.join(PACK, "favicon.ico"), path.join(CRX_ROOT, "favicon.ico"));
    console.log("[apply-shell-icon-2026] CRX icons ← same mark");
}

if (!fs.existsSync(PACK)) throw new Error(`missing pack ${PACK}`);
applyPwa();
applyAndroid();
if (fs.existsSync(CRX_ICONS)) applyCrx();
