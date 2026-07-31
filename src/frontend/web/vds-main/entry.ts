/*
 * Filename: entry.ts
 * FullPath: apps/CWSP-shell/src/frontend/web/vds-main/entry.ts
 * Change date and time: 07.52.00_31.07.2026
 * Reason for changes: Force environment shell on u2re.space — ignore ?shell=minimal deep links.
 */

/**
 * CWSP-shell VDS hub entry (`runtime/fastify/apps/main` → u2re.space).
 * INVARIANT: full view set + always `environment` shell (not minimal/Capacitor chrome).
 * Sibling apps open via speed-dial links (md.u2re.space / cwsp.u2re.space).
 */

const ENABLED = [
    "viewer",
    "editor",
    "workcenter",
    "explorer",
    "settings",
    "history",
    "home",
    "print",
    "airpad",
    "network"
] as const;

try {
    document.documentElement.dataset.cwspSurface = "vds-main";
    document.documentElement.dataset.cwspEnabledViews = ENABLED.join(",");
    // WHY: stamp preference + URL before index boot so `?shell=minimal` bookmarks cannot win.
    try {
        localStorage.setItem("rs-boot-shell", "environment");
    } catch {
        /* ignore */
    }
    try {
        const u = new URL(globalThis.location.href);
        if (u.searchParams.get("shell") !== "environment") {
            u.searchParams.set("shell", "environment");
            globalThis.history?.replaceState?.(
                globalThis.history.state ?? null,
                "",
                u.pathname + u.search + u.hash
            );
        }
    } catch {
        /* ignore */
    }
} catch {
    /* ignore */
}

const mount = document.getElementById("app");
if (!mount) {
    console.error("[vds-main] #app missing");
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
            console.error("[vds-main] boot failed", error);
            mount.textContent =
                error instanceof Error ? error.message : "Failed to start CWSP-shell";
        });
}
