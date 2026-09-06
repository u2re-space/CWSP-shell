/*
 * Filename: resolve-java-home.mjs
 * FullPath: apps/CWSP-shell/scripts/resolve-java-home.mjs
 * FIND:sku
 * Change date and time: 13.45.00_06.09.2026
 * Reason for changes: Gradle 8.14 / AGP 8.13 cannot boot on Java 25 (class file 69).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Gradle 8.14 supports through Java 24; AGP 8.13 wants 17 or 21. */
const MIN_MAJOR = 17;
const MAX_MAJOR = 21;

const readMajor = (home) => {
    const java = path.join(home, "bin/java");
    if (!fs.existsSync(java)) return 0;
    const release = path.join(home, "release");
    if (fs.existsSync(release)) {
        const text = fs.readFileSync(release, "utf8");
        const match = text.match(/JAVA_VERSION="(\d+)/);
        if (match) return Number(match[1]);
    }
    const out = spawnSync(java, ["-version"], { encoding: "utf8" });
    const blob = `${out.stderr || ""}\n${out.stdout || ""}`;
    const match = blob.match(/version "(\d+)/);
    return match ? Number(match[1]) : 0;
};

const homesFromPath = () => {
    const java = spawnSync("which", ["java"], { encoding: "utf8" }).stdout?.trim();
    if (!java) return [];
    try {
        const real = fs.realpathSync(java);
        const home = path.resolve(path.dirname(real), "..");
        return fs.existsSync(path.join(home, "bin/java")) ? [home] : [];
    } catch {
        return [];
    }
};

/**
 * Pick a JDK that can launch Gradle 8.14 + AGP 8.13.
 * Prefers 21, then 17. Skips Java 25+ even if JAVA_HOME points at it.
 */
export const resolveJavaHome = () => {
    const homeDir = process.env.HOME || "";
    const candidates = [
        process.env.JAVA_HOME_21,
        "/usr/lib/jvm/java-21-openjdk-amd64",
        "/usr/lib/jvm/java-21-openjdk",
        homeDir && path.join(homeDir, ".local/jdk-21"),
        homeDir && path.join(homeDir, ".jdks/jdk-21"),
        process.env.JAVA_HOME_17,
        "/usr/lib/jvm/java-17-openjdk-amd64",
        "/usr/lib/jvm/java-17-openjdk",
        process.env.JAVA_HOME,
        ...homesFromPath()
    ].filter(Boolean);

    const seen = new Set();
    let fallback = "";
    for (const home of candidates) {
        const resolved = path.resolve(home);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        const major = readMajor(resolved);
        if (major >= MIN_MAJOR && major <= MAX_MAJOR) return resolved;
        if (major && !fallback) fallback = `${resolved} (Java ${major})`;
    }
    return "";
};

export const requireJavaHome = () => {
    const home = resolveJavaHome();
    if (home) return home;
    throw new Error(
        "No JDK 17/21 for Gradle 8.14 (Java 25 is too new). Install openjdk-21-jdk or set JAVA_HOME_21."
    );
};

export default resolveJavaHome;
