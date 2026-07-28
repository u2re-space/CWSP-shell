/*
 * Filename: main.ts
 * FullPath: apps/CWSP-shell/src/crx/settings/main.ts
 * Change date and time: 20.50.00_20.07.2026
 * Reason for changes: Force CRX client id ≠ CWSP shell.clientId on load/save.
 *   On Control 401 during Save — open pairing modal (same as SPA re-auth).
 */

import { crxFrontend } from "shells/boot";
import { registerSettingsContribution } from "com/config/SettingsContributions";
import {
    settingsCheckboxField,
    settingsHint,
    settingsPanel,
    settingsSelectField,
    settingsTextField,
    type SettingsPanelChild
} from "com/config/settings/settings-contribution-ui";
import {
    CRX_BACKEND_CLIENT_ID_DEFAULT,
    CRX_WIRE_CLIENT_ID,
    reconcileCrxWireAndBackendIds,
    registerCrxNeutralinoSettingsSync
} from "./neutralino-settings-arm";

/** Default desk Neutralino CWSP hub for L-110-crx wire (Extension tab only). */
export const CRX_LOCAL_HUB_URL = "https://127.0.0.1:8434/";

const isLoopbackHubUrl = (raw: string): boolean => {
    try {
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        const host = u.hostname.toLowerCase();
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
        return /^(https?:\/\/)?(127\.0\.0\.1|localhost|::1)(:|\/|$)/i.test(String(raw || "").trim());
    }
};

/**
 * Extension tab — CRX-only CWSP identity + chrome prefs.
 * WHY: CWSP Relay (`core.endpointUrl`) is Neutralino/gateway SoT;
 * Extension Local hub (`shell.localHubUrl`) is the Chrome wire target — never the same field.
 */
