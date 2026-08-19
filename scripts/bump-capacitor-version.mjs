/*
 * Filename: bump-capacitor-version.mjs
 * FullPath: apps/CWSP-shell/scripts/bump-capacitor-version.mjs
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher APK version bump (VERSION_CODE SoT).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PROPS = path.join(APP_ROOT, "platforms/android", "version.properties");
const PACKAGE_JSON = path.join(APP_ROOT, "package.json");

function readProps(filePath) {
    const map = {};
    if (!fs.existsSync(filePath)) return map;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 0) continue;
        map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return map;
}

function nextVersionName(currentName, versionCode) {
    const m = String(currentName || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (m) {
        const major = Number(m[1]);
        const minor = Number(m[2]);
        const patch = Number(m[3]) + 1;
        return `${major}.${minor}.${patch}`;
    }
    return `0.0.${versionCode}`;
}

export function bumpCapacitorVersion({ dryRun = false } = {}) {
    const props = readProps(VERSION_PROPS);
    const prevCode = Number(props.VERSION_CODE || "0") || 0;
    const versionCode = prevCode + 1;
    const versionName = nextVersionName(props.VERSION_NAME, versionCode);
    const lines = [
        `# bumped ${new Date().toISOString()}`,
        `VERSION_CODE=${versionCode}`,
        `VERSION_NAME=${versionName}`,
        ""
    ];
    if (dryRun) {
        console.log(`[bump-capacitor-version] dry-run → ${versionName} (${versionCode})`);
        return { versionCode, versionName };
    }
    fs.writeFileSync(VERSION_PROPS, lines.join("\n"));
    if (fs.existsSync(PACKAGE_JSON)) {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
        pkg.version = versionName;
        fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 4)}\n`);
    }
    console.log(`[bump-capacitor-version] ${props.VERSION_NAME || "?"} (${prevCode}) → ${versionName} (${versionCode})`);
    return { versionCode, versionName };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dryRun = process.argv.includes("--dry-run");
    bumpCapacitorVersion({ dryRun });
}
