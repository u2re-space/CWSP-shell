/*
 * Filename: neutralino-settings-arm.ts
 * FullPath: apps/CWSP-shell/src/crx/settings/neutralino-settings-arm.ts
 * Change date and time: 21.10.00_20.07.2026
 * Reason for changes: CRX Control resolve is session-only (no API-key / sidecar spam).
 *   Unpaired → chrome.storage SoT; Pair Control / Save opens modal.
 */

import {
    registerSettingsSyncArm,
    setSurfaceDetector,
    type SettingsBlob,
    type SettingsPatch,
    type SettingsSyncArm
} from "views/settings";
import {
    clearCrxControlSession,
    getCrxControlSessionToken,
    hasValidCrxControlSession,
    pairCrxControlWithModal,
    readCrxControlSession
} from "com/config/settings/crx-control-session";

/**
 * INVARIANT: desk Neutralino portable.config keeps wire id L-110.
 * CRX chrome.storage keeps L-110-crx — never write CRX id into Node SoT.
 */
export const CRX_WIRE_CLIENT_ID = "L-110-crx";
/** Desk Neutralino / backend default when portable has no non-CRX client id. */
export const CRX_BACKEND_CLIENT_ID_DEFAULT = "L-110";

const isCrxWireNodeId = (value: unknown): boolean =>
    /^L-\d{1,3}-crx$/i.test(String(value ?? "").trim());

/** First non-empty id that is not a Chrome wire peer (`*-crx`). */
const pickBackendClientId = (...candidates: unknown[]): string => {
    for (const raw of candidates) {
        const id = String(raw ?? "").trim();
        if (id && !isCrxWireNodeId(id)) return id;
    }
    return "";
};

const DEFAULT_CONTROL_KEY = "cwsp-neutralino-local";
const DEFAULT_LOCAL_HUB_URL = "https://127.0.0.1:8434/";
const SETTINGS_STORAGE_KEY = "rs-settings";
const FETCH_TIMEOUT_MS = 2500;

/** COMPAT Neutralino control band when Local hub :8434 alias is busy. */
const SIDECAR_CONTROL_PORTS: number[] = (() => {
    const ports: number[] = [];
    for (let p = 29110; p <= 29118; p++) ports.push(p);
    ports.push(19875, 18765);
    return ports;
})();

type ControlEndpoint = {
    /** Persistent CRX Control session (preferred over desk key for extension Origin). */
    session?: string;
    origin: string;
    key: string;
    via: "local-hub" | "sidecar";
};

let cachedEndpoint: ControlEndpoint | null = null;

const asRecord = (value: unknown): SettingsBlob =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as SettingsBlob)
        : {};

/** Read chrome.storage SoT for Local hub URL + ecosystem token (no loadSettings cycle). */
async function readCrxStorageHints(): Promise<{ localHubUrl: string; token: string }> {
    const fallback = { localHubUrl: DEFAULT_LOCAL_HUB_URL, token: "" };
    try {
        const chromeApi = (
            globalThis as {
                chrome?: {
                    storage?: {
                        local?: {
                            get: (
                                keys: string[],
                                cb: (result: Record<string, unknown>) => void
                            ) => void;
                        };
                    };
                };
            }
        ).chrome;
        if (!chromeApi?.storage?.local?.get) return fallback;
        const stored = await new Promise<Record<string, unknown>>((resolve) => {
            try {
                chromeApi.storage!.local!.get([SETTINGS_STORAGE_KEY], (result) => {
                    resolve(result || {});
                });
            } catch {
                resolve({});
            }
        });
        const settings = asRecord(stored[SETTINGS_STORAGE_KEY]);
        const core = asRecord(settings.core);
        const shell = asRecord(settings.shell);
        const socket = asRecord(core.socket);
        const localHubUrl =
            String(shell.localHubUrl || "").trim() || DEFAULT_LOCAL_HUB_URL;
        const token = String(
            core.ecosystemToken || core.userKey || socket.accessToken || ""
        ).trim();
        return { localHubUrl, token };
    } catch {
        return fallback;
    }
}