registerSettingsContribution({
    id: "crx",
    label: "Extension",
    order: 80,
    surfaces: ["crx"],
    render: () => {
        const children: SettingsPanelChild[] = [
            settingsHint(
                `Chrome wire peer for this extension (${CRX_WIRE_CLIENT_ID}). Desk Neutralino / backend client id is edited under CWSP (shell.clientId → /service/config, including PNA). Do not set this field to bare L-110.`
            ),
            "CWSP identity",
            settingsTextField("CRX client id", "core.userId", CRX_WIRE_CLIENT_ID),
            settingsTextField("Socket self id", "core.socket.selfId", CRX_WIRE_CLIENT_ID),
            settingsTextField(
                "Local hub URL (Neutralino / desk backend)",
                "shell.localHubUrl",
                CRX_LOCAL_HUB_URL
            ),
            settingsHint(
                "WebSocket hub for this extension only (L-110-crx). Default https://127.0.0.1:8434/. Independent from CWSP → Relay / gateway (Neutralino portable). Non-loopback hubs still use the CWSP ecosystem token for auth."
            ),
            settingsCheckboxField(
                "Maintain hub socket connection",
                "shell.maintainHubSocketConnection"
            ),
            settingsSelectField("Wire protocol", "core.socket.protocol", [
                ["https", "https (force wss)"],
                ["auto", "auto"],
                ["http", "http"]
            ]),
            settingsHint(
                "Context menu Copy & Share / Paste by CWSP use the CWSP hub (ecosystem token). Control pairing on the CWSP tab is only for Neutralino Settings sync."
            ),
            "Chrome",
            settingsCheckboxField("Enable New Tab Page (offline Basic)", "core.ntpEnabled"),
            settingsCheckboxField(
                "Capture selection via context menu",
                "views.crx.contextMenuCapture"
            ),
            settingsCheckboxField("Auto-open results in side panel", "views.crx.openInSidePanel"),
            "Clipboard bridge",
            settingsCheckboxField(
                "Enable remote clipboard bridge",
                "shell.enableRemoteClipboardBridge"
            ),
            settingsCheckboxField("Accept contacts bridge", "shell.acceptContactsBridgeData"),
            settingsHint(
                "Gateway / Relay + token sync to Neutralino /service/config under CWSP. Changing Relay does not rewrite Local hub URL (unless you edit Local hub yourself)."
            )
        ];
        return settingsPanel("crx", "Extension", children);
    },
    load: (settings, panel) => {
        // INVARIANT: Extension tab always shows wire peer — never bare desk L-110.
        const fixed = reconcileCrxWireAndBackendIds(settings as Record<string, unknown>);
        Object.assign(settings, fixed);
        let localHub = String(settings.shell?.localHubUrl || "").trim();
        // COMPAT: older builds stored CRX wire host in core.endpointUrl (loopback).
        if (!localHub) {
            const ep = String(settings.core?.endpointUrl || "").trim();
            localHub = ep && isLoopbackHubUrl(ep) ? ep : CRX_LOCAL_HUB_URL;
        }
        const userInput = panel.querySelector(
            '[data-field="core.userId"]'
        ) as HTMLInputElement | null;
        const selfInput = panel.querySelector(
            '[data-field="core.socket.selfId"]'
        ) as HTMLInputElement | null;
        const hubInput = panel.querySelector(
            '[data-field="shell.localHubUrl"]'
        ) as HTMLInputElement | null;
        // WHY: always overwrite — empty-only fill left swapped L-110 visible after bind.
        if (userInput) userInput.value = CRX_WIRE_CLIENT_ID;
        if (selfInput) selfInput.value = CRX_WIRE_CLIENT_ID;
        if (hubInput && !hubInput.value.trim()) hubInput.value = localHub;
    },
    save: (settings) => {
        // INVARIANT: wire peer is always L-110-crx; never persist bare L-110 here.
        const fixed = reconcileCrxWireAndBackendIds(settings as Record<string, unknown>);
        settings.core = fixed.core as typeof settings.core;
        settings.shell = fixed.shell as typeof settings.shell;
        // WHY: empty Local hub would leave Coordinator without a desk target;
        // do not fall back to CWSP Relay (that would couple the two fields).
        const hub = String(settings.shell?.localHubUrl || "").trim();
        if (!hub) {
            settings.shell = { ...(settings.shell || {}), localHubUrl: CRX_LOCAL_HUB_URL };
        }
        // WHY: if CWSP tab left shell.clientId as wire id, pin desk default before Neutralino POST.
        const desk = String(settings.shell?.clientId || "").trim();
        if (!desk || /^L-\d{1,3}-crx$/i.test(desk)) {
            settings.shell = {
                ...(settings.shell || {}),
                clientId: CRX_BACKEND_CLIENT_ID_DEFAULT
            };
        }
    }
});

const mount = document.getElementById("app") as HTMLElement | null;

/** Debounced: saveSettings/webnativeControl 401 → pairing modal (arm also recovers on patch). */
let unauthorizedPairTimer = 0;
const armUnauthorizedPairing = (): void => {
    if (unauthorizedPairTimer) window.clearTimeout(unauthorizedPairTimer);
    unauthorizedPairTimer = window.setTimeout(() => {
        unauthorizedPairTimer = 0;
        void import("./neutralino-settings-arm")
            .then((m) => m.recoverCrxControlAuthFromUnauthorized())
            .then((ok) => {
                if (ok) {
                    console.log("[CRX settings] Control re-paired after unauthorized");
                    try {
                        chrome.runtime.sendMessage({ type: "cwsp-control-session-changed" });
                    } catch {
                        /* ignore */
                    }
                }
            })
            .catch((e) => console.warn("[CRX settings] Control re-pair failed:", e));
    }, 120);
};

void (async () => {
    // WHY: arm must register before Settings hydrate (settings:get → /service/config).
    const live = await registerCrxNeutralinoSettingsSync();
    console.log(
        `[CRX settings] Neutralino /service/config ${live ? "live" : "offline (chrome.storage only)"}`
    );
    window.addEventListener("cwsp-control-unauthorized", () => armUnauthorizedPairing());
    crxFrontend(mount ?? document.body, {
        shell: "immersive",
        initialView: "settings"
    });
})();
