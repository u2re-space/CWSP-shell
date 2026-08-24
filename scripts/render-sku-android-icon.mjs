/*
 * Filename: render-sku-android-icon.mjs
 * FullPath: apps/CWSP-shell/scripts/render-sku-android-icon.mjs
 * FIND:sku
 * Change date and time: 13.54.00_24.08.2026
 * Reason for changes: Raster Phosphor SKU glyphs (cross/drone/folder/books) into Android mipmaps.
 *
 * Usage:
 *   node render-sku-android-icon.mjs --icon drone --res /path/to/android/res
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_SIZES = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

const GLYPHS = {
    cross: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="white"><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>`,
    drone: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="white"><circle cx="128" cy="80" r="24"/><path d="M216,32H184a8,8,0,0,0,0,16h13.38l-30.21,40.28A40.12,40.12,0,0,0,128,72a40.12,40.12,0,0,0-39.17,16.28L58.62,48H72a8,8,0,0,0,0-16H40A8,8,0,0,0,32,40V72a8,8,0,0,0,16,0V58.62l36.9,49.2A39.77,39.77,0,0,0,88,128v16a40,40,0,0,0,80,0V128a39.77,39.77,0,0,0,3.1-20.18L208,58.62V72a8,8,0,0,0,16,0V40A8,8,0,0,0,216,32ZM152,144a24,24,0,0,1-48,0V128a24,24,0,0,1,48,0Z"/></svg>`,
    folder: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="white"><path d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40Z"/></svg>`,
    books: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="white"><path d="M104,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H56V48h48ZM152,32h-8a8,8,0,0,0,0,16h8V208h-8a8,8,0,0,0,0,16h8a16,16,0,0,0,16-16V48A16,16,0,0,0,152,32Zm56,0h-8a8,8,0,0,0,0,16h8V208h-8a8,8,0,0,0,0,16h8a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Z"/></svg>`,
    cpu: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="white"><path d="M152,96H104a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V104A8,8,0,0,0,152,96Zm-8,48H112V112h32Zm88,0H216V112h16a8,8,0,0,0,0-16H216V56a16,16,0,0,0-16-16H160V24a8,8,0,0,0-16,0V40H112V24a8,8,0,0,0-16,0V40H56A16,16,0,0,0,40,56V96H24a8,8,0,0,0,0,16H40v32H24a8,8,0,0,0,0,16H40v40a16,16,0,0,0,16,16H96v16a8,8,0,0,0,16,0V216h32v16a8,8,0,0,0,16,0V216h40a16,16,0,0,0,16-16V160h16a8,8,0,0,0,0-16Zm-32,56H56V56H200v95.87s0,.09,0,.13,0,.09,0,.13V200Z"/></svg>`,
    "magic-wand": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="white"><path d="M48,64a8,8,0,0,1,8-8H72V40a8,8,0,0,1,16,0V56h16a8,8,0,0,1,0,16H88V88a8,8,0,0,1-16,0V72H56A8,8,0,0,1,48,64ZM184,192h-8v-8a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16h8v8a8,8,0,0,0,16,0v-8h8a8,8,0,0,0,0-16Zm56-48H224V128a8,8,0,0,0-16,0v16H192a8,8,0,0,0,0,16h16v16a8,8,0,0,0,16,0V160h16a8,8,0,0,0,0-16ZM219.31,80,80,219.31a16,16,0,0,1-22.62,0L36.68,198.63a16,16,0,0,1,0-22.63L176,36.69a16,16,0,0,1,22.63,0l20.68,20.68A16,16,0,0,1,219.31,80Zm-54.63,32L144,91.31l-96,96L68.68,208ZM208,68.69,187.31,48l-32,32L176,100.69Z"/></svg>`
};

function parseArgs(argv) {
    const out = { icon: "cross", res: "" };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--icon") out.icon = String(argv[++i] || "cross");
        if (argv[i] === "--res") out.res = String(argv[++i] || "");
    }
    return out;
}

function runMagick(args) {
    const r = spawnSync("magick", args, { stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`magick ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const icon = String(args.icon || "cross").toLowerCase();
    const svg = GLYPHS[icon];
    if (!svg) throw new Error(`unknown SKU icon "${icon}" (cross|drone|folder|books|cpu|magic-wand)`);
    const resRoot = path.resolve(args.res || "");
    if (!resRoot || !fs.existsSync(path.dirname(resRoot))) {
        throw new Error(`--res must point at an Android res directory`);
    }
    fs.mkdirSync(resRoot, { recursive: true });
    const tmp = path.join(resRoot, `.sku-${icon}.svg`);
    fs.writeFileSync(tmp, svg, "utf8");

    const paint = (dest, size) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        runMagick([
            "-background", "#111111",
            "-gravity", "center",
            "-size", `${size}x${size}`,
            tmp,
            "-resize", `${Math.round(size * 0.68)}x${Math.round(size * 0.68)}`,
            "-extent", `${size}x${size}`,
            dest
        ]);
    };

    for (const [density, size] of Object.entries(LAUNCHER_SIZES)) {
        const dir = path.join(resRoot, `mipmap-${density}`);
        paint(path.join(dir, "ic_launcher.png"), size);
        paint(path.join(dir, "ic_launcher_round.png"), size);
    }
    for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
        const dir = path.join(resRoot, `mipmap-${density}`);
        paint(path.join(dir, "ic_launcher_foreground.png"), size);
        paint(path.join(dir, "ic_launcher_monochrome.png"), size);
    }
    fs.writeFileSync(
        path.join(resRoot, "values/ic_launcher_background.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#111111</color>\n</resources>\n`
    );
    try {
        fs.unlinkSync(tmp);
    } catch {
        /* keep */
    }
    console.log(`[render-sku-android-icon] ${icon} → ${resRoot}`);
}

try {
    main();
} catch (err) {
    console.error("[render-sku-android-icon]", err?.message || err);
    process.exit(1);
}
