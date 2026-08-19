/*
 * Filename: sync-capacitor-app-identity.mjs
 * FullPath: apps/CWSP-shell/scripts/sync-capacitor-app-identity.mjs
 * Change date and time: 05.40.00_20.08.2026
 * Reason for changes: Capacitor SKU identity follows src/pwa/manifest.json (PWA parity).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(APP_ROOT, "src/pwa/manifest.json");

/** `cw.u2re.space` → `space.u2re.cw` (Android / Capacitor applicationId). */
export function manifestNameToAppId(name) {
    const parts = String(name || "")
        .trim()
        .split(".")
        .filter(Boolean);
    if (parts.length < 2) {
        throw new Error(`manifest.name must be a dotted id (got ${JSON.stringify(name)})`);
    }
    return parts.reverse().join(".");
}

export function loadPwaIdentity(manifestPath = MANIFEST) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const appTitle = String(manifest.name || "").trim();
    const appName = String(manifest.short_name || appTitle).trim();
    if (!appTitle || !appName) {
        throw new Error("manifest.json must define name and short_name");
    }
    return {
        appId: manifestNameToAppId(appTitle),
        appName,
        appTitle,
        themeColor: String(manifest.theme_color || "#000000").trim()
    };
}

function patchFile(filePath, replacers) {
    if (!fs.existsSync(filePath)) return false;
    let text = fs.readFileSync(filePath, "utf8");
    let changed = false;
    for (const [pattern, replacement] of replacers) {
        const next = text.replace(pattern, replacement);
        if (next !== text) {
            text = next;
            changed = true;
        }
    }
    if (changed) fs.writeFileSync(filePath, text);
    return changed;
}

function syncCapacitorConfig(identity) {
    const jsonPath = path.join(APP_ROOT, "src/frontend/web/capacitor-launcher/capacitor.config.json");
    const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    cfg.appId = identity.appId;
    cfg.appName = identity.appName;
    fs.writeFileSync(jsonPath, `${JSON.stringify(cfg, null, 4)}\n`);

    const tsPath = path.join(APP_ROOT, "src/frontend/web/capacitor-launcher/capacitor.config.ts");
    patchFile(tsPath, [
        [/appId:\s*"[^"]+"/, `appId: "${identity.appId}"`],
        [/appName:\s*"[^"]+"/, `appName: "${identity.appName}"`]
    ]);
}

function syncAndroidGradle(identity) {
    const gradlePaths = [
        path.join(APP_ROOT, "platforms/android/build.gradle"),
        path.join(APP_ROOT, "platforms/android/main/java/build.gradle")
    ];
    for (const gradlePath of gradlePaths) {
        patchFile(gradlePath, [
            [/applicationId\s+"[^"]+"/, `applicationId "${identity.appId}"`],
            [/resValue "string", "app_name", "[^"]+"/, `resValue "string", "app_name", "${identity.appName}"`]
        ]);
    }
}

function syncAndroidStrings(identity) {
    const stringsPath = path.join(APP_ROOT, "platforms/android/res/values/strings.xml");
    patchFile(stringsPath, [
        [/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${identity.appName}</string>`],
        [/<string name="title_activity_main">[^<]*<\/string>/, `<string name="title_activity_main">${identity.appTitle}</string>`],
        [/<string name="package_name">[^<]*<\/string>/, `<string name="package_name">${identity.appId}</string>`],
        [/<string name="custom_url_scheme">[^<]*<\/string>/, `<string name="custom_url_scheme">${identity.appId}</string>`]
    ]);
}

function syncLauncherHtml(identity) {
    const htmlPath = path.join(APP_ROOT, "src/frontend/web/capacitor-launcher/index.html");
    patchFile(htmlPath, [[/<title>[^<]*<\/title>/, `<title>${identity.appName}</title>`]]);
}

function syncLauncherBackground(identity) {
    const bgPath = path.join(APP_ROOT, "platforms/android/res/values/ic_launcher_background.xml");
    const hex = identity.themeColor.startsWith("#") ? identity.themeColor : `#${identity.themeColor}`;
    patchFile(bgPath, [[/<color name="ic_launcher_background">[^<]*<\/color>/, `<color name="ic_launcher_background">${hex}</color>`]]);
}

function syncGradleIdentityProps(identity) {
    const apkStem =
        identity.appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cw-i1";
    const propsPath = path.join(APP_ROOT, "platforms/android/cwsp-app-identity.properties");
    const body = [
        "# Generated from src/pwa/manifest.json — do not hand-edit.",
        `APP_ID=${identity.appId}`,
        `APP_NAME=${identity.appName}`,
        `APP_TITLE=${identity.appTitle}`,
        `APK_STEM=${apkStem}`,
        ""
    ].join("\n");
    fs.writeFileSync(propsPath, body);
}

export function syncCapacitorAppIdentity(opts = {}) {
    const identity = loadPwaIdentity(opts.manifestPath);
    syncCapacitorConfig(identity);
    syncAndroidGradle(identity);
    syncAndroidStrings(identity);
    syncLauncherHtml(identity);
    syncLauncherBackground(identity);
    syncGradleIdentityProps(identity);
    console.log(
        `[sync-capacitor-app-identity] appId=${identity.appId} appName=${identity.appName} title=${identity.appTitle}`
    );
    return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    syncCapacitorAppIdentity();
}
