/*
 * Filename: build-capacitor.mjs
 * FullPath: apps/CWSP-shell/scripts/build-capacitor.mjs
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher APK build (web + Gradle assembleDebug).
 *
 * Usage:
 *   node scripts/build-capacitor.mjs
 *   node scripts/build-capacitor.mjs --release
 *   node scripts/build-capacitor.mjs --web-only
 *   node scripts/build-capacitor.mjs --skip-web
 *   node scripts/build-capacitor.mjs --no-bump
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bumpCapacitorVersion } from "./bump-capacitor-version.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID_ROOT = path.join(APP_ROOT, "platforms/android");

function parseArgs(argv) {
    const envNoBump = String(process.env.CWSP_CAPACITOR_NO_BUMP || "").trim() === "1";
    return {
        release: argv.includes("--release"),
        webOnly: argv.includes("--web-only"),
        skipWeb: argv.includes("--skip-web"),
        noBump: argv.includes("--no-bump") || envNoBump
    };
}

function run(cmd, args, opts = {}) {
    console.log(`[build:capacitor] ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, {
        cwd: opts.cwd || APP_ROOT,
        stdio: "inherit",
        env: { ...process.env, ...(opts.env || {}) }
    });
    if (r.status !== 0) {
        throw new Error(`${cmd} failed with status ${r.status}`);
    }
}

function resolveJavaHome() {
    if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, "bin/java"))) {
        return process.env.JAVA_HOME;
    }
    const candidates = [
        process.env.JAVA_HOME_21,
        "/usr/lib/jvm/java-21-openjdk-amd64",
        "/usr/lib/jvm/java-17-openjdk-amd64",
        process.env.JAVA_HOME_17
    ].filter(Boolean);
    for (const home of candidates) {
        if (fs.existsSync(path.join(home, "bin/java"))) return home;
    }
    return process.env.JAVA_HOME || "";
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.skipWeb) {
        run("npm", ["run", "build:capacitor:web"]);
    }

    if (args.webOnly) {
        console.log("[build:capacitor] web-only — skipping Android APK");
        return;
    }

    let bumped = null;
    if (args.noBump) {
        console.log("[build:capacitor] --no-bump — keeping platforms/android/version.properties");
    } else {
        bumped = bumpCapacitorVersion();
    }

    run(process.execPath, [path.join(APP_ROOT, "scripts/sync-capacitor-android.mjs")]);

    if (!fs.existsSync(path.join(ANDROID_ROOT, "gradlew"))) {
        throw new Error(`missing ${ANDROID_ROOT}/gradlew`);
    }

    const javaHome = resolveJavaHome();
    const env = {
        ANDROID_HOME: process.env.ANDROID_HOME || "/home/u2re-dev/Android/Sdk",
        ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "/home/u2re-dev/Android/Sdk"
    };
    if (javaHome) {
        env.JAVA_HOME = javaHome;
        console.log(`[build:capacitor] JAVA_HOME=${javaHome}`);
    }

    const buildType = args.release ? "Release" : "Debug";
    const task = `assemble${buildType}`;
    run("./gradlew", ["--no-daemon", task, "copyCwspApks"], { cwd: ANDROID_ROOT, env });

    const apkOut = path.join(APP_ROOT, "build/capacitor/apk");
    const versionName = bumped?.versionName;
    const launcherApk = versionName ? `cwsp-launcher-${versionName}.apk` : null;
    const hasLauncherApk = launcherApk ? fs.existsSync(path.join(apkOut, launcherApk)) : false;
    if (!hasLauncherApk) {
        run(process.execPath, [path.join(APP_ROOT, "scripts/copy-capacitor-apk.mjs")]);
    }

    const verLabel = bumped ? `${bumped.versionName} (${bumped.versionCode})` : "(unchanged version.properties)";
    console.log(`[build:capacitor] OK — ${verLabel} — APKs under ${apkOut}`);
}

try {
    main();
} catch (err) {
    console.error("[build:capacitor]", err?.message || err);
    process.exit(1);
}
