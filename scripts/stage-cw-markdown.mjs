#!/usr/bin/env node
/*
 * Filename: stage-cw-markdown.mjs
 * FullPath: apps/CWSP-shell/scripts/stage-cw-markdown.mjs
 * Change date and time: 13.25.00_20.07.2026
 * Reason for changes: Flatten nested pwa/pwa/manifest.json so md.u2re.space ./pwa/manifest.json resolves.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(root));
const src = path.join(root, "build/cw-markdown");
const dest = path.join(repoRoot, "runtime/fastify/apps/cw-markdown");

if (!fs.existsSync(path.join(src, "index.html"))) {
    console.error(`[stage-cw-markdown] missing ${src}/index.html — run build:cw-markdown first`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });

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

// COMPAT: viteStaticCopy + chunk placement can nest manifest under pwa/pwa/.
// HTML expects ./pwa/manifest.json (md.u2re.space installable PWA).
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
    console.log("[stage-cw-markdown] normalized pwa/pwa/manifest.json → pwa/manifest.json");
}

fs.writeFileSync(
    path.join(dest, ".sync-meta.json"),
    JSON.stringify(
        {
            syncedAt: new Date().toISOString(),
            source: "apps/CWSP-shell/build/cw-markdown",
            host: "md.u2re.space",
            debugPath: "/markdown"
        },
        null,
        2
    ) + "\n"
);

console.log(`[stage-cw-markdown] ${src} → ${dest}`);
