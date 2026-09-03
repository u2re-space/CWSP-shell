/*
 * Filename: sync-capacitor-android-icons.mjs
 * FullPath: apps/CWSP-shell/scripts/sync-capacitor-android-icons.mjs
 * FIND:sku
 * TAG:sku,apk-update
 * Change date and time: 19.40.00_03.09.2026
 * Reason for changes: Capacitor launcher glyphs sit inside the mask, not flush (document/explorer/process).
 *
 * Usage:
 *   node sync-capacitor-android-icons.mjs [--app /path/to/CWSP-<sku>]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/*
 * WHY: OEM masks show the inner 72dp of the 108dp layer. Full-bleed PWA art at
 * 72/108 sits flush in the squircle (document / explorer / process / CrossWord).
 * 56dp leaves ~8dp inset inside that viewport.
 */
const ADAPTIVE_SAFE_RATIO = 56 / 108;
/** Legacy `ic_launcher` / round: same visual inset vs the 48dp plate. */
const LAUNCHER_SAFE_RATIO = 56 / 72;

const STAT_SIZES = {
    mdpi: 24,
    hdpi: 36,
    xhdpi: 48,
    xxhdpi: 72,
    xxxhdpi: 96
};

const ICON_CANDIDATES = [
    "icon.png",
    "web-app-manifest-512x512.png",
    "android-chrome-512x512.png",
    "apple-touch-icon.png"
];

function parseArgs(argv) {
    let app = SHELL_ROOT;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--app") app = path.resolve(String(argv[++i] || app));
    }
    return { app };
}

function runMagick(args) {
    const r = spawnSync("magick", args, { stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`magick ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout || "";
}

function pickIcon(iconsDir) {
    for (const name of ICON_CANDIDATES) {
        const p = path.join(iconsDir, name);
        if (fs.existsSync(p) && fs.statSync(p).size > 800) return p;
    }
    return "";
}

function pickMaskable(iconsDir, iconSrc) {
    const p = path.join(iconsDir, "maskable.png");
    if (!fs.existsSync(p) || !iconSrc) return iconSrc;
    const iconSt = fs.statSync(iconSrc);
    const maskSt = fs.statSync(p);
    // WHY: sibling maskable.png is still the old launcher stub (~9KB), older than the new icon.png.
    if (maskSt.size < 12000 || maskSt.mtimeMs + 60_000 < iconSt.mtimeMs) return iconSrc;
    return p;
}

function sampleBackground(src) {
    try {
        const hex = String(
            runMagick([src, "-format", "%[hex:u.p{0,0}]", "info:"])
        )
            .trim()
            .replace(/^#/, "");
        if (/^[0-9a-fA-F]{6,8}$/.test(hex)) return `#${hex.slice(0, 6).toLowerCase()}`;
    } catch {
        /* keep default */
    }
    return "#111111";
}

function writePngOnCanvas(src, dest, canvas, contentRatio = 1) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const inner = Math.max(1, Math.round(canvas * contentRatio));
    runMagick([
        src,
        "-background", "none",
        "-gravity", "center",
        "-resize", `${inner}x${inner}`,
        "-extent", `${canvas}x${canvas}`,
        dest
    ]);
}

function resizePng(src, dest, size) {
    writePngOnCanvas(src, dest, size, 1);
}

function writeBackground(resRoot, hex) {
    const values = path.join(resRoot, "values");
    fs.mkdirSync(values, { recursive: true });
    fs.writeFileSync(
        path.join(values, "ic_launcher_background.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${hex}</color>\n</resources>\n`
    );
}

function syncLauncherIcons(appRoot) {
    const iconsDir = path.join(appRoot, "src/pwa/icons");
    const resRoot = path.join(appRoot, "platforms/android/res");
    const iconSrc = pickIcon(iconsDir);
    if (!iconSrc) {
        throw new Error(`missing PWA icon under ${iconsDir} (icon.png)`);
    }
    const maskableSrc = pickMaskable(iconsDir, iconSrc);
    const bg = sampleBackground(iconSrc);

    for (const [density, size] of Object.entries(LAUNCHER_SIZES)) {
        const dir = path.join(resRoot, `mipmap-${density}`);
        writePngOnCanvas(iconSrc, path.join(dir, "ic_launcher.png"), size, LAUNCHER_SAFE_RATIO);
        writePngOnCanvas(iconSrc, path.join(dir, "ic_launcher_round.png"), size, LAUNCHER_SAFE_RATIO);
    }

    for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
        const dir = path.join(resRoot, `mipmap-${density}`);
        writePngOnCanvas(maskableSrc, path.join(dir, "ic_launcher_foreground.png"), size, ADAPTIVE_SAFE_RATIO);
        writePngOnCanvas(iconSrc, path.join(dir, "ic_launcher_monochrome.png"), size, ADAPTIVE_SAFE_RATIO);
    }

    for (const [density, size] of Object.entries(STAT_SIZES)) {
        const dir = path.join(resRoot, `drawable-${density}`);
        resizePng(iconSrc, path.join(dir, "ic_stat_cwsp.png"), size);
    }
    resizePng(iconSrc, path.join(resRoot, "drawable/ic_stat_cwsp.png"), 24);
    writeBackground(resRoot, bg);

    console.log(
        `[sync-capacitor-android-icons] ${path.basename(appRoot)} icon=${path.basename(iconSrc)} fg=${path.basename(maskableSrc)} bg=${bg} → ${resRoot}`
    );
}

try {
    const { app } = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(app)) throw new Error(`--app not found: ${app}`);
    syncLauncherIcons(app);
} catch (err) {
    console.error("[sync-capacitor-android-icons]", err?.message || err);
    process.exit(1);
}
