/*
 * Filename: neutralino-clipboard-take.ts
 * FullPath: apps/CWSP-shell/src/crx/network/neutralino-clipboard-take.ts
 * Change date and time: 15.05.00_19.07.2026
 * Reason for changes: CRX Paste Accept bypass — GET full prompt.text + take/accept;
 *   parallel port probe; dismiss-only helper for WS paste-hold path.
 */

/**
 * Probe Neutralino/WebNative loopback control and take pending inbound ask text.
 *
 * INVARIANT: desk control defaults are `CWSP_CONTROL_PORT` / `CWSP_CONTROL_KEY`
 * (`29110` / `cwsp-neutralino-local`); port may bump when Cursor steals the band.
 */

const DEFAULT_CONTROL_KEY = "cwsp-neutralino-local";
const FETCH_TIMEOUT_MS = 350;
const MISS_CACHE_MS = 8_000;

const CONTROL_PORT_CANDIDATES: number[] = (() => {
    const ports: number[] = [];
    for (let p = 29110; p <= 29118; p++) ports.push(p);
    ports.push(19875, 18765);
    return ports;
})();

type PromptState = {
    kind?: string;
    mode?: string;
    text?: string;
    textPreview?: string;
    textLength?: number;
};

type TakeResponse = {
    ok?: boolean;
    applied?: boolean;
    text?: string;
};

type PortProbe =
    | { reachable: false }
    | { reachable: true; text: string; port: number; dismissed?: boolean };

let cachedAuth: { port: number; key: string } | null = null;
let missUntil = 0;

const controlFetch = async (
    port: number,
    key: string,
    path: string,
    init?: RequestInit
): Promise<Response | null> => {
    try {
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        headers.set("X-API-Key", key);
        const signal =
            typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
                ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
                : undefined;
        return await fetch(`http://127.0.0.1:${port}${path}`, {
            ...init,
            headers,
            cache: "no-store",
            signal
        });
    } catch {
        return null;
    }
};

const readPrompt = async (port: number, key: string): Promise<PromptState | null | undefined> => {
    const res = await controlFetch(port, key, "/service/clipboard-prompt");
    if (!res?.ok) return undefined;
    try {
        const data = (await res.json()) as { prompt?: PromptState | null; state?: PromptState | null };
        return data.prompt ?? data.state ?? null;
    } catch {
        return undefined;
    }
};

const isInboundAsk = (prompt: PromptState): boolean => {
    const kind = String(prompt.kind || "").toLowerCase();
    const mode = String(prompt.mode || "").toLowerCase();
    if (kind !== "inbound") return false;
    // Prefer ask; also accept unknown mode when text is held (compat).
    if (mode === "ask" || mode === "") return true;
    return Number(prompt.textLength || 0) > 0 || Boolean(String(prompt.text || "").trim());
};

const postAction = async (
    port: number,
    key: string,
    action: "take" | "accept"
): Promise<TakeResponse | null> => {
    const res = await controlFetch(port, key, "/service/clipboard-prompt", {
        method: "POST",
        body: JSON.stringify({ action })
    });
    if (!res) return null;
    if (!res.ok && action === "take" && res.status === 400) {
        return postAction(port, key, "accept");
    }
    if (!res.ok) return null;
    try {
        return (await res.json()) as TakeResponse;
    } catch {
        return { ok: true, applied: true, text: "" };
    }
};

const readOsClipboard = async (port: number, key: string): Promise<string> => {
    const clip = await controlFetch(port, key, "/service/clipboard?kind=text");
    if (!clip?.ok) return "";
    try {
        const body = (await clip.json()) as { text?: string; content?: string; data?: string };
        return (
            (typeof body.text === "string" && body.text) ||
            (typeof body.content === "string" && body.content) ||
            (typeof body.data === "string" && body.data) ||
            ""
        );
    } catch {
        return "";
    }
};

const tryTakeOnPort = async (port: number, key: string): Promise<PortProbe> => {
    const prompt = await readPrompt(port, key);
    if (prompt === undefined) return { reachable: false };
    cachedAuth = { port, key };
    if (prompt === null || !isInboundAsk(prompt)) {
        return { reachable: true, text: "", port };
    }

    // Prefer full text from GET (new hub) before mutating prompt.
    const fromGet = String(prompt.text || "").trim();
    const taken = await postAction(port, key, "take");
    const fromTake = String(taken?.text || "").trim();
    let text = fromTake || fromGet;
    if (!text) {
        // COMPAT: accept applied to OS — read clipboardy via control.
        text = String(await readOsClipboard(port, key)).trim();
    }
    return { reachable: true, text, port, dismissed: Boolean(taken?.applied || text) };
};

/**
 * If Neutralino has an inbound Accept hold, accept it and return full text.
 */
export const takeNeutralinoInboundAskClipboard = async (): Promise<{
    text: string;
    source?: string;
}> => {
    const key = DEFAULT_CONTROL_KEY;
    const now = Date.now();

    if (cachedAuth?.port) {
        const hit = await tryTakeOnPort(cachedAuth.port, key);
        if (hit.reachable) {
            if (hit.text) {
                missUntil = 0;
                return { text: hit.text, source: `neutralino-take:${hit.port}` };
            }
            return { text: "" };
        }
        cachedAuth = null;
    }

    if (now < missUntil) return { text: "" };

    const results = await Promise.all(
        CONTROL_PORT_CANDIDATES.map((port) => tryTakeOnPort(port, key))
    );
    const taken = results.find((r) => r.reachable && r.text);
    if (taken && taken.reachable && taken.text) {
        missUntil = 0;
        cachedAuth = { port: taken.port, key };
        return { text: taken.text, source: `neutralino-take:${taken.port}` };
    }

    const alive = results.find((r) => r.reachable);
    if (alive && alive.reachable) {
        cachedAuth = { port: alive.port, key };
        missUntil = 0;
        return { text: "" };
    }

    missUntil = now + MISS_CACHE_MS;
    return { text: "" };
};

/**
 * Dismiss Neutralino Accept popup after CRX already has the text (WS paste-hold).
 * Best-effort — does not block paste insert.
 */
export const dismissNeutralinoInboundAsk = async (): Promise<void> => {
    try {
        await takeNeutralinoInboundAskClipboard();
    } catch {
        /* ignore */
    }
};
