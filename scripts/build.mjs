#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");

const moduleBuildTargets = [
    resolve(repoRoot, "modules/projects/core.ts"),
    resolve(repoRoot, "modules/projects/dom.ts"),
    resolve(repoRoot, "modules/projects/object.ts"),
    resolve(repoRoot, "modules/projects/veela.css"),
    resolve(repoRoot, "modules/projects/lur.e"),
    resolve(repoRoot, "modules/projects/icon.ts"),
    resolve(repoRoot, "modules/projects/fl.ui"),
    resolve(repoRoot, "modules/projects/uniform.ts"),
];

const targetMap = {
    pwa: { cwd: appRoot, command: "npm", args: ["run", "build:pwa"] },
    crx: { cwd: appRoot, command: "npm", args: ["run", "build:crx"] },
};

const normalizeTargets = (raw) => {
    if (!raw.length) return ["pwa", "crx"];
    if (raw.includes("all")) return ["pwa", "crx", "modules"];
    return raw;
};

const startBuild = (name, cwd, command, args) => {
    return new Promise((resolvePromise) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: "inherit",
            shell: false,
        });

        child.on("close", (code) => {
            resolvePromise({
                name,
                cwd,
                code: typeof code === "number" ? code : 1,
            });
        });
        child.on("error", () => {
            resolvePromise({ name, cwd, code: 1 });
        });
    });
};

const run = async () => {
    const targets = normalizeTargets(process.argv.slice(2));
    const jobs = [];

    for (const target of targets) {
        if (target === "modules") {
            for (const modulePath of moduleBuildTargets) {
                const moduleName = modulePath.split("/").at(-1) || modulePath;
                jobs.push(
                    startBuild(`module:${moduleName}`, modulePath, "npm", ["run", "build"])
                );
            }
            continue;
        }

        const config = targetMap[target];
        if (!config) {
            console.warn(`[build] Unknown target skipped: ${target}`);
            continue;
        }
        jobs.push(startBuild(target, config.cwd, config.command, config.args));
    }

    if (!jobs.length) {
        console.warn("[build] No valid targets selected");
        process.exit(0);
    }

    const results = await Promise.allSettled(jobs);
    let hasFailed = false;

    for (const settled of results) {
        if (settled.status !== "fulfilled") {
            hasFailed = true;
            continue;
        }
        const result = settled.value;
        if (result.code !== 0) hasFailed = true;
        const state = result.code === 0 ? "ok" : `failed(${result.code})`;
        console.log(`[build] ${result.name}: ${state}`);
    }

    process.exit(hasFailed ? 1 : 0);
};

run().catch((error) => {
    console.error("[build] Unexpected error", error);
    process.exit(1);
});
