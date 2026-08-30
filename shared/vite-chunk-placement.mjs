import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

/**
 * Rollup chunk → dist/ layout for hot-swappable deploy slices:
 * dist/views, dist/shells, dist/fest, dist/pwa, dist/core/*, dist/com/*, dist/workers/*, dist/vendor, dist/assets.
 * FIND:fest-shared — after stage, isolated `fest/*` hoists to runtime/fastify/apps/_shared/fest.
 *
 * `src/core`, `src/com`, `fest/lure` (lur.e), and `fest/fl-ui` (fl.ui) are co-located into `com/app.js`
 * to avoid cross-chunk circular init ordering (TDZ: e.g. `makeUIState` / `observe`, fl-ui ↔ lure).
 * `style.ts` stays isolated as `fest/style-lib.js` (library-mode + hoist).
 * Rollup may still warn about circular chunks between slices; the build completes.
 */

/** Merged into consumers / dynamic-only; avoids empty vendor chunks */
const VENDOR_SKIP = new Set([
    "png",
    "jpeg",
    "cbor-x",
    "docx",
    "ico",
    "turndown",
    "temml",
    "mathml-to-latex",
]);

/** modules/projects folder → fest import short name (dist/fest/<name>.js) */
const FEST_DIR_TO_IMPORT = {
    "core.ts": "core",
    "dom.ts": "dom",
    "object.ts": "object",
    "style.ts": "style-lib",
    "veela.css": "veela",
    "lur.e": "lure",
    "icon.ts": "icon",
    "fl.ui": "fl-ui",
    "uniform.ts": "uniform",
};

const FEST_MERGED_INTO_COM_APP = new Set(["lure", "fl-ui"]);
const CORE_STATIC_LURE_MARKERS = [
    "/src/core/index.ts",
    "/src/core/storage/FileOps.ts",
    "/src/core/utils/Actions.ts",
    "/src/core/storage/StateStorage.ts",
    "/src/core/document/Parser.ts",
    "/src/core/document/markdown.ts",
    "/src/core/document/index.ts",
];
const COM_SERVICE_CORE_PREFIXES = [
    "/src/core/constants/data-paths",
    "/src/core/storage/WriteFileSmart-v2",
    "/src/core/storage/FileSystem",
    "/src/core/storage/OPFSMod",
    "/src/core/document/AIResponseParser",
    "/src/core/utils/Runtime",
];
const comCoreUiMirrored = (base) => [`/src/com/core/${base}.`, `/src/frontend/shared/core/${base}.`];
const COM_CORE_UI_ONLY = [
    ...comCoreUiMirrored("UnifiedMessaging"),
    ...comCoreUiMirrored("ViewTransferRouting"),
    ...comCoreUiMirrored("AppCommunicator"),
    ...comCoreUiMirrored("LogSanitizer"),
    ...comCoreUiMirrored("ServiceChannels"),
    ...comCoreUiMirrored("UniformChannelManager"),
    ...comCoreUiMirrored("MessageQueue"),
];

const norm = (id) => String(id).split("\\").join("/");

const stripExt = (p) => p.replace(/\.[cm]?[tj]sx?$/i, "");

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rolldown (Vite 8) does not reliably honor `manualChunks` for chunk isolation.
 * These groups mirror the existing `manualChunks()` intent for Rolldown builds so
 * output stays structured. `lure` and `fl-ui` intentionally remain merged into
 * `com/app.js` to avoid circular-init / TDZ regressions.
 */
export const rolldownCodeSplittingGroups = [
    {
        name: "vite-preload",
        test: /vite\/modulepreload-polyfill|vite\/preload-helper/,
        priority: 200,
    },
    {
        name: "fest-polyfill",
        test: /\/shared\/fest\/polyfill\//,
        priority: 100,
    },
    {
        name: "fest-object",
        test: /\/modules\/projects\/object\.ts\/|\/shared\/fest\/object\/|\/object\.ts\/src\//,
        priority: 120,
    },
    ...Object.entries(FEST_DIR_TO_IMPORT)
        .filter(([, key]) => key !== "object" && !FEST_MERGED_INTO_COM_APP.has(key))
        .map(([dir, key]) => ({
            name: `fest-${key}`,
            test: new RegExp(
                `\\/modules\\/projects\\/${escapeRegExp(dir)}\\/|\\/shared\\/fest\\/${escapeRegExp(key)}\\/`,
            ),
            priority: 105,
        })),
];

