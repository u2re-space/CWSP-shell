/*
 * Filename: apk-release-version.mjs
 * FullPath: apps/CWSP-shell/scripts/apk-release-version.mjs
 * FIND:apk-update
 * Change date and time: 18.05.00_27.08.2026
 * Reason for changes: Publish manifests from the APK binary so Check sees the real versionCode.
 *
 * INVARIANT: latest-*.json versionCode/versionName must match the staged APK, not a stale properties file.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function readVersionProps(propsPath) {
    if (!propsPath || !fs.existsSync(propsPath)) {
        return { versionCode: 0, versionName: "" };
    }
    const map = {};
    for (const line of fs.readFileSync(propsPath, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 0) continue;
        map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return {
        versionCode: Number(map.VERSION_CODE || 0) || 0,
        versionName: String(map.VERSION_NAME || "")
    };
}

function buildToolsBin(name) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
    const roots = [sdk && path.join(sdk, "build-tools"), "/opt/android-sdk/build-tools"].filter(Boolean);
    for (const root of roots) {
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
        const vers = fs
            .readdirSync(root)
            .filter((n) => /^\d/.test(n))
            .sort()
            .reverse();
        for (const v of vers) {
            const bin = path.join(root, v, name);
            if (fs.existsSync(bin)) return bin;
        }
    }
    return "";
}

function parseBadging(text) {
    const line = String(text || "")
        .split(/\r?\n/)
        .find((row) => row.startsWith("package:"));
    if (!line) return null;
    const pkg = line.match(/\bname='([^']+)'/);
    const code = line.match(/\bversionCode='(\d+)'/);
    const name = line.match(/\bversionName='([^']*)'/);
    if (!code) return null;
    return {
        packageId: pkg?.[1] || "",
        versionCode: Number(code[1]) || 0,
        versionName: name?.[1] || ""
    };
}

/** Read versionCode / versionName / packageId from the APK (aapt dump badging). */
export function dumpApkVersion(apkPath) {
    const bins = [process.env.CWSP_AAPT, buildToolsBin("aapt"), buildToolsBin("aapt2")].filter(Boolean);
    for (const bin of bins) {
        const args = path.basename(bin).startsWith("aapt2")
            ? ["dump", "badging", apkPath]
            : ["dump", "badging", apkPath];
        const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
        const parsed = parseBadging(`${r.stdout || ""}\n${r.stderr || ""}`);
        if (parsed?.versionCode) return parsed;
    }
    return null;
}

function walkApks(dir, out = []) {
    if (!dir || !fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkApks(p, out);
        else if (ent.isFile() && ent.name.endsWith(".apk")) out.push(p);
    }
    return out;
}

/**
 * Prefer the highest versionCode under dir; mtime is the tie-breaker.
 * WHY: copyCwspApks keeps 0.0.1 + 0.0.3 side by side — newest mtime is not always the newest SKU.
 */
export function pickHighestVersionApk(dir) {
    const files = walkApks(dir);
    if (!files.length) return null;
    let best = null;
    let bestCode = -1;
    let bestMtime = -1;
    for (const file of files) {
        const dump = dumpApkVersion(file);
        const code = dump?.versionCode || 0;
        const mtime = fs.statSync(file).mtimeMs;
        if (code > bestCode || (code === bestCode && mtime >= bestMtime)) {
            best = file;
            bestCode = code;
            bestMtime = mtime;
        }
    }
    return best;
}

/**
 * Manifest version comes from the APK. Properties are a sanity check only.
 */
export function resolvePublishVersion({ apkPath, propsPath, expectedPackageId = "" }) {
    const props = readVersionProps(propsPath);
    const dump = dumpApkVersion(apkPath);
    if (!dump || !dump.versionCode) {
        if (!props.versionCode) {
            throw new Error(`Cannot read version from APK (${apkPath}) or ${propsPath || "version.properties"}`);
        }
        console.warn("[publish-apk] WARN: aapt dump failed — using version.properties (may drift from the APK)");
        return { versionCode: props.versionCode, versionName: props.versionName || "0.0.0", source: "properties" };
    }
    if (expectedPackageId && dump.packageId && dump.packageId !== expectedPackageId) {
        throw new Error(`APK packageId ${dump.packageId} != ${expectedPackageId}`);
    }
    if (props.versionCode && props.versionCode !== dump.versionCode) {
        console.warn(
            `[publish-apk] WARN: version.properties is ${props.versionName || "?"} (${props.versionCode}) but APK is ${dump.versionName} (${dump.versionCode}) — publishing APK values`
        );
    }
    return {
        versionCode: dump.versionCode,
        versionName: dump.versionName || props.versionName || `0.0.${dump.versionCode}`,
        source: "apk"
    };
}