function parseHubUrl(raw: string): { hostname: string; port: number; protocol: string } {
    const fallback = { hostname: "127.0.0.1", port: 8434, protocol: "http:" };
    try {
        const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const u = new URL(withScheme);
        const port = u.port
            ? Number(u.port)
            : u.protocol === "http:"
              ? 80
              : 443;
        return {
            hostname: u.hostname || "127.0.0.1",
            port: Number.isFinite(port) && port > 0 ? port : 8434,
            protocol: u.protocol === "http:" ? "http:" : "https:"
        };
    } catch {
        return fallback;
    }
}

/** Origins to probe for /service/config from Extension Local hub URL. */
function localHubOrigins(localHubUrl: string): string[] {
    const { hostname, port, protocol } = parseHubUrl(localHubUrl);
    const hostPart = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    // WHY: chrome-extension → loopback HTTPS often fails on self-signed desk certs; try http first.
    const httpOrigin = `http://${hostPart}:${port === 80 ? 8434 : port}`;
    const httpsOrigin = `https://${hostPart}:${port === 443 ? 8434 : port}`;
    const ordered =
        protocol === "http:" ? [httpOrigin, httpsOrigin] : [httpOrigin, httpsOrigin];
    // Prefer explicit Local hub port (8434) http, then https.
    return [...new Set(ordered)];
}

function sidecarOrigins(localHubUrl: string): string[] {
    const { hostname } = parseHubUrl(localHubUrl);
    const hostPart = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    return SIDECAR_CONTROL_PORTS.map((p) => `http://${hostPart}:${p}`);
}

