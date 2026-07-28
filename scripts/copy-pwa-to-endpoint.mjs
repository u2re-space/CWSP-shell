#!/usr/bin/env node

import { cp, rm, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

const appRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(appRoot, "dist");
const targetBaseDir = resolve(appRoot, "..", "..", "runtime", "cwsp", "endpoint", "frontend", "apps", "cw");

/**
 * Copy all built PWA assets to the endpoint directory served by Fastify.
 * The deployed frontend expects `/apps/cw/index.js` and `/apps/cw/pwa/manifest.json`.
 * Existing files are replaced so deploys are deterministic.
 */
async function run() {
    console.log(`[copy-pwa-to-endpoint] Copying PWA build artifacts...`);
    console.log(`  Source root: ${distDir}`);
    console.log(`  Target root: ${targetBaseDir}`);

    if (!existsSync(distDir)) {
        console.error(`[copy-pwa-to-endpoint] Source directory not found: ${distDir}. Run "npm run build:pwa" first.`);
        process.exit(1);
    }

    try {
        // Deploy a clean tree each time to avoid stale chunk references surviving from prior releases.
        await rm(targetBaseDir, { recursive: true, force: true });
        await mkdir(targetBaseDir, { recursive: true });

        await cp(distDir, targetBaseDir, {
            recursive: true,
            force: true,
            preserveTimestamps: true,
        });
        console.log(`  Copied dist -> ${targetBaseDir}`);

        // Existing manifest generation can place this file under `pwa/src/pwa/manifest.json`.
        // Normalize to `/pwa/manifest.json` so runtime static serving route is consistent.
        const nestedManifestPath = resolve(targetBaseDir, "pwa", "src", "pwa", "manifest.json");
        const desiredManifestPath = resolve(targetBaseDir, "pwa", "manifest.json");

        if (existsSync(nestedManifestPath)) {
            console.log(`  Normalizing manifest path: ${nestedManifestPath} -> ${desiredManifestPath}`);
            await mkdir(dirname(desiredManifestPath), { recursive: true });
            await cp(nestedManifestPath, desiredManifestPath, { force: true });

            const nestedManifestRoot = resolve(targetBaseDir, "pwa", "src");
            await rm(nestedManifestRoot, { recursive: true, force: true });
            console.log("  Removed nested pwa/src manifest folder.");
        }

        console.log("[copy-pwa-to-endpoint] PWA build artifacts copied successfully.");
    } catch (error) {
        console.error("[copy-pwa-to-endpoint] Failed to copy PWA build artifacts:", error);
        process.exit(1);
    }
}

run();