/** Core and com must stay together for stable init order. */
const CORE_CHUNK_NAME = "com-app";

/**
 * @param {string} rel - path under src/core/ or src/com/ (no leading slash)
 * @param {"core"|"com"} ns
 */
function appSliceChunk(ns, rel) {
    const parts = stripExt(rel).split("/").filter(Boolean);
    if (!parts.length) return undefined;
    if (ns === "core") return CORE_CHUNK_NAME;
    if (parts.length === 1) return `${ns}-main`;
    return `${ns}-${parts[0]}`;
}

/**
 * @param {string} id
 * @returns {string | undefined}
 */
export function manualChunks(id) {
    const p = norm(id);

    // WHY: Vite 8 hoisted `__vitePreload` (export `Un`) into unhashed `com/app.js`.
    // A stale barrel then makes `__vitePreload(...).catch` throw (GLitElementImpl, etc.).
    if (p.includes("vite/modulepreload-polyfill") || p.includes("vite/preload-helper") || p.includes("\0vite/")) {
        return "vite-preload";
    }

    // `fest/object` — must stay out of `com-app` (lure/fl-ui/DOM). Realpath is
    // `.../modules/projects/object.ts/src/...`; if this is assigned to `com-app`, `com-service`
    // (MV3 SW) imports `observe`/`iterated` from `./app.js` and executes DOM/customElements.
    if (p.includes("/modules/projects/object.ts/") || p.includes("/object.ts/src/")) {
        return "fest-object";
    }

    if (p.includes("node_modules")) {
        const tail = p.split("node_modules/").pop() || "";
        const parts = tail.split("/");
        const scope = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
        const skipKey = parts[0]?.startsWith("@") ? parts[1] : parts[0];
        if (!scope || VENDOR_SKIP.has(skipKey)) return undefined;
        const safe = scope.replace(/[^a-zA-Z0-9._@-]/g, "_");
        return `vendor-${safe}`;
    }

    if (p.includes("/src/pwa/")) {
        const rel = p.split("/src/pwa/")[1];
        if (rel) return `pwa-${stripExt(rel).split("/").join("-")}`;
    }

    // Most of `src/core/*` defaults to `com-service` (see block below); lure-heavy files stay in `com-app`.
    // Clipboard + image helpers are required by the CRX MV3 service worker — keep them out of `com/app.js`
    // so the background script does not load DOM/customElements.
    if (p.includes("/src/core/modules/Clipboard")) return "core-clipboard";
    if (p.includes("/src/core/workers/ImageProcess")) return "core-imageprocess";

    // `src/frontend/shared/config/*` is often hardlinked to `src/com/config/*` but bundlers can
    // still emit a second graph path; keep both in `com-service` for the CRX SW.
    if (p.includes("/src/frontend/shared/config/")) return "com-service";

    // Shared settings + OPFS helpers used by the MV3 service worker — keep out of `com-app` (lure/fl-ui/DOM merge).
    for (const prefix of COM_SERVICE_CORE_PREFIXES) {
        if (p.includes(prefix)) return "com-service";
    }
    if (p.includes("/src/core/time/")) return "com-service";

    // `modules/projects/object.ts/src/core/*` also contains the substring `/src/core/` but is **fest/object**
    // (reactivity). Never treat it as CWSP-shell `src/core/`.
    //
    // **CRX MV3**: Do not assign most of `src/core/*` to `com-app`. The service worker imports `com/service.js`;
    // if that chunk static-imports `com/app.js` (lure/customElements), registration fails. Default CWSP-shell
    // `src/core/` → `com-service`; only files that statically depend on `fest/lure` (same TDZ island as lur.e)
    // stay in `com-app`.
    if (p.includes("/src/core/") && !p.includes("/object.ts/src/core/")) {
        for (const mark of CORE_STATIC_LURE_MARKERS) {
            if (p.includes(mark)) return CORE_CHUNK_NAME;
        }
        return "com-service";
    }
    // AI / shared service layer: isolate from `com-app` (which merges fest lure + fl-ui for UI TDZ).
    // Otherwise the MV3 service worker loads `com/app.js` and executes DOM-only code (customElements, etc.).
    if (p.includes("/src/frontend/shared/service/")) return "com-service";
    if (p.includes("/src/com/service/")) return "com-service";
    // UI-heavy `com/core` modules mirrored under `frontend/shared/core` must land in `com-app`, not `com-service`.
    // This block MUST run before the blanket `frontend/shared/core` → `com-service` rule below.
    // Use `/${base}.` so `UnifiedMessaging` does not match `UnifiedMessagingSw.ts` (prefix collision).
    for (const mark of COM_CORE_UI_ONLY) {
        if (p.includes(mark)) return CORE_CHUNK_NAME;
    }
    if (p.includes("/src/frontend/shared/core/")) return "com-service";
    if (p.includes("/src/com/core/")) return "com-service";
    if (p.includes("/src/com/config/")) return "com-service";
    if (p.includes("/src/com/store/IDBQueue")) return "com-service";
    if (p.includes("/src/com/template/")) return "com-service";
    if (p.includes("/src/com/")) return "com-app";

    const shellSub = p.match(/\/frontend\/shells\/(minimal|immersive|faint)\//);
    if (shellSub) return `shell-${shellSub[1]}`;

    if (p.includes("/frontend/shells/")) {
        const rel = p.split("/frontend/shells/")[1];
        if (rel) return `shell-${stripExt(rel).split("/").join("-")}`;
    }

    const viewMatch = p.match(/\/frontend\/views\/([^/]+)\//);
    if (viewMatch) {
        const vid = viewMatch[1];
        if (vid === "scss") return undefined;
        return `view-${vid}`;
    }

    const sharedFest = p.match(/\/shared\/fest\/([^/]+)\//);
    if (sharedFest) {
        if (sharedFest[1] === "lure") return "com-app";
        if (sharedFest[1] === "fl-ui") return "com-app";
        return `fest-${sharedFest[1]}`;
    }

    const proj = p.match(/\/modules\/projects\/([^/]+)\//);
    if (proj) {
        const dir = proj[1];
        if (dir === "lur.e") return "com-app";
        if (dir === "fl.ui") return "com-app";
        const key = FEST_DIR_TO_IMPORT[dir];
        if (key) return `fest-${key}`;
    }

    return undefined;
}

export function chunkFileNames(chunkInfo) {
    const n = chunkInfo.name || "chunk";

    if (n === "vite-preload" || n.startsWith("vite-")) return `chunks/${n}-[hash].js`;
    if (n.startsWith("vendor-")) return `vendor/${n.slice("vendor-".length)}.js`;
    if (n.startsWith("fest-")) return `fest/${n.slice(5)}.js`;
    if (n.startsWith("view-")) return `views/${n.slice(5)}.js`;
    if (n.startsWith("shell-")) return `shells/${n.slice(6)}.js`;
    if (n.startsWith("pwa-")) return `pwa/${n.slice(4)}.js`;
    if (n.startsWith("core-")) return `core/${n.slice(5)}.js`;
    if (n.startsWith("com-")) return `com/${n.slice(4)}.js`;

    const ids = chunkInfo.moduleIds;
    if (ids) {
        for (const id of ids) {
            const tagged = manualChunks(id);
            if (tagged && tagged !== n) {
                return chunkFileNames({ ...chunkInfo, name: tagged });
            }
        }
    }

    return `chunks/${n.replace(/[^a-zA-Z0-9._-]/g, "_")}.js`;
}

function walkFilesSync(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walkFilesSync(p, out);
        else out.push(p);
    }
    return out;
}

/**
 * Vite worker emits often ignore `assetFileNames` heuristics; move OPFS worker to `workers/opfs/`.
 * Rolldown (Vite 8+) does not support mutating `bundle` in `generateBundle`; use `writeBundle` + rewrites.
 * @returns {import("vite").Plugin}
 */
export function relocateWorkerBundleAssetsPlugin() {
    return {
        name: "relocate-worker-bundle-assets",
        apply: "build",
        enforce: "post",
        writeBundle(outputOptions, bundle) {
            const outDir = outputOptions.dir;
            if (!outDir) return;

            /** @type {{ from: string; to: string }[]} */
            const moves = [];
            for (const key of Object.keys(bundle)) {
                const item = bundle[key];
                if (!item || (item.type !== "asset" && item.type !== "chunk")) continue;
                const fn = item.fileName || key;
                if (!/OPFS\.uniform\.worker/i.test(fn)) continue;
                const baseRaw = fn.split("/").pop() || "";
                const base = baseRaw.replace(
                    /(OPFS\.uniform\.worker)-[a-zA-Z0-9_-]+(\.m?js)$/i,
                    "$1$2",
                );
                const next = `workers/opfs/${base}`;
                if (fn === next) continue;
                moves.push({ from: fn, to: next });
            }
            if (!moves.length) return;

            moves.sort((a, b) => b.from.length - a.from.length);

            for (const { from, to } of moves) {
                const fromAbs = resolve(outDir, from);
                const toAbs = resolve(outDir, to);
                if (!existsSync(fromAbs)) continue;
                mkdirSync(dirname(toAbs), { recursive: true });
                renameSync(fromAbs, toAbs);
            }

            const textExts = new Set([".js", ".mjs", ".html", ".json", ".css", ".map", ".txt", ".ts"]);
            for (const abs of walkFilesSync(outDir)) {
                const ext = extname(abs).toLowerCase();
                if (!textExts.has(ext)) continue;
                let text = readFileSync(abs, "utf8");
                let changed = false;
                for (const { from, to } of moves) {
                    if (!text.includes(from)) continue;
                    text = text.split(from).join(to);
                    changed = true;
                }
                if (changed) writeFileSync(abs, text);
            }
        },
    };
}

/**
 * @param {string} NAME — app slug for the main emitted CSS file
 */
const PRELOAD_SHIM =
    "const __vitePreload = (baseModule) => Promise.resolve().then(() => baseModule());\n";

/** FIND:vite-preload Rolldown binds `__vitePreload` to a letter on unhashed barrels. */
const stripPreloadFromAppImports = (text) => {
    let changed = false;
    const next = text.replace(
        /import\s*\{([^}]*)\}\s*from\s*(["'][^"']+["'])\s*;?/g,
        (full, spec, from) => {
            if (!/\b__vitePreload\b/.test(spec)) return full;
            changed = true;
            const cleaned = String(spec)
                .replace(/(?:,\s*)?[\w$]+\s+as\s+__vitePreload\b/g, "")
                .replace(/(?:,\s*)?\b__vitePreload\b/g, "")
                .replace(/,\s*,/g, ",")
                .replace(/^\s*,\s*/, "")
                .replace(/,\s*$/, "")
                .trim();
            if (!cleaned) return "";
            return `import { ${cleaned} } from ${from};`;
        },
    );
    let out = changed ? next : text;
    if (/\b__vitePreload\s*\(/.test(out) && !/const\s+__vitePreload\s*=/.test(out)) {
        out = PRELOAD_SHIM + out;
        changed = true;
    }
    return changed ? out : text;
};

export function rewriteVitePreloadBinding(outDir) {
    if (!outDir || !existsSync(outDir)) return 0;
    let n = 0;
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            let st;
            try {
                st = statSync(abs);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (name === "node_modules" || name === ".git") continue;
                walk(abs);
                continue;
            }
            if (!/\.m?js$/.test(name)) continue;
            const posix = abs.split("\\").join("/");
            if (name === "app.js" && /\/com\/app\.js$/.test(posix)) continue;
            let text;
            try {
                text = readFileSync(abs, "utf8");
            } catch {
                continue;
            }
            if (!text.includes("__vitePreload")) continue;
            const next = stripPreloadFromAppImports(text);
            if (next === text) continue;
            writeFileSync(abs, next);
            n += 1;
        }
    };
    walk(outDir);
    return n;
}

export function rewriteVitePreloadPlugin() {
    let outDir = "";
    return {
        name: "cwsp-rewrite-vite-preload",
        apply: "build",
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir || "dist");
        },
        closeBundle() {
            const n = rewriteVitePreloadBinding(outDir);
            if (n) console.log(`[vite-preload] rewrote ${n} hashed entr${n === 1 ? "y" : "ies"}`);
        },
    };
}

/**
 * @param {string} NAME — app slug for the main emitted CSS file
 */
export function assetFileNames(NAME) {
    return (assetInfo) => {
        const ext = (assetInfo.name || "").split(".").pop()?.toLowerCase() || "";
        if (ext === "css") return `assets/${NAME}[extname]`;
        return "assets/[name][extname]";
    };
}