const endpointFetch = async (
    endpoint: ControlEndpoint,
    path: string,
    init?: RequestInit
): Promise<Response | null> => {
    try {
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        // SECURITY: chrome-extension Origin cannot use desk X-API-Key — session only.
        const session =
            String(endpoint.session || "").trim() || (await getCrxControlSessionToken());
        try {
            const extOrigin =
                typeof chrome !== "undefined" && chrome?.runtime?.id
                    ? `chrome-extension://${chrome.runtime.id}`
                    : "";
            if (extOrigin) headers.set("X-Control-Origin", extOrigin);
        } catch {
            /* ignore */
        }
        if (session) {
            headers.set("X-Control-Session", session);
            headers.set("X-Skip-Legacy-Key", "1");
        }
        // WHY: chrome-extension Origin never accepts desk X-API-Key — skip it (avoids 401 spam).
        const signal =
            init?.signal ??
            (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
                ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
                : undefined);
        const url = `${endpoint.origin.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
        const res = await fetch(url, {
            ...init,
            headers,
            cache: "no-store",
            signal,
            credentials: "omit"
        });
        // WHY: only clear when the paired Control host rejects — probes to other ports must not wipe session.
        if ((res.status === 401 || res.status === 403) && session && path.includes("/service/")) {
            const paired = await readCrxControlSession().catch(() => null);
            const pairedHost = String(paired?.controlHost || "")
                .trim()
                .replace(/\/+$/, "");
            const tried = endpoint.origin.replace(/\/+$/, "");
            if (pairedHost && pairedHost === tried) {
                await clearCrxControlSession().catch(() => undefined);
                cachedEndpoint = null;
            }
        }
        return res;
    } catch {
        return null;
    }
};

const publishAuthGlobals = (endpoint: ControlEndpoint): void => {
    try {
        const u = new URL(endpoint.origin);
        const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
        const auth = {
            port,
            key: endpoint.key,
            host: u.hostname,
            scheme: u.protocol === "https:" ? ("https" as const) : ("http" as const)
        };
        const g = globalThis as unknown as {
            __NEUTRALINO_AUTH__?: typeof auth;
            __WEBNATIVE_AUTH__?: typeof auth;
            __CWSP_CONTROL_VIA__?: string;
        };
        g.__NEUTRALINO_AUTH__ = auth;
        g.__WEBNATIVE_AUTH__ = auth;
        // WHY: CRX Local hub is desk Neutralino (:8434 alias or :29110) — not Capacitor.
        g.__CWSP_CONTROL_VIA__ = "neutralino";
    } catch {
        /* ignore */
    }
};

/** Clear Control globals so Settings hydrate does not treat CRX as live WebNative SoT. */
const clearAuthGlobals = (): void => {
    try {
        const g = globalThis as unknown as {
            __NEUTRALINO_AUTH__?: unknown;
            __WEBNATIVE_AUTH__?: unknown;
            __CWSP_CONTROL_VIA__?: string;
        };
        delete g.__NEUTRALINO_AUTH__;
        delete g.__WEBNATIVE_AUTH__;
        delete g.__CWSP_CONTROL_VIA__;
    } catch {
        /* ignore */
    }
};

/** Serialize pairing modals so Save + unauthorized event do not open two dialogs. */
let pairModalInFlight: Promise<boolean> | null = null;

/**
 * Ensure persistent Control session before write.
 * Opens pairing modal when missing/expired (chrome-extension Origin cannot use desk API key).
 */
async function ensureCrxControlAuthorized(opts?: {
    forceModal?: boolean;
    localHubUrl?: string;
}): Promise<ControlEndpoint | null> {
    const run = async (): Promise<boolean> => {
        if (!opts?.forceModal && (await hasValidCrxControlSession())) {
            cachedEndpoint = null;
            const auth = await resolveNeutralinoControlAuth();
            if (auth) {
                const probe = await endpointFetch(auth, "/service/config", { method: "GET" });
                if (probe?.ok) return true;
            }
        }
        const { localHubUrl } = await readCrxStorageHints();
        let preferred: string[] = [];
        try {
            const ds = String(document.documentElement.dataset.cwspControlOrigin || "").trim();
            if (ds) preferred.push(ds);
            if (cachedEndpoint?.origin) preferred.push(cachedEndpoint.origin);
        } catch {
            /* ignore */
        }
        // WHY: always prefer canonical Neutralino Control (:29110) — UI token comes from there.
        preferred.unshift("http://127.0.0.1:29110");
        const result = await pairCrxControlWithModal({
            localHubUrl: opts?.localHubUrl || localHubUrl,
            preferredOrigins: preferred
        });
        if (!result.ok) {
            if (result.cancelled) return false;
            throw new Error(result.error || "Control pairing failed");
        }
        cachedEndpoint = null;
        return Boolean(await resolveNeutralinoControlAuth());
    };

    if (!pairModalInFlight) {
        pairModalInFlight = run().finally(() => {
            pairModalInFlight = null;
        });
    }
    const ok = await pairModalInFlight;
    return ok ? resolveNeutralinoControlAuth() : null;
}

async function probeEndpoint(
    origin: string,
    key: string,
    via: ControlEndpoint["via"],
    session?: string
): Promise<ControlEndpoint | null> {
    const endpoint = { origin, key, via, session };
    const res = await endpointFetch(endpoint, "/service/config", { method: "GET" });
    // WHY: 200 = live SoT; 401 = wrong key/session but host may still be Control.
    if (res?.ok) return endpoint;
    return null;
}

/**
 * Resolve Control SoT for CWSP tab.
 * INVARIANT (CRX): chrome-extension Origin may only use X-Control-Session.
 * Without a paired session → offline (chrome.storage SoT); never probe with API key.
 */
export async function resolveNeutralinoControlAuth(): Promise<ControlEndpoint | null> {
    const { localHubUrl } = await readCrxStorageHints();
    const paired = await readCrxControlSession();
    const session = String(paired?.token || "").trim();
    const key = DEFAULT_CONTROL_KEY;

    if (!session) {
        cachedEndpoint = null;
        clearAuthGlobals();
        return null;
    }

    if (cachedEndpoint?.session === session) {
        const hit = await endpointFetch(cachedEndpoint, "/service/config", { method: "GET" });
        if (hit?.ok) {
            publishAuthGlobals(cachedEndpoint);
            return cachedEndpoint;
        }
        cachedEndpoint = null;
    }

    // WHY: only touch paired host + canonical :29110 — no :8434 https / sidecar band spam.
    const origins = [
        ...(paired?.controlHost ? [String(paired.controlHost).trim()] : []),
        "http://127.0.0.1:29110",
        ...localHubOrigins(localHubUrl).filter((o) => o.startsWith("http://"))
    ].filter(Boolean);

    for (const origin of [...new Set(origins)]) {
        const via: ControlEndpoint["via"] =
            /:(2911\d|19875|18765)(\/|$)/.test(origin) ? "sidecar" : "local-hub";
        const ep = await probeEndpoint(origin, key, via, session);
        if (ep) {
            cachedEndpoint = ep;
            publishAuthGlobals(ep);
            console.log(`[CRX settings] Control SoT live via session @ ${ep.origin}`);
            return ep;
        }
    }

    cachedEndpoint = null;
    clearAuthGlobals();
    return null;
}

/** Map Node `/service/config` payload into AppSettings-shaped keys for Settings UI bind. */
export function normalizeServiceConfigToAppSettings(
    body: {
        settings?: SettingsBlob;
        portable?: SettingsBlob;
        snapshot?: SettingsBlob;
    } | null
): SettingsBlob {
    if (!body || typeof body !== "object") return {};
    const raw = asRecord(body.settings || body.portable);
    const snap = asRecord(body.snapshot);
    if (!Object.keys(raw).length && !Object.keys(snap).length) return {};

    const bridge = asRecord(raw.bridge || snap.bridge || asRecord(raw.core).bridge);
    const shellRaw = asRecord(raw.shell || snap.shell);
    const coreRaw = asRecord(raw.core);

    const endpoints = Array.isArray(bridge.endpoints)
        ? bridge.endpoints.map((e) => String(e || "").trim()).filter(Boolean)
        : [];
    const endpointUrl = String(
        coreRaw.endpointUrl || bridge.endpointUrl || shellRaw.remoteHost || endpoints[0] || ""
    ).trim();
    // Backend / desk identity (Neutralino portable) — UI binds shell.clientId on CRX CWSP tab.
    // WHY: never prefer polluted shell.clientId=L-110-crx over portable core.userId=L-110.
    const backendClientId =
        pickBackendClientId(
            shellRaw.clientId,
            coreRaw.userId,
            bridge.userId,
            bridge.deviceId
        ) || CRX_BACKEND_CLIENT_ID_DEFAULT;
    const token = String(
        coreRaw.ecosystemToken ||
            coreRaw.userKey ||
            bridge.userKey ||
            shellRaw.accessToken ||
            shellRaw.clientToken ||
            ""
    ).trim();
    const allowInsecureTls =
        bridge.allowInsecureTls !== undefined
            ? Boolean(bridge.allowInsecureTls)
            : coreRaw.allowInsecureTls !== undefined
              ? Boolean(coreRaw.allowInsecureTls)
              : undefined;

    const socketPrev = asRecord(coreRaw.socket);
    const core: SettingsBlob = { ...coreRaw };
    if (endpointUrl) core.endpointUrl = endpointUrl;
    // WHY: omit desk userId on hydrate — chrome.storage core.userId stays L-110-crx.
    delete core.userId;
    if (token) {
        core.userKey = token;
        core.ecosystemToken = token;
        core.socket = { ...socketPrev, accessToken: token };
    } else if (Object.keys(socketPrev).length) {
        core.socket = { ...socketPrev };
    }
    const socket = asRecord(core.socket);
    if (socket.selfId) delete socket.selfId;
    if (Object.keys(socket).length) core.socket = socket;
    if (allowInsecureTls !== undefined) core.allowInsecureTls = allowInsecureTls;
    if (core.preferBackendSync === undefined) core.preferBackendSync = true;

    const shell: SettingsBlob = { ...shellRaw };
    // INVARIANT: always set a non-CRX desk id so merge overwrites chrome.storage pollution.
    shell.clientId = backendClientId;
    delete shell.userId;
    // INVARIANT: Extension Local hub is chrome.storage-only — Neutralino must not clobber it.
    delete shell.localHubUrl;
    // WHY: Extension tab owns hub-maintain / wire protocol — do not import desk shell flags.
    delete shell.maintainHubSocketConnection;

    return { ...raw, core, shell };
}

/**
 * After local+remote merge: Extension wire vs Neutralino backend ids must not swap.
 * INVARIANT: core.userId / socket.selfId = L-110-crx; shell.clientId = desk (not *-crx).
 */
export function reconcileCrxWireAndBackendIds<T extends SettingsBlob>(settings: T): T {
    const core = asRecord(settings.core);
    const shell = asRecord(settings.shell);
    const socket = asRecord(core.socket);

    const backendId =
        pickBackendClientId(shell.clientId, core.userId) || CRX_BACKEND_CLIENT_ID_DEFAULT;

    return {
        ...settings,
        core: {
            ...core,
            userId: CRX_WIRE_CLIENT_ID,
            socket: {
                ...socket,
                selfId: CRX_WIRE_CLIENT_ID
            }
        },
        shell: {
            ...shell,
            clientId: backendId
        }
    } as T;
}

/**
 * Strip CRX wire identity (L-110-crx) before POST.
 * KEEP shell.clientId — that is the Neutralino/backend client id from the CWSP tab.
 */
export function stripCrxIdentityFromPatch(patch: SettingsPatch): SettingsPatch {
    const out: SettingsPatch = { ...patch };
    const core = asRecord(out.core);
    if (Object.keys(core).length) {
        const nextCore = { ...core };
        const uid = String(nextCore.userId || "").trim();
        // Only drop when it is the extension wire peer — never send L-110-crx as desk id.
        if (!uid || /^L-110-crx$/i.test(uid)) {
            delete nextCore.userId;
        }
        const socket = asRecord(nextCore.socket);
        if (Object.keys(socket).length) {
            const nextSocket = { ...socket };
            const selfId = String(nextSocket.selfId || "").trim();
            if (!selfId || /^L-110-crx$/i.test(selfId)) {
                delete nextSocket.selfId;
            }
            nextCore.socket = nextSocket;
        }
        out.core = nextCore;
    }
    const shell = asRecord(out.shell);
    if (Object.keys(shell).length) {
        const nextShell = { ...shell };
        delete nextShell.userId;
        // WHY: CRX-only wire hub — never write into Neutralino portable.config.
        delete nextShell.localHubUrl;
        delete nextShell.maintainHubSocketConnection;
        const cid = String(nextShell.clientId || "").trim();
        if (/^L-110-crx$/i.test(cid)) {
            delete nextShell.clientId;
        }
        out.shell = nextShell;
    }
    const bridge = asRecord(out.bridge);
    if (Object.keys(bridge).length) {
        const nextBridge = { ...bridge };
        const bid = String(nextBridge.userId || nextBridge.deviceId || "").trim();
        if (/^L-110-crx$/i.test(bid)) {
            delete nextBridge.userId;
            delete nextBridge.deviceId;
        }
        out.bridge = nextBridge;
    }
    return out;
}

/**
 * Expand AppSettings → portable shell/bridge so Node clipboard-hub dials gateway.
 * INVARIANT: backend clientId comes from shell.clientId (CWSP tab), not CRX core.userId.
 */
function expandCoreIntoPortable(patch: SettingsPatch): SettingsPatch {
    const core = asRecord(patch.core);
    const shellIn = asRecord(patch.shell);
    const endpointUrl = String(core.endpointUrl || "").trim();
    const token = String(core.userKey || core.ecosystemToken || "").trim();
    // WHY: never expand CRX wire id into portable desk identity.
    const safeBackendId = pickBackendClientId(shellIn.clientId, core.userId);
    const expanded: SettingsPatch = { ...patch };
    if (!endpointUrl && !token && !safeBackendId) return expanded;

    const nextCore: SettingsBlob = { ...core };
    if (safeBackendId) nextCore.userId = safeBackendId;
    expanded.core = nextCore;

    expanded.bridge = {
        ...asRecord(patch.bridge),
        ...(endpointUrl ? { endpointUrl } : {}),
        ...(token ? { userKey: token } : {}),
        ...(safeBackendId ? { userId: safeBackendId } : {})
    };
    expanded.shell = {
        ...shellIn,
        ...(endpointUrl ? { remoteHost: endpointUrl } : {}),
        ...(token ? { accessToken: token, clientToken: token } : {}),
        ...(safeBackendId ? { clientId: safeBackendId, userId: safeBackendId } : {})
    };
    // Never leak Extension Local hub into portable.
    delete (expanded.shell as SettingsBlob).localHubUrl;
    delete (expanded.shell as SettingsBlob).maintainHubSocketConnection;
    return expanded;
}

type ServiceConfigBody = {
    settings?: SettingsBlob;
    portable?: SettingsBlob;
    snapshot?: SettingsBlob;
    defaults?: SettingsBlob;
};

async function serviceConfig(
    endpoint: ControlEndpoint,
    init?: RequestInit
): Promise<{ body: ServiceConfigBody | null; status: number; unauthorized: boolean }> {
    const res = await endpointFetch(endpoint, "/service/config", init);
    const status = res?.status ?? 0;
    const unauthorized = status === 401 || status === 403;
    if (!res?.ok) return { body: null, status, unauthorized };
    try {
        return {
            body: (await res.json()) as ServiceConfigBody,
            status,
            unauthorized: false
        };
    } catch {
        return { body: null, status, unauthorized: false };
    }
}

/**
 * CRX settings:get/patch arm — Neutralino `/service/config` via Extension Local hub URL.
 * Falls back to empty get (chrome.storage remains local SoT for Extension wire identity).
 * INVARIANT: patch requires persistent Control session; 401 opens pairing modal + retry.
 */
export function createCrxNeutralinoSettingsArm(): SettingsSyncArm {
    return {
        get: async () => {
            const auth = await resolveNeutralinoControlAuth();
            if (!auth) return {};
            const { body } = await serviceConfig(auth, { method: "GET" });
            return normalizeServiceConfigToAppSettings(body);
        },
        patch: async (patch: SettingsPatch) => {
            const safe = expandCoreIntoPortable(stripCrxIdentityFromPatch(patch));
            let auth: ControlEndpoint | null;
            try {
                auth = await ensureCrxControlAuthorized();
            } catch (e) {
                throw e instanceof Error
                    ? e
                    : new Error(String(e || "Control pairing failed"));
            }
            if (!auth) {
                throw new Error(
                    "Control pairing cancelled — open Pair Control… and paste token + code from Neutralino :29110"
                );
            }

            let { body, unauthorized } = await serviceConfig(auth, {
                method: "POST",
                body: JSON.stringify(safe)
            });

            if (unauthorized || !body) {
                auth = await ensureCrxControlAuthorized({ forceModal: true });
                if (!auth) {
                    throw new Error("Control pairing cancelled — settings not pushed to Neutralino");
                }
                ({ body, unauthorized } = await serviceConfig(auth, {
                    method: "POST",
                    body: JSON.stringify(safe)
                }));
            }

            if (unauthorized || !body) {
                throw new Error(
                    `Control rejected settings save (HTTP ${unauthorized ? "401/403" : "error"})`
                );
            }

            const endpointUrl = String(asRecord(safe.core).endpointUrl || "").trim();
            const token = String(
                asRecord(safe.core).userKey || asRecord(safe.core).ecosystemToken || ""
            ).trim();
            const clientId = String(
                asRecord(safe.shell).clientId || asRecord(safe.core).userId || ""
            ).trim();
            if (endpointUrl) {
                try {
                    await endpointFetch(auth, "/service/clipboard-hub", {
                        method: "POST",
                        body: JSON.stringify({
                            remoteHost: endpointUrl,
                            ...(token ? { accessToken: token, clientToken: token } : {}),
                            ...(clientId && !/^L-110-crx$/i.test(clientId)
                                ? { clientId }
                                : {}),
                            reload: true
                        })
                    });
                } catch {
                    /* hub optional */
                }
            }
            return normalizeServiceConfigToAppSettings(body);
        },
        defaults: async () => {
            const auth = await resolveNeutralinoControlAuth();
            if (!auth) return {};
            const { body } = await serviceConfig(auth, { method: "GET" });
            return body?.defaults ?? {};
        },
        snapshot: async () => {
            const auth = await resolveNeutralinoControlAuth();
            if (!auth) return {};
            const { body } = await serviceConfig(auth, { method: "GET" });
            return body?.snapshot ?? {};
        }
    };
}

/** Used by options page: 401 from saveSettings/webnativeControl → same modal. */
export async function recoverCrxControlAuthFromUnauthorized(): Promise<boolean> {
    const auth = await ensureCrxControlAuthorized({ forceModal: true });
    return Boolean(auth);
}

/** Register CRX surface arm + mark bridge status on documentElement. */
export async function registerCrxNeutralinoSettingsSync(): Promise<boolean> {
    setSurfaceDetector(() => "crx");
    registerSettingsSyncArm("crx", createCrxNeutralinoSettingsArm());
    const auth = await resolveNeutralinoControlAuth();
    try {
        document.documentElement.dataset.cwspBridge = auth ? "live" : "offline";
        document.documentElement.dataset.cwspSurface = "crx";
        if (auth) {
            document.documentElement.dataset.cwspControlOrigin = auth.origin;
            document.documentElement.dataset.cwspControlVia = auth.via;
        }
    } catch {
        /* ignore */
    }
    return Boolean(auth);
}
