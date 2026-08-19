/*
 * Filename: copy-capacitor-apk.mjs
 * FullPath: apps/CWSP-shell/scripts/copy-capacitor-apk.mjs
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher — publish Gradle APKs into build/capacitor/apk.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPwaIdentity } from "./sync-capacitor-app-identity.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FROM = path.join(APP_ROOT, "platforms/android/build/outputs/apk");
const PUBLISH_ROOT = path.join(APP_ROOT, "build/capacitor/apk");

function parseArgs(argv) {
    let from = DEFAULT_FROM;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--from") from = path.resolve(argv[++i] || from);
        else if (argv[i].startsWith("--from=")) from = path.resolve(argv[i].slice("--from=".length));
    }
    return { from };
}

function readVersionName() {
    const propsPath = path.join(APP_ROOT, "platforms/android/version.properties");
    if (!fs.existsSync(propsPath)) return null;
    const raw = fs.readFileSync(propsPath, "utf8");
    const match = raw.match(/^VERSION_NAME=(.+)$/m);
    return match ? match[1].trim() : null;
}

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function main() {
    const { from } = parseArgs(process.argv.slice(2));
    const versionName = readVersionName();
    if (!fs.existsSync(from)) {
        console.error(`[copy-capacitor-apk] missing source dir: ${from}`);
        process.exit(1);
    }

    let copied = 0;
    for (const type of fs.readdirSync(from, { withFileTypes: true })) {
        if (!type.isDirectory()) continue;
        const typeDir = path.join(from, type.name);
        for (const name of fs.readdirSync(typeDir)) {
            if (!name.endsWith(".apk")) continue;
            const src = path.join(typeDir, name);
            const apkStem =
                loadPwaIdentity()
                    .appName.toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "") || "cw-i1";
            const typedName = versionName ? `${apkStem}-${versionName}.apk` : `${apkStem}-${type.name}.apk`;
            const typedDest = path.join(PUBLISH_ROOT, type.name, typedName);
            const flatDest = path.join(PUBLISH_ROOT, typedName);
            copyFile(src, typedDest);
            copyFile(src, flatDest);
            console.log(`[copy-capacitor-apk] ${src} → ${typedDest}`);
            copied += 1;
        }
    }

    if (copied === 0) {
        console.error(`[copy-capacitor-apk] no .apk files under ${from}`);
        process.exit(1);
    }
    console.log(`[copy-capacitor-apk] OK (${copied}) → ${PUBLISH_ROOT}`);
}

main();
