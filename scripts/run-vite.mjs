#!/usr/bin/env node
/**
 * Run Vite under a larger V8 heap. npm workspaces and some shells drop NODE_OPTIONS;
 * this wrapper always passes --max-old-space-size so dev/build don't OOM at ~4 GiB.
 *
 * Override: VITE_NODE_HEAP_MB=8192 node scripts/run-vite.mjs dev
 * Large monorepo + Vite 8 dep scan can exceed 16 GiB; raise if you still OOM (e.g. 32768).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const crosswordRoot = resolve(__dirname, "..");

/** Walk up from CWSP-shell (and monorepo root) so hoisted workspace deps resolve. */
const findVitePkgRoot = () => {
    let dir = crosswordRoot;
    for (let i = 0; i < 16; i += 1) {
        const pkgJson = resolve(dir, "node_modules", "vite", "package.json");
        if (existsSync(pkgJson)) return dirname(pkgJson);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    try {
        const require = createRequire(import.meta.url);
        return dirname(require.resolve("vite/package.json"));
    } catch {
        throw new Error(
            "Cannot find module 'vite/package.json'. Install CWSP-shell deps only:\n"
                + "  cd ~/U2RE.space && PUPPETEER_SKIP_DOWNLOAD=1 npm install -w crossword --include=dev\n"
                + "Or skip PWA for APK: CWS_SKIP_PWA=1 npm run build"
        );
    }
};

const vitePkgRoot = findVitePkgRoot();
const viteJs = resolve(vitePkgRoot, "bin", "vite.js");

const heapMb = String(process.env.VITE_NODE_HEAP_MB || "24576").trim() || "24576";
const forwarded = process.argv.slice(2);
const args = [`--max-old-space-size=${heapMb}`, viteJs, ...forwarded];

const r = spawnSync(process.execPath, args, { stdio: "inherit", shell: false });
process.exit(r.status ?? 1);
