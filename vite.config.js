/*
 * Filename: vite.config.js
 * FullPath: apps/CWSP-shell/vite.config.js
 * Change date and time: 12.00.00_08.08.2026
 * Reason for changes: Copy default wallpaper.jpg/stock.jpg into host SPA outDir/assets.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadEnv } from "vite";

import { assetFileNames as distAssetFileNames, chunkFileNames as distChunkFileNames } from "./shared/vite-chunk-placement.mjs";

const importConfig = (url, ...args) => {
    return import(url)?.then?.((m) => m?.default?.(...args));
};

export const NAME = "crossword";
export const __dirname = resolve(import.meta.dirname, "./");

const baseConfig = await importConfig(
    resolve(__dirname, "./shared/vite.config.js"),
    NAME,
    JSON.parse(await readFile(resolve(__dirname, "./tsconfig.json"), { encoding: "utf8" })),
    __dirname
);

const ALL_VIEW_IDS = ["viewer", "editor", "workcenter", "explorer", "settings", "history", "home", "print", "airpad", "network"];
const DEFAULT_VIEWS_BY_MODE = {
    // VDS md.u2re.space / /markdown/ — markdown workspace (viewer + workcenter tools).
    markdown: ["viewer", "workcenter", "editor", "settings", "history", "home", "print"],
    "cw-markdown": ["viewer", "workcenter", "editor", "settings", "history", "home", "print"],
    // VDS u2re.space main hub — full CWSP-shell environment.
    "vds-main": [...ALL_VIEW_IDS],
    shell: [...ALL_VIEW_IDS],
    default: ALL_VIEW_IDS,
};

const parseViewsFromEnv = (rawValue) => {
    if (!rawValue || typeof rawValue !== "string") return null;
    const normalized = rawValue.trim().toLowerCase();
    if (!normalized || normalized === "all" || normalized === "*") {
        return [...ALL_VIEW_IDS];
    }

    const parsed = normalized
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    if (!parsed.length) return null;
    const uniqueKnownViews = [...new Set(parsed)].filter((view) => ALL_VIEW_IDS.includes(view));
    return uniqueKnownViews.length ? uniqueKnownViews : null;
};

const resolveEnabledViews = (mode, env) => {
    const defaults =
        mode === "markdown" || mode === "cw-markdown"
            ? DEFAULT_VIEWS_BY_MODE.markdown
            : mode === "vds-main" || mode === "shell"
              ? DEFAULT_VIEWS_BY_MODE["vds-main"]
              : DEFAULT_VIEWS_BY_MODE.default;
    const explicit = parseViewsFromEnv(env?.VITE_ENABLED_VIEWS);
    const disabled = parseViewsFromEnv(env?.VITE_DISABLED_VIEWS);
    const start = explicit ?? defaults;

    if (!disabled?.length) {
        return [...start];
    }

    const disabledSet = new Set(disabled);
    const filtered = start.filter((view) => !disabledSet.has(view));
    return filtered.length ? filtered : ["viewer"];
};

const toViewDefineEntries = (enabledViews) => {
    const enabledSet = new Set(enabledViews);
    return ALL_VIEW_IDS.reduce((acc, viewId) => {
        const key = `__RS_VIEW_${viewId.toUpperCase()}__`;
        acc[key] = enabledSet.has(viewId);
        return acc;
    }, {});
};

const createViewDefine = (mode) => {
    const env = loadEnv(mode || "production", __dirname, "");
    const enabledViews = resolveEnabledViews(mode, env);
    // WHY: VDS hub boots into environment Home / Speed Dial, not Markdown viewer.
    const preferredDefault =
        mode === "vds-main" || mode === "shell"
            ? "home"
            : mode === "markdown" || mode === "cw-markdown"
              ? "viewer"
              : "home";
    const defaultView = enabledViews.includes(preferredDefault)
        ? preferredDefault
        : enabledViews.includes("viewer")
          ? "viewer"
          : enabledViews[0] || "viewer";
    return {
        ...toViewDefineEntries(enabledViews),
        __RS_DEFAULT_VIEW__: JSON.stringify(defaultView),
    };
};

const isPwaPlugin = (plugin) => {
    const name = plugin?.name;
    return typeof name === "string" && (name === "vite-plugin-pwa" || name.startsWith("vite-plugin-pwa:"));
};
const isStaticCopyPlugin = (plugin) => {
    const name = plugin?.name;
    return typeof name === "string" && name.startsWith("vite-plugin-static-copy:");
};
const isMcpPlugin = (plugin) => {
    const name = plugin?.name;
    return typeof name === "string" && name.toLowerCase().includes("mcp");
};

/**
 * Shared SPA builder for Fastify host apps (index.html + base "./").
 * Endpoint lib build stays the default `build:pwa` path.
 */
