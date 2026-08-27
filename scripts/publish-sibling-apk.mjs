/*
 * Filename: publish-sibling-apk.mjs
 * FullPath: apps/CWSP-shell/scripts/publish-sibling-apk.mjs
 * FIND:apk-update
 * Change date: 18.05.00_27.08.2026
 * Reason: Stage explorer / document / process APKs; manifest version comes from the APK binary.
 *
 * Usage:
 *   node scripts/publish-sibling-apk.mjs explorer|document|process [--apk path] [--dest path] [--remote] [--dry-run]
 *
 * Version SoT: the APK binary (aapt dump). version.properties is a sanity check only.
 * Does not touch transfer latest.json / cwsp.apk or launcher latest-launcher.json.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickHighestVersionApk, resolvePublishVersion } from "./apk-release-version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = path.resolve(HERE, "..");
const APPS_ROOT = path.resolve(SHELL_ROOT, "..");

const SKUS = {
    explorer: {
        sku: "explorer",
        appRoot: path.join(APPS_ROOT, "CWSP-explorer"),
        packageId: "space.u2re.explorer",
        apkName: "cwsp-explorer.apk",
        manifestName: "latest-explorer.json"
    },
    document: {
        sku: "document",
        appRoot: path.join(APPS_ROOT, "CWSP-document"),
        packageId: "space.u2re.document",
        apkName: "cwsp-document.apk",
        manifestName: "latest-document.json"
    },
    process: {
        sku: "process",
        appRoot: path.join(APPS_ROOT, "CWSP-process"),
        packageId: "space.u2re.process",
        apkName: "cwsp-process.apk",
        manifestName: "latest-process.json"
    }
};

const TRANSFER_RELEASES = path.resolve(
    APPS_ROOT,
    "CWSP-transfer",
    "runtime",
    "endpoint",
    ".data",
    "releases",
    "android"
);

function printHelp() {
    console.log(`publish-sibling-apk

Usage:
  node scripts/publish-sibling-apk.mjs <explorer|document|process> [options]

Options:
  --apk <path>     APK to publish (default: newest build/capacitor/apk/*.apk)
  --dest <path>    Local releases dir (default: CWSP-transfer runtime/endpoint/.data/releases/android)
  --remote         Also rsync dest → gateway .200 releases dir
  --dry-run        Print actions only
  --help
`);
}

function parseArgs(argv) {
    const out = { sku: null, apk: null, dest: null, remote: false, dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") out.help = true;
        else if (a === "--remote") out.remote = true;
        else if (a === "--dry-run") out.dryRun = true;
        else if (a === "--apk") out.apk = argv[++i];
        else if (a === "--dest") out.dest = argv[++i];
        else if (a.startsWith("--apk=")) out.apk = a.slice("--apk=".length);
        else if (a.startsWith("--dest=")) out.dest = a.slice("--dest=".length);
        else if (!a.startsWith("-") && !out.sku) out.sku = a.trim().toLowerCase();
    }
    return out;
}

function sha256File(filePath) {
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

function normalizeCertSha256(raw) {
    return String(raw || "")
        .toLowerCase()
        .replace(/[^0-9a-f]/g, "");
}

function extractApkSigningCertSha256(apkPath) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
    const apksignerCandidates = [
        process.env.CWSP_APKSIGNER,
        sdk && path.join(sdk, "build-tools"),
        "/opt/android-sdk/build-tools",
        path.join(os.homedir(), "Android", "Sdk", "build-tools")
    ].filter(Boolean);

    for (const base of apksignerCandidates) {
        let bin = base;
        if (fs.existsSync(base) && fs.statSync(base).isDirectory() && !String(base).endsWith("apksigner")) {
            try {
                const vers = fs
                    .readdirSync(base)
                    .filter((n) => /^\d/.test(n))
                    .sort()
                    .reverse();
                if (!vers.length) continue;
                bin = path.join(base, vers[0], process.platform === "win32" ? "apksigner.bat" : "apksigner");
            } catch {
                continue;
            }
        }
        if (!bin || !fs.existsSync(bin)) continue;
        const r = spawnSync(bin, ["verify", "--print-certs", apkPath], {
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024
        });
        const out = `${r.stdout || ""}\n${r.stderr || ""}`;
        const m =
            out.match(/Signer\s+#1\s+certificate\s+SHA-256\s+digest:\s*([0-9a-f:]+)/i) ||
            out.match(/SHA-256\s+digest:\s*([0-9a-f:]+)/i);
        if (m?.[1]) {
            const hex = normalizeCertSha256(m[1]);
            if (hex.length === 64) return hex;
        }
    }

    console.warn("[publish-apk] WARN: signing cert SHA-256 not extracted — clients skip signature match");
    return "";
}

function resolveApk(spec, explicit) {
    if (explicit) {
        const p = path.resolve(explicit);
        if (!fs.existsSync(p)) throw new Error(`APK not found: ${p}`);
        return p;
    }
    const found = pickHighestVersionApk(path.join(spec.appRoot, "build", "capacitor", "apk"));
    if (found) return found;
    throw new Error(`No APK found under ${spec.appRoot}/build/capacitor/apk. Build first (npm run build:capacitor).`);
}

function stageLocal({ spec, apkPath, destDir, versionCode, versionName, signatureSha256, dryRun }) {
    const destApk = path.join(destDir, spec.apkName);
    const manifestPath = path.join(destDir, spec.manifestName);
    const size = fs.statSync(apkPath).size;
    const sha256 = sha256File(apkPath);
    const manifest = {
        ok: true,
        sku: spec.sku,
        packageId: spec.packageId,
        versionCode,
        versionName,
        apk: spec.apkName,
        apkUrl: `/releases/android/${spec.apkName}`,
        sha256,
        signatureSha256: signatureSha256 || "",
        size,
        builtAt: new Date().toISOString()
    };

    console.log(`[publish-apk] sku=${manifest.sku} apk=${apkPath}`);
    console.log(`[publish-apk] packageId=${spec.packageId} versionCode=${versionCode} versionName=${versionName}`);
    console.log(`[publish-apk] sha256=${sha256}`);
    console.log(
        `[publish-apk] signatureSha256=${signatureSha256 ? `${signatureSha256.slice(0, 16)}…` : "(none)"}`
    );
    console.log(`[publish-apk] dest=${destDir}`);

    if (dryRun) {
        console.log("[publish-apk] dry-run — skip write");
        console.log(JSON.stringify(manifest, null, 2));
        return { destApk, manifestPath, manifest };
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(apkPath, destApk);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[publish-apk] wrote ${destApk}`);
    console.log(`[publish-apk] wrote ${manifestPath}`);
    return { destApk, manifestPath, manifest };
}

function rsyncRemote(destDir, dryRun) {
    const override = String(process.env.CWSP_ANDROID_RELEASES_REMOTE || "").trim();
    const host = process.env.CWSP_DEPLOY_200_HOST || "192.168.0.200";
    const user = process.env.CWSP_DEPLOY_200_USER || os.userInfo().username || "u2re-dev";
    const remoteDir =
        process.env.CWSP_ANDROID_RELEASES_DIR_REMOTE ||
        "/home/u2re-dev/U2RE.space/apps/CWSP-reborn/runtime/endpoint/.data/releases/android";
    const remoteSpec = override || `${user}@${host}:${remoteDir}`;
    const src = destDir.endsWith(path.sep) ? destDir : `${destDir}${path.sep}`;
    const args = ["-avz", src, remoteSpec];
    console.log(`[publish-apk] $ rsync ${args.join(" ")}`);
    if (dryRun) {
        console.log("[publish-apk] dry-run — skip rsync");
        return;
    }
    const r = spawnSync("rsync", args, { stdio: "inherit" });
    if (r.status !== 0) {
        throw new Error(`rsync failed (status ${r.status})`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    const spec = SKUS[args.sku];
    if (!spec) {
        printHelp();
        throw new Error("sku must be explorer | document | process");
    }

    const apkPath = resolveApk(spec, args.apk);
    const { versionCode, versionName } = resolvePublishVersion({
        apkPath,
        propsPath: path.join(spec.appRoot, "platforms", "android", "version.properties"),
        expectedPackageId: spec.packageId
    });
    const signatureSha256 = extractApkSigningCertSha256(apkPath);
    const destDir = path.resolve(args.dest || process.env.CWS_ANDROID_RELEASES_DIR || TRANSFER_RELEASES);
    stageLocal({
        spec,
        apkPath,
        destDir,
        versionCode,
        versionName,
        signatureSha256,
        dryRun: args.dryRun
    });

    if (args.remote) {
        rsyncRemote(destDir, args.dryRun);
    }

    console.log("[publish-apk] done");
}

try {
    main();
} catch (err) {
    console.error(`[publish-apk] ${err?.message || err}`);
    process.exit(1);
}
