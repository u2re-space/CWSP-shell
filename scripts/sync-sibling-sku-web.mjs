/*
 * Filename: sync-sibling-sku-web.mjs
 * FullPath: apps/CWSP-shell/scripts/sync-sibling-sku-web.mjs
 * FIND:sku
 * Change date and time: 14.08.00_24.08.2026
 * Reason for changes: Copy explorer/document Vite webDir into platforms/android assets.
 *
 * Usage:
 *   node scripts/sync-sibling-sku-web.mjs explorer|document|process
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKUS = {
    explorer: {
        appRoot: path.resolve(SHELL_ROOT, "../CWSP-explorer"),
        config: "src/frontend/web/capacitor/capacitor.config.json"
    },
    document: {
        appRoot: path.resolve(SHELL_ROOT, "../CWSP-document"),
        config: "src/frontend/web/capacitor/capacitor.config.json"
    },
    process: {
        appRoot: path.resolve(SHELL_ROOT, "../CWSP-process"),
        config: "src/frontend/web/capacitor/capacitor.config.json"
    }
};

function copyTree(src, dest) {
    const st = fs.statSync(src);
    if (st.isFile()) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        return;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        if (name === ".git" || name === "node_modules") continue;
        copyTree(path.join(src, name), path.join(dest, name));
    }
}

function main() {
    const sku = process.argv[2];
    const spec = SKUS[sku];
    if (!spec) throw new Error("usage: node sync-sibling-sku-web.mjs explorer|document|process");
    const appRoot = fs.realpathSync(spec.appRoot);
    const webDir = path.join(appRoot, "build/capacitor/web");
    const assets = path.join(appRoot, "platforms/android/src/main/assets");
    const pub = path.join(assets, "public");
    if (!fs.existsSync(webDir)) throw new Error(`missing web bundle: ${webDir}`);
    fs.rmSync(pub, { recursive: true, force: true });
    fs.mkdirSync(assets, { recursive: true });
    copyTree(webDir, pub);

    const configPath = path.join(appRoot, spec.config);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    delete raw._comment;
    raw.webDir = "public";
    raw.server = raw.server && typeof raw.server === "object" ? { ...raw.server } : {};
    raw.server.androidScheme = String(raw.server.androidScheme || "https").toLowerCase();
    if (raw.server.androidScheme !== "http" && raw.server.androidScheme !== "https") {
        raw.server.androidScheme = "https";
    }
    raw.server.cleartext = raw.server.cleartext === true;
    fs.writeFileSync(path.join(assets, "capacitor.config.json"), `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`[sync-sku-web] ${webDir} → ${pub}`);
}

try {
    main();
} catch (err) {
    console.error("[sync-sku-web]", err?.message || err);
    process.exit(1);
}
