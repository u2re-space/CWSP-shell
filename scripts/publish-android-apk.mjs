/*
 * Filename: publish-android-apk.mjs
 * FullPath: apps/CWSP-shell/scripts/publish-android-apk.mjs
 * FIND:apk-update
 * Change date and time: 18.05.00_27.08.2026
 * Reason for changes: Stage launcher APK as latest-launcher.json; version from the APK binary.
 *
 * Usage:
 *   node scripts/publish-android-apk.mjs [--apk path] [--dest path] [--remote] [--dry-run]
 *
 * Version SoT: the APK binary (aapt dump). version.properties is a sanity check only.
 * Manifest: latest-launcher.json + cwsp-launcher.apk under the gateway releases dir.
 */

import { createHash, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickHighestVersionApk, resolvePublishVersion } from "./apk-release-version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const VERSION_PROPS = path.join(APP_ROOT, "platforms", "android", "version.properties");
const PACKAGE_ID = "space.u2re.cw";
const APK_NAME = "cwsp-launcher.apk";
const MANIFEST_NAME = "latest-launcher.json";

const TRANSFER_RELEASES = path.resolve(
    APP_ROOT,
    "..",
    "CWSP-transfer",
    "runtime",
    "endpoint",
    ".data",
    "releases",
    "android"
);

function printHelp() {
    console.log(`publish-android-apk (CWSP-shell launcher)

Options:
  --apk <path>     APK to publish (default: newest build/capacitor/apk/*.apk)
  --dest <path>    Local releases dir (default: CWSP-transfer runtime/endpoint/.data/releases/android)
  --remote         Also rsync dest → gateway .200 releases dir
  --dry-run        Print actions only
  --help

Writes ${APK_NAME} + ${MANIFEST_NAME} (packageId ${PACKAGE_ID}).
Does not touch transfer's latest.json / cwsp.apk.
`);
}

function parseArgs(argv) {
    const out = { apk: null, dest: null, remote: false, dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") out.help = true;
        else if (a === "--remote") out.remote = true;
        else if (a === "--dry-run") out.dryRun = true;
        else if (a === "--apk") out.apk = argv[++i];
        else if (a === "--dest") out.dest = argv[++i];
        else if (a.startsWith("--apk=")) out.apk = a.slice("--apk=".length);
        else if (a.startsWith("--dest=")) out.dest = a.slice("--dest=".length);
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

    const list = spawnSync("unzip", ["-Z1", apkPath], { encoding: "utf8" });
    if (list.status !== 0) {
        console.warn("[publish-apk] WARN: could not list APK for signing cert");
        return "";
    }
    const entries = String(list.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^META-INF\/.+\.(RSA|DSA|EC)$/i.test(s));
    for (const entry of entries) {
        const extracted = spawnSync("unzip", ["-p", apkPath, entry], {
            encoding: "buffer",
            maxBuffer: 4 * 1024 * 1024
        });
        if (extracted.status !== 0 || !extracted.stdout?.length) continue;
        try {
            const tmp = path.join(os.tmpdir(), `cwsp-launcher-cert-${Date.now()}.der`);
            fs.writeFileSync(tmp, extracted.stdout);
            const pem = spawnSync(
                "openssl",
                ["pkcs7", "-inform", "DER", "-in", tmp, "-print_certs", "-outform", "PEM"],
                { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
            );
            try {
                fs.unlinkSync(tmp);
            } catch {
                /* ignore */
            }
            if (pem.status === 0 && pem.stdout) {
                const blocks = pem.stdout.split(/-----END CERTIFICATE-----/);
                for (const block of blocks) {
                    if (!block.includes("BEGIN CERTIFICATE")) continue;
                    try {
                        const cert = new X509Certificate(`${block.trim()}\n-----END CERTIFICATE-----\n`);
                        const fp = normalizeCertSha256(cert.fingerprint256);
                        if (fp.length === 64) return fp;
                    } catch {
                        /* try next */
                    }
                }
            }
        } catch (e) {
            console.warn(`[publish-apk] WARN: cert parse failed for ${entry}: ${e?.message || e}`);
        }
    }
    console.warn("[publish-apk] WARN: signing cert SHA-256 not extracted — clients skip signature match");
    return "";
}

function resolveApk(explicit) {
    if (explicit) {
        const p = path.resolve(explicit);
        if (!fs.existsSync(p)) throw new Error(`APK not found: ${p}`);
        return p;
    }
    const found = pickHighestVersionApk(path.join(APP_ROOT, "build", "capacitor", "apk"));
    if (found) return found;
    throw new Error("No APK found. Build first (npm run build:capacitor) or pass --apk.");
}

function stageLocal({ apkPath, destDir, versionCode, versionName, signatureSha256, dryRun }) {
    const destApk = path.join(destDir, APK_NAME);
    const manifestPath = path.join(destDir, MANIFEST_NAME);
    const size = fs.statSync(apkPath).size;
    const sha256 = sha256File(apkPath);
    const manifest = {
        ok: true,
        packageId: PACKAGE_ID,
        versionCode,
        versionName,
        apk: APK_NAME,
        apkUrl: `/releases/android/${APK_NAME}`,
        sha256,
        signatureSha256: signatureSha256 || "",
        size,
        builtAt: new Date().toISOString()
    };

    console.log(`[publish-apk] apk=${apkPath}`);
    console.log(`[publish-apk] packageId=${PACKAGE_ID} versionCode=${versionCode} versionName=${versionName}`);
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

    const apkPath = resolveApk(args.apk);
    const { versionCode, versionName } = resolvePublishVersion({
        apkPath,
        propsPath: VERSION_PROPS,
        expectedPackageId: PACKAGE_ID
    });
    const signatureSha256 = extractApkSigningCertSha256(apkPath);
    const destDir = path.resolve(args.dest || process.env.CWS_ANDROID_RELEASES_DIR || TRANSFER_RELEASES);
    stageLocal({
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