const createHostSpaConfig = async ({ mode, outDir, platformRoot, cacheDir, enabledViews }) => {
    const { viteStaticCopy } = await import("vite-plugin-static-copy");
    const { VitePWA } = await import("vite-plugin-pwa");

    const basePlugins =
        (baseConfig?.plugins || [])
            .flat?.(Infinity)
            ?.filter?.(
                (plugin) =>
                    plugin?.name !== "vite:singlefile" &&
                    !isPwaPlugin(plugin) &&
                    !isStaticCopyPlugin(plugin) &&
                    !isMcpPlugin(plugin)
            ) ?? [];

    const baseRollup = baseConfig?.build?.rollupOptions ?? {};
    const baseOutput = Array.isArray(baseRollup.output) ? baseRollup.output[0] : (baseRollup.output ?? {});

    return {
        ...baseConfig,
        // WHY: root at HTML dir so emitted file is `index.html` (not nested src/.../index.html).
        root: platformRoot,
        base: "./",
        cacheDir,
        define: {
            ...(baseConfig?.define ?? {}),
            ...createViewDefine(mode),
            "import.meta.env.VITE_ENABLED_VIEWS": JSON.stringify(enabledViews.join(",")),
        },
        plugins: [
            ...basePlugins,
            /*
             * WHY: Vite `root` is nested (`src/frontend/web/vds-main`). Static-copy resolves
             * src outside root as `../../../pwa/icons/…`, then strips leading `../` and joins
             * that onto `dest` → `pwa/icons/pwa/icons/*` (manifest icons 404 → blank PWA icon).
             * INVARIANT: `dest` must be `outDir` so dirClean `pwa/icons` lands at outDir/pwa/icons.
             */
            viteStaticCopy({
                targets: [
                    { src: resolve(__dirname, "./src/pwa/manifest.json"), dest: outDir },
                    { src: resolve(__dirname, "./src/pwa/icons/*"), dest: outDir },
                    { src: resolve(__dirname, "./src/pwa/screenshots/*"), dest: outDir },
                    // WHY: default wallpaper URL `/assets/wallpaper.jpg` (not under nested Vite root).
                    { src: resolve(__dirname, "./assets/wallpaper.jpg"), dest: resolve(outDir, "assets") },
                    { src: resolve(__dirname, "./assets/stock.jpg"), dest: resolve(outDir, "assets") },
                ],
            }),
            VitePWA({
                srcDir: resolve(__dirname, "./src/pwa"),
                filename: "sw.ts",
                outDir,
                registerType: "autoUpdate",
                strategies: "injectManifest",
                injectRegister: null,
                selfDestroying: false,
                injectManifest: {
                    rollupFormat: "iife",
                    injectionPoint: "self.__WB_MANIFEST",
                    maximumFileSizeToCacheInBytes: 1024 * 1024 * 16,
                    globPatterns: ["**/*.{js,css,html,png,svg,json,jpg,jpeg,webp}"],
                    globIgnores: ["**/node_modules/**/*", "**/*.map", "**/stats.html", "**/report.html"],
                },
                manifest: false,
                devOptions: { enabled: false },
            }),
        ],
        build: {
            ...(baseConfig?.build ?? {}),
            // CRITICAL: endpoint lib mode must not apply — Fastify apps need index.html SPA.
            lib: false,
            outDir,
            emptyOutDir: true,
            minify: false,
            cssMinify: false,
            terserOptions: undefined,
            cssCodeSplit: false,
            modulePreload: true,
            rollupOptions: {
                ...baseRollup,
                input: resolve(platformRoot, "index.html"),
                output: {
                    ...baseOutput,
                    dir: outDir,
                    entryFileNames: "assets/[name]-[hash].js",
                    chunkFileNames: distChunkFileNames,
                    assetFileNames: distAssetFileNames(NAME),
                },
            },
            rolldownOptions: {
                ...(baseConfig?.build?.rolldownOptions ?? {}),
                input: resolve(platformRoot, "index.html"),
                output: {
                    ...baseOutput,
                    dir: outDir,
                    entryFileNames: "assets/[name]-[hash].js",
                    chunkFileNames: distChunkFileNames,
                    assetFileNames: distAssetFileNames(NAME),
                },
            },
        },
    };
};

