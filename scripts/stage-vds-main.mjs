#!/usr/bin/env node
/*
 * Filename: stage-vds-main.mjs
 * FullPath: apps/CWSP-shell/scripts/stage-vds-main.mjs
 * Change date and time: 12.00.00_08.08.2026
 * Reason for changes: Stage default wallpaper.jpg/stock.jpg (Vite host SPA skips app assets/).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteVitePreloadBinding } from "../shared/vite-chunk-placement.mjs";
import { hoistSharedSlices } from "../../../runtime/fastify/apps/hoist-shared-slices.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(root));
const src = path.join(root, "build/vds-main");
const dest = path.join(repoRoot, "runtime/fastify/apps/main");

if (!fs.existsSync(path.join(src, "index.html"))) {
    console.error(`[stage-vds-main] missing ${src}/index.html — run build:vds-main first`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });

// WHY: keep README + any non-build notes; wipe previous promo/shell assets.
const keep = new Set(["README.md"]);
if (fs.existsSync(dest)) {
    for (const name of fs.readdirSync(dest)) {
        if (keep.has(name)) continue;
        fs.rmSync(path.join(dest, name), { recursive: true, force: true });
    }
} else {
    fs.mkdirSync(dest, { recursive: true });
}

for (const name of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, name), path.join(dest, name), { recursive: true });
}

{
    const n = rewriteVitePreloadBinding(dest);
    if (n) console.log(`[stage-vds-main] rewrote ${n} vite-preload binding(s)`);
}

/**
 * COMPAT: older viteStaticCopy + nested Vite `root` produced:
 *   pwa/pwa/manifest.json
 *   pwa/icons/pwa/icons/*
 *   pwa/screenshots/pwa/screenshots/*
 * Manifest `icons[].src = "icons/icon.png"` expects flat `/pwa/icons/icon.png`.
 */
function flattenNestedDir(nestedDir, flatDir, label) {
    if (!fs.existsSync(nestedDir)) return false;
    fs.mkdirSync(flatDir, { recursive: true });
    let moved = 0;
    for (const name of fs.readdirSync(nestedDir)) {
        const from = path.join(nestedDir, name);
        const to = path.join(flatDir, name);
        if (fs.existsSync(to) && fs.statSync(to).isFile()) {
            // Prefer already-flat file; drop nested duplicate.
            if (fs.statSync(from).isFile()) {
                fs.rmSync(from, { force: true });
                continue;
            }
        }
        fs.renameSync(from, to);
        moved++;
    }
    // Remove empty nest parents: .../pwa/icons/pwa[/icons]
    let walk = nestedDir;
    for (let i = 0; i < 3; i++) {
        try {
            if (fs.existsSync(walk) && fs.readdirSync(walk).length === 0) {
                fs.rmdirSync(walk);
                walk = path.dirname(walk);
            } else break;
        } catch {
            break;
        }
    }
    if (moved) console.log(`[stage-vds-main] flattened ${label} (${moved} entries)`);
    return moved > 0;
}

const nestedManifest = path.join(dest, "pwa", "pwa", "manifest.json");
const flatManifest = path.join(dest, "pwa", "manifest.json");
if (fs.existsSync(nestedManifest)) {
    fs.mkdirSync(path.dirname(flatManifest), { recursive: true });
    if (fs.existsSync(flatManifest)) fs.rmSync(flatManifest, { force: true });
    fs.renameSync(nestedManifest, flatManifest);
    const nestedDir = path.join(dest, "pwa", "pwa");
    try {
        if (fs.existsSync(nestedDir) && fs.readdirSync(nestedDir).length === 0) {
            fs.rmdirSync(nestedDir);
        }
    } catch {
        /* ignore */
    }
    console.log("[stage-vds-main] normalized pwa/pwa/manifest.json → pwa/manifest.json");
}

flattenNestedDir(
    path.join(dest, "pwa", "icons", "pwa", "icons"),
    path.join(dest, "pwa", "icons"),
    "pwa/icons"
);
flattenNestedDir(
    path.join(dest, "pwa", "screenshots", "pwa", "screenshots"),
    path.join(dest, "pwa", "screenshots"),
    "pwa/screenshots"
);
// Also flatten accidental `pwa/icons/src/pwa/icons` from absolute-src structured copies.
flattenNestedDir(
    path.join(dest, "pwa", "icons", "src", "pwa", "icons"),
    path.join(dest, "pwa", "icons"),
    "pwa/icons (src nest)"
);
flattenNestedDir(
    path.join(dest, "pwa", "screenshots", "src", "pwa", "screenshots"),
    path.join(dest, "pwa", "screenshots"),
    "pwa/screenshots (src nest)"
);

