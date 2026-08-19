/*
 * Filename: sync-capacitor-android.mjs
 * FullPath: apps/CWSP-shell/scripts/sync-capacitor-android.mjs
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher — sync web bundle into platforms/android assets.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(APP_ROOT, "build/capacitor/web");
const ASSETS = path.join(APP_ROOT, "platforms/android/src/main/assets");
const PUBLIC = path.join(ASSETS, "public");
const CONFIG_CANDIDATES = [
    path.join(APP_ROOT, "src/frontend/web/capacitor-launcher/capacitor.config.json")
];

function rimraf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

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

function expandEnvPlaceholders(value) {
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (_m, name, fallback) => {
            const env = process.env[name];
            if (env != null && String(env).length > 0) return String(env);
            return fallback != null ? String(fallback) : "";
        });
    }
    if (Array.isArray(value)) return value.map(expandEnvPlaceholders);
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = expandEnvPlaceholders(v);
        return out;
    }
    return value;
}

function sanitizeRuntimeConfig(raw) {
    const cfg = expandEnvPlaceholders(raw);
    delete cfg._comment;
    cfg.webDir = "public";
    cfg.server = cfg.server && typeof cfg.server === "object" ? { ...cfg.server } : {};
    let scheme = String(cfg.server.androidScheme || process.env.CWSP_ANDROID_SCHEME || "https")
        .trim()
        .toLowerCase();
    if (scheme !== "http" && scheme !== "https") scheme = "https";
    cfg.server.androidScheme = scheme;
    cfg.server.cleartext = cfg.server.cleartext === true || process.env.CWSP_ALLOW_CLEARTEXT === "1";
    if (cfg.android && typeof cfg.android === "object") {
        const android = { ...cfg.android };
        delete android.buildOptions;
        cfg.android = android;
    }
    return cfg;
}

function main() {
    if (!fs.existsSync(WEB_DIR)) {
        throw new Error(`missing web bundle: ${WEB_DIR} (run build:capacitor:web first)`);
    }
    rimraf(PUBLIC);
    fs.mkdirSync(ASSETS, { recursive: true });
    copyTree(WEB_DIR, PUBLIC);
    console.log(`[sync-capacitor-android] ${WEB_DIR} → ${PUBLIC}`);

    const configPath = CONFIG_CANDIDATES.find((p) => fs.existsSync(p));
    if (!configPath) {
        throw new Error("missing capacitor.config.json for launcher");
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const runtime = sanitizeRuntimeConfig(raw);
    const destConfig = path.join(ASSETS, "capacitor.config.json");
    fs.writeFileSync(destConfig, `${JSON.stringify(runtime, null, 2)}\n`);
    console.log(`[sync-capacitor-android] wrote ${destConfig}`);
}

main();
