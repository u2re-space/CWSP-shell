/*
 * Filename: entry.ts
 * FullPath: apps/CWSP-shell/src/frontend/web/cw-markdown/entry.ts
 * Change date and time: 22.20.00_19.07.2026
 * Reason for changes: VDS md.u2re.space / /markdown/ SPA — viewer + workcenter shell.
 */

/**
 * CWSP-shell Markdown host entry (Fastify apps/cw-markdown).
 * INVARIANT: history base auto-detects `/markdown` on IP mounts; md.u2re.space stays `/`.
 */

const ENABLED = ["viewer", "workcenter", "editor", "settings", "history", "home", "print"] as const;

try {
    document.documentElement.dataset.cwspSurface = "cw-markdown";
    document.documentElement.dataset.cwspEnabledViews = ENABLED.join(",");
    // WHY: keep PWA ingress — this host ships sw.js from the markdown SPA build.
    const m = String(location.pathname || "").match(/^(\/markdown)(?:\/|$)/i);
    if (m) document.documentElement.dataset.cwspRouterBase = m[1].toLowerCase();
} catch {
    /* ignore */
}

const mount = document.getElementById("app");
if (!mount) {
    console.error("[cw-markdown] #app missing");
} else {
    void import("../../../index.ts")
        .then(async (mod) => {
            const run = mod?.default;
            if (typeof run !== "function") {
                throw new Error("CWSP-shell default export is not a boot function");
            }
            await run(mount);
        })
        .catch((error: unknown) => {
            console.error("[cw-markdown] boot failed", error);
            mount.textContent =
                error instanceof Error ? error.message : "Failed to start CWSP-shell Markdown";
        });
}
