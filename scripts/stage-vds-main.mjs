#!/usr/bin/env node
/*
 * Filename: stage-vds-main.mjs
 * FullPath: apps/CWSP-shell/scripts/stage-vds-main.mjs
 * Change date and time: 07.48.00_31.07.2026
 * Reason for changes: Also stage root favicon.png so PWA/host probes don't 404.
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

// WHY: browsers and legacy PWA probes request /favicon.png|/favicon.svg at host root.
const faviconSrc = path.join(repoRoot, "assets", "favicon.png");
if (fs.existsSync(faviconSrc)) {
    fs.cpSync(faviconSrc, path.join(dest, "favicon.png"));
}

// COMPAT: viteStaticCopy can nest manifest under pwa/pwa/.
const nestedManifest = path.join(dest, "pwa", "pwa", "manifest.json");
const flatManifest = path.join(dest, "pwa", "manifest.json");
if (fs.existsSync(nestedManifest) && !fs.existsSync(flatManifest)) {
    fs.mkdirSync(path.dirname(flatManifest), { recursive: true });
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
