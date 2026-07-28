/**
 * CRX network sub-coordinator.
 *
 * Provides a small facade for the shared CWSP WebSocket transport in Chrome
 * extension contexts (background / service worker, popup, offscreen, content
 * scripts via messaging). It applies the same persisted {@link AppSettings} as
 * the PWA: endpoint URL, identity, optional access token, hub socket toggle,
 * and clipboard policy. Use this for coordinator `act` / `ask` traffic, remote
 * clipboard sync, and future AI or automation asks routed through the endpoint.
 *
 * MV3 cold start: {@link startFromStoredSettings} respects {@link shouldDeferCrxHubSocketBootstrap}.
 * After CRX seed (`ensureCrxCwspSettingsSeeded`), hub-maintain is on for localhost / WAN.
 * Context-menu Share/Paste uses {@link ensureConnected} (force) so hub-maintain alone is not required.
 *
 * Modes such as “frontend as server” or WS reverse-listener are not fully
 * implemented; the extension typically acts as a normal CWSP client to the hub.
 */

import type { AppSettings } from "com/config/SettingsTypes";
import {
    ensureCrxCwspSettingsSeeded,
    loadSettings,
    shouldDeferCrxHubSocketBootstrap,
} from "com/config/Settings";
import { isCapacitorCwsNativeShell } from "shared/native/cws-bridge";
import {
    applyAirpadRuntimeFromAppSettings,
    getRemoteHost,
    isMaintainHubSocketConnectionEnabled,
    isPreferNativeWebsocketEnabled,
} from "cwsp-shared/remote-connection-runtime";
import { installAirpadHubLifecycleRecovery } from "shared/transport/hub-socket-boot";
import {
    connectWS,
    disconnectWS,
    initWebSocket,
    isWSConnected,
    onServerClipboardUpdate,
    onWSConnectionChange,
    sendCoordinatorAct,
    sendCoordinatorAsk,
    sendCoordinatorRequest,
} from "shared/transport/websocket";

type NetworkClipboardMeta = { source?: string };
type NetworkClipboardHandler = (text: string, meta?: NetworkClipboardMeta) => void;
type ConnectionHandler = (connected: boolean) => void;

export type CrxConnectOptions = {
    /** Skip defer + hub-maintain gate (context-menu Share/Paste). */
    force?: boolean;
    /** Max wait for WS open (ms). */
    timeoutMs?: number;
};

export interface CrxNetworkCoordinator {
    startFromStoredSettings(): Promise<void>;
    startFromSettings(settings: AppSettings, opts?: CrxConnectOptions): Promise<void>;
    /** Seed settings if needed, then connect (force) and wait until open or timeout. */
    ensureConnected(opts?: CrxConnectOptions): Promise<{ ok: boolean; host: string; error?: string }>;
    stop(): void;
    isConnected(): boolean;
    getRemoteHost(): string;
    onConnectionChange(handler: ConnectionHandler): () => void;
    onServerClipboardUpdate(handler: NetworkClipboardHandler): () => void;
    sendCoordinatorAct(
        what: string,
        payload: any,
        nodes?: string[],
        opts?: { accessToken?: string }
    ): boolean;
    sendCoordinatorAsk(what: string, payload: any, nodes?: string[]): Promise<any>;
    sendCoordinatorRequest(what: string, payload: any, nodes?: string[]): Promise<any>;
}

const waitForWs = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
        if (isWSConnected()) {
            resolve(true);
            return;
        }
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsub();
            resolve(ok);
        };
        const unsub = onWSConnectionChange((connected) => {
            if (connected) finish(true);
        });
        const timer = setTimeout(() => finish(isWSConnected()), timeoutMs);
    });

const createCoordinator = (): CrxNetworkCoordinator => {
    const shouldSkipConnection = (): boolean => {
        if (isCapacitorCwsNativeShell() && isPreferNativeWebsocketEnabled()) {
            return true;
        }
        return false;
    };

    const startFromSettings = async (
        settings: AppSettings,
        opts?: CrxConnectOptions
    ): Promise<void> => {
        installAirpadHubLifecycleRecovery();
        applyAirpadRuntimeFromAppSettings(settings);

        if (shouldSkipConnection()) return;
        if (!opts?.force && !isMaintainHubSocketConnectionEnabled()) return;

        const host = getRemoteHost().trim();
        if (!host) return;

        initWebSocket(null);
        connectWS();
    };

    return {
        startFromStoredSettings: async () => {
            try {
                await ensureCrxCwspSettingsSeeded();
            } catch {
                /* seed best-effort */
            }
            const settings = await loadSettings();
            if (await shouldDeferCrxHubSocketBootstrap(settings)) return;
            await startFromSettings(settings);
        },

        startFromSettings,

        ensureConnected: async (opts?: CrxConnectOptions) => {
            try {
                await ensureCrxCwspSettingsSeeded();
            } catch {
                /* seed best-effort */
            }
            const settings = await loadSettings();
            // WHY: Extension Local hub ≠ CWSP Relay — wire uses shell.localHubUrl only.
            const host =
                String(settings.shell?.localHubUrl || "").trim() ||
                getRemoteHost().trim() ||
                "https://127.0.0.1:8434/";
            const timeoutMs = opts?.timeoutMs ?? 8000;

            if (isWSConnected()) {
                return { ok: true, host };
            }

            await startFromSettings(settings, { force: true, ...opts });
            const ok = await waitForWs(timeoutMs);
            if (ok) return { ok: true, host: getRemoteHost().trim() || host };

            return {
                ok: false,
                host: getRemoteHost().trim() || host,
                error:
                    "CWSP hub not connected. Check Extension → Local hub URL (default https://127.0.0.1:8434/), " +
                    "cert trusted in Chrome, L-110-crx + CWSP ecosystem token (WAN hubs need auth).",
            };
        },

        stop: () => {
            disconnectWS();
        },

        isConnected: () => isWSConnected(),

        getRemoteHost: () => getRemoteHost().trim(),

        onConnectionChange: (handler: ConnectionHandler) => onWSConnectionChange(handler),

        onServerClipboardUpdate: (handler: NetworkClipboardHandler) => onServerClipboardUpdate(handler),

        sendCoordinatorAct: (what: string, payload: any, nodes?: string[], opts?: { accessToken?: string }) =>
            sendCoordinatorAct(what, payload, nodes, opts),

        sendCoordinatorAsk: (what: string, payload: any, nodes?: string[]) => sendCoordinatorAsk(what, payload, nodes),

        sendCoordinatorRequest: (what: string, payload: any, nodes?: string[]) => sendCoordinatorRequest(what, payload, nodes),
    };
};

let instance: CrxNetworkCoordinator | null = null;

export const getCrxNetworkCoordinator = (): CrxNetworkCoordinator => {
    if (!instance) {
        instance = createCoordinator();
    }
    return instance;
};
