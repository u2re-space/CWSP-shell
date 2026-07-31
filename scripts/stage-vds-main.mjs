#!/usr/bin/env node
/*
 * Filename: stage-vds-main.mjs
 * FullPath: apps/CWSP-shell/scripts/stage-vds-main.mjs
 * Change date and time: 14.25.00_31.07.2026
 * Reason for changes: Flatten nested pwa/icons|screenshots|manifest after viteStaticCopy + favicon.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// WHY: browsers and legacy PWA probes request /favicon.png|/favicon.svg at host root.
const faviconSrc = path.join(repoRoot, "assets", "favicon.png");
const pwaIcon = path.join(dest, "pwa", "icons", "icon.png");
if (fs.existsSync(faviconSrc)) {
    fs.cpSync(faviconSrc, path.join(dest, "favicon.png"));
} else if (fs.existsSync(pwaIcon)) {
    fs.cpSync(pwaIcon, path.join(dest, "favicon.png"));
}
if (fs.existsSync(path.join(dest, "pwa", "icons", "icon.svg"))) {
    fs.cpSync(path.join(dest, "pwa", "icons", "icon.svg"), path.join(dest, "favicon.svg"));
}

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

console.log(`[stage-vds-main] ${src} → ${dest}`);