/** CWSP Launcher Capacitor WebView bundle (system HOME SKU). */
const LAUNCHER_ENABLED_VIEWS = ["minimal", "home", "explorer", "settings", "viewer"];

const createCapacitorLauncherConfig = async (mode) => {
    const platformRoot = resolve(__dirname, "./src/frontend/web/capacitor-launcher");
    const outDir = resolve(__dirname, "./build/capacitor/web");
    const workspaceRoot = resolve(__dirname, "../..");
    const flUiRoot = resolve(workspaceRoot, "modules/projects/fl.ui/src/ui");
    const homeViewRoot = resolve(workspaceRoot, "modules/views/home-view/src");
    const launcherResolveAliases = [
        {
            find: resolve(__dirname, "src/routing/native/launcher-bridge.ts"),
            replacement: resolve(__dirname, "src/routing/native/launcher-bridge.ts")
        },
        {
            find: resolve(__dirname, "src/routing/native/launcher-home-lifecycle.ts"),
            replacement: resolve(__dirname, "src/routing/native/launcher-home-lifecycle.ts")
        },
        {
            find: "com/routing/native/launcher-bridge",
            replacement: resolve(__dirname, "src/routing/native/launcher-bridge.ts")
        },
        {
            find: "com/routing/native/launcher-home-lifecycle",
            replacement: resolve(__dirname, "src/routing/native/launcher-home-lifecycle.ts")
        },
        {
            find: resolve(__dirname, "src/frontend/shells/environment/components/app-menu/AppMenu.ts"),
            replacement: resolve(flUiRoot, "navigation/app-menu/AppMenu.ts")
        },
        {
            find: resolve(homeViewRoot, "navigation/app-menu/AppMenu"),
            replacement: resolve(flUiRoot, "navigation/app-menu/AppMenu.ts")
        },
        {
            find: resolve(homeViewRoot, "navigation/app-menu/AppMenu.ts"),
            replacement: resolve(flUiRoot, "navigation/app-menu/AppMenu.ts")
        },
        {
            find: /^fl-design\/(.*)$/,
            replacement: `${resolve(workspaceRoot, "modules/projects/fl.ui/src/styles")}/$1`
        },
        { find: "fl-ui", replacement: flUiRoot },
        { find: "@fl-ui", replacement: flUiRoot },
        {
            find: "@fest-lib/fl-ui",
            replacement: resolve(workspaceRoot, "modules/projects/fl.ui/src/index.ts")
        }
    ];
    const basePlugins =
        (baseConfig?.plugins || [])
            .flat?.(Infinity)
            ?.filter?.(
                (plugin) =>
                    plugin?.name !== "vite:singlefile" &&
                    !isPwaPlugin(plugin) &&
                    !isStaticCopyPlugin(plugin) &&
                    !isMcpPlugin(plugin)
            ) ?? [];
    const baseRollup = baseConfig?.build?.rollupOptions ?? {};
    const baseOutput = Array.isArray(baseRollup.output) ? baseRollup.output[0] : (baseRollup.output ?? {});

    return {
        ...baseConfig,
        root: platformRoot,
        base: "./",
        cacheDir: resolve(__dirname, "node_modules/.vite-capacitor-launcher"),
        define: {
            ...(baseConfig?.define ?? {}),
            __RS_SHELL_ROLE__: JSON.stringify("launcher"),
            "import.meta.env.RS_SHELL_ROLE": JSON.stringify("launcher"),
            __RS_DEFAULT_VIEW__: JSON.stringify("home"),
            __RS_VIEW_HOME__: "true",
            __RS_VIEW_EXPLORER__: "true",
            __RS_VIEW_SETTINGS__: "true",
            __RS_VIEW_VIEWER__: "true",
            __RS_VIEW_NETWORK__: "false",
            __RS_VIEW_AIRPAD__: "false",
            __RS_VIEW_EDITOR__: "false",
            __RS_VIEW_WORKCENTER__: "false",
            __RS_VIEW_HISTORY__: "false",
            __RS_VIEW_PRINT__: "false",
            "import.meta.env.VITE_ENABLED_VIEWS": JSON.stringify(LAUNCHER_ENABLED_VIEWS.join(",")),
        },
        plugins: basePlugins,
        resolve: {
            ...(baseConfig?.resolve ?? {}),
            alias: [
                ...(Array.isArray(baseConfig?.resolve?.alias) ? baseConfig.resolve.alias : []),
                ...launcherResolveAliases
            ]
        },
        build: {
            ...(baseConfig?.build ?? {}),
            lib: false,
            outDir,
            emptyOutDir: true,
            minify: false,
            cssMinify: false,
            modulePreload: true,
            rollupOptions: {
                ...baseRollup,
                input: resolve(platformRoot, "index.html"),
                output: {
                    ...baseOutput,
                    dir: outDir,
                    entryFileNames: "assets/[name]-[hash].js",
                    chunkFileNames: distChunkFileNames,
                    assetFileNames: distAssetFileNames(NAME),
                },
            },
            rolldownOptions: {
                ...(baseConfig?.build?.rolldownOptions ?? {}),
                input: resolve(platformRoot, "index.html"),
                output: {
                    ...baseOutput,
                    dir: outDir,
                    entryFileNames: "assets/[name]-[hash].js",
                    chunkFileNames: distChunkFileNames,
                    assetFileNames: distAssetFileNames(NAME),
                },
            },
        },
    };
};