const iconPng = path.join(dest, "pwa", "icons", "icon.png");
if (!fs.existsSync(iconPng)) {
    console.error("[stage-vds-main] ERROR: missing pwa/icons/icon.png after flatten — PWA icon will fail");
    process.exitCode = 1;
} else {
    console.log("[stage-vds-main] OK pwa/icons/icon.png");
}

// INVARIANT: SKU src/pwa/icons wins over Vite-nested leftovers (old shared cross).
{
    const srcIcons = path.join(root, "src", "pwa", "icons");
    const destIcons = path.join(dest, "pwa", "icons");
    if (fs.existsSync(srcIcons)) {
        fs.mkdirSync(destIcons, { recursive: true });
        fs.cpSync(srcIcons, destIcons, { recursive: true });
    }
    const srcManifest = path.join(root, "src", "pwa", "manifest.json");
    const destManifest = path.join(dest, "pwa", "manifest.json");
    if (fs.existsSync(srcManifest)) {
        fs.mkdirSync(path.dirname(destManifest), { recursive: true });
        fs.cpSync(srcManifest, destManifest);
    }
    const destAlias = path.join(dest, "icons");
    if (fs.existsSync(destIcons)) {
        fs.mkdirSync(destAlias, { recursive: true });
        fs.cpSync(destIcons, destAlias, { recursive: true });
    }
}

// WHY: browsers request /favicon.png|/favicon.svg|/favicon.ico at host root.
// Prefer the SKU PWA icon — repo assets/favicon.png is the old shared mark.
{
    const icons = path.join(dest, "pwa", "icons");
    const copyFav = (fromName, toName) => {
        const from = path.join(icons, fromName);
        if (!fs.existsSync(from)) return false;
        fs.cpSync(from, path.join(dest, toName));
        return true;
    };
    copyFav("icon.svg", "favicon.svg");
    if (!copyFav("icon.png", "favicon.png")) {
        const legacy = path.join(repoRoot, "assets", "favicon.png");
        if (fs.existsSync(legacy)) fs.cpSync(legacy, path.join(dest, "favicon.png"));
    }
    if (!copyFav("favicon.ico", "favicon.ico")) copyFav("icon.ico", "favicon.ico");
}

/**
 * WHY: default wallpaper URL is `/assets/wallpaper.jpg` (Canvas-2 / SpeedDial).
 * Host SPA Vite `root` is nested under `src/frontend/web/...`, so app `assets/`
 * is not Vite `publicDir` and never lands in the outDir without an explicit copy.
 * INVARIANT: staged Fastify apps must serve wallpaper.jpg (and stock.jpg) at /assets/.
 */
function stageDefaultWallpapers(appRoot, stageDest, label) {
    const assetsDest = path.join(stageDest, "assets");
    fs.mkdirSync(assetsDest, { recursive: true });
    let copied = 0;
    for (const name of ["wallpaper.jpg", "stock.jpg"]) {
        const from = path.join(appRoot, "assets", name);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(assetsDest, name));
        copied++;
    }
    if (copied) console.log(`[${label}] staged ${copied} wallpaper asset(s) → assets/`);
    else console.warn(`[${label}] WARNING: no wallpaper.jpg/stock.jpg under ${path.join(appRoot, "assets")}`);
}
stageDefaultWallpapers(root, dest, "stage-vds-main");

fs.writeFileSync(
    path.join(dest, ".sync-meta.json"),
    JSON.stringify(
        {
            syncedAt: new Date().toISOString(),
            source: "apps/CWSP-shell/build/vds-main",
            host: "u2re.space",
            debugPath: "/",
            replaces: "runtime/main (promo hub)"
        },
        null,
        2
    ) + "\n"
);

hoistSharedSlices(dest, "stage-vds-main");
console.log(`[stage-vds-main] ${src} → ${dest}`);
