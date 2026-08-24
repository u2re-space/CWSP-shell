/*
 * Filename: adb-install-apks.mjs
 * FullPath: apps/CWSP-shell/scripts/adb-install-apks.mjs
 * FIND:sku
 * Change date and time: 14.05.00_24.08.2026
 * Reason for changes: Install an APK on every usable ADB device (skip TLS aliases).
 *
 * Usage:
 *   node scripts/adb-install-apks.mjs <apk> [apk...]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** WHY: marble/Metroid also show adb-*-tls aliases — installing twice races and confuses -s. */
export function listAdbSerials() {
    const r = spawnSync("adb", ["devices"], { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`adb devices failed: ${r.stderr || r.status}`);
    }
    const serials = [];
    for (const line of String(r.stdout || "").split("\n").slice(1)) {
        const m = line.match(/^(\S+)\s+device\b/);
        if (!m) continue;
        const serial = m[1];
        if (serial.includes("_adb-tls-connect") || serial.startsWith("adb-")) continue;
        serials.push(serial);
    }
    return serials;
}

export function adbInstall(apk, serial) {
    if (!fs.existsSync(apk)) throw new Error(`missing APK: ${apk}`);
    console.log(`[adb-install] ${serial} ← ${apk}`);
    const r = spawnSync("adb", ["-s", serial, "install", "-r", "-d", apk], { stdio: "inherit" });
    if (r.status !== 0) {
        throw new Error(`adb install failed on ${serial} (${r.status})`);
    }
}

export function installApksOnFleet(apks) {
    const serials = listAdbSerials();
    if (!serials.length) throw new Error("no ADB devices (non-TLS) attached");
    console.log(`[adb-install] targets: ${serials.join(", ")}`);
    for (const apk of apks) {
        for (const serial of serials) adbInstall(apk, serial);
    }
}

function main() {
    const apks = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    if (!apks.length) {
        console.error("usage: node adb-install-apks.mjs <apk> [apk...]");
        process.exit(1);
    }
    installApksOnFleet(apks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (err) {
        console.error("[adb-install]", err?.message || err);
        process.exit(1);
    }
}