/** VDS host SPA for md.u2re.space and LAN `/markdown/`. */
const createMarkdownSpaConfig = async (mode) =>
    createHostSpaConfig({
        mode,
        outDir: resolve(__dirname, "./build/cw-markdown"),
        platformRoot: resolve(__dirname, "./src/frontend/web/cw-markdown"),
        cacheDir: resolve(__dirname, "node_modules/.vite-cw-markdown"),
        enabledViews: DEFAULT_VIEWS_BY_MODE.markdown,
    });

/** VDS host SPA for u2re.space main (replaces runtime/main promo hub). */
const createVdsMainSpaConfig = async (mode) =>
    createHostSpaConfig({
        mode,
        outDir: resolve(__dirname, "./build/vds-main"),
        platformRoot: resolve(__dirname, "./src/frontend/web/vds-main"),
        cacheDir: resolve(__dirname, "node_modules/.vite-vds-main"),
        enabledViews: DEFAULT_VIEWS_BY_MODE["vds-main"],
    });

export default async ({ mode } = {}) => {
    // WHY: CRX builds moved exclusively to apps/CWSP-crx — refuse leftover --mode crx.
    if (mode === "crx") {
        throw new Error(
            "[CWSP-shell] CRX builds live in apps/CWSP-crx (npm run build:crx). This package is PWA/markdown only."
        );
    }
    if (mode === "markdown" || mode === "cw-markdown") {
        return createMarkdownSpaConfig(mode);
    }
    if (mode === "vds-main" || mode === "shell") {
        return createVdsMainSpaConfig(mode);
    }
    if (mode === "capacitor-launcher") {
        return createCapacitorLauncherConfig(mode);
    }

    const config = {
        ...baseConfig,
        define: {
            ...(baseConfig?.define ?? {}),
            ...createViewDefine(mode),
        },
        build: {
            ...baseConfig.build,
            // Keep PWA/regular build symbols stable (Fastify runtime print route issue).
            minify: false,
            cssMinify: false,
            terserOptions: undefined,
            // NOTE: Fastify imports `/apps/cw/index.js` directly; keep library-style JS output
            // but override the emitted filename from `crossword.js` to `index.js`.
            lib: {
                ...(baseConfig.build?.lib ?? {}),
                entry: resolve(__dirname, "./src/index.ts"),
                fileName: "index",
            },
            rollupOptions: {
                ...baseConfig.build?.rollupOptions,
                input: {
                    index: resolve(__dirname, "./src/index.ts"),
                },
                output: baseConfig.build?.rollupOptions?.output,
            },
        },
    };

    return config;
};
