/*
 * Filename: bump-capacitor-version.mjs
 * FullPath: apps/CWSP-shell/scripts/bump-capacitor-version.mjs
 * FIND:sku
 * Change date and time: 15.40.00_27.08.2026
 * Reason for changes: Same VERSION_CODE bump for launcher and sibling SKU APKs (--app).
 *
 * Usage:
 *   node bump-capacitor-version.mjs [--app /path/to/CWSP-<sku>] [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
    let app = SHELL_ROOT;
    let dryRun = false;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--dry-run") dryRun = true;
        else if (argv[i] === "--app") app = path.resolve(String(argv[++i] || app));
    }
    return { app, dryRun };
}

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
    const m = String(currentName || "")
        .trim()
        .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (m) {
        const major = Number(m[1]);
        const minor = Number(m[2]);
        const patch = Number(m[3]) + 1;
        return `${major}.${minor}.${patch}`;
    }
    return `0.0.${versionCode}`;
}

/** INVARIANT: explorer-view package.json is the view library — do not rewrite its 1.0.0. */
function shouldWritePackageJson(appRoot, pkg) {
    const name = String(pkg?.name || "");
    if (name === "explorer-view") return false;
    if (appRoot === SHELL_ROOT) return true;
    return name.startsWith("cwsp-") && Object.prototype.hasOwnProperty.call(pkg, "version");
}

export function bumpCapacitorVersion({ dryRun = false, appRoot = SHELL_ROOT } = {}) {
    const versionProps = path.join(appRoot, "platforms/android", "version.properties");
    const packageJson = path.join(appRoot, "package.json");
    fs.mkdirSync(path.dirname(versionProps), { recursive: true });
    const props = readProps(versionProps);
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
        console.log(`[bump-capacitor-version] dry-run ${path.basename(appRoot)} → ${versionName} (${versionCode})`);
        return { versionCode, versionName };
    }
    fs.writeFileSync(versionProps, lines.join("\n"));
    if (fs.existsSync(packageJson)) {
        const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        if (shouldWritePackageJson(appRoot, pkg)) {
            pkg.version = versionName;
            fs.writeFileSync(packageJson, `${JSON.stringify(pkg, null, 4)}\n`);
        }
    }
    console.log(
        `[bump-capacitor-version] ${path.basename(appRoot)} ${props.VERSION_NAME || "?"} (${prevCode}) → ${versionName} (${versionCode})`
    );
    return { versionCode, versionName };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { app, dryRun } = parseArgs(process.argv.slice(2));
    bumpCapacitorVersion({ dryRun, appRoot: app });
}
