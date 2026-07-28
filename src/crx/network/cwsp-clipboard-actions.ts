/*
 * Filename: cwsp-clipboard-actions.ts
 * FullPath: apps/CWSP-shell/src/crx/network/cwsp-clipboard-actions.ts
 * Change date and time: 21.55.00_20.07.2026
 * Reason for changes: Paste: Neutralino inbound `take` before OS stash (Accept popup bypass).
 *   Ungate Copy & Share / Paste from Control pairing — hub WS + ecosystem token is enough.
 *   Control session remains for Neutralino /service/config Settings sync only.
 */
/**
 * CRX CWSP clipboard helpers for service-worker context menus.
 *
 * - Copy & Share: local copy + `clipboard:update` act (skips Neutralino/Android Share prompt path).
 * - Paste by CWSP: Neutralino Accept-take → CRX held → OS stash → peers → insert.
 * - Auth: CWSP hub identity (L-110-crx + ecosystem token), not X-Control-Session.
 */

import {
    getClipboardShareDestinationNodes,
    getClipboardBroadcastTargetNodes,
    getAirPadClientId,
} from "cwsp-shared/remote-connection-runtime";
import { getLastServerClipboard } from "shared/transport/websocket";
import { getCrxNetworkCoordinator } from "./Coordinator";
import {
    dismissNeutralinoInboundAsk,
    takeNeutralinoInboundAskClipboard,
} from "./neutralino-clipboard-take";
import { COPY_HACK, READ_CLIPBOARD } from "../service/api";

type HeldInbound = {
    text: string;
    at: number;
    source?: string;
};

let heldInbound: HeldInbound | null = null;
let inboundHookInstalled = false;

const notify = (title: string, message: string) => {
    try {
        chrome.notifications?.create?.({
            type: "basic",
            iconUrl: "icons/icon.png",
            title,
            message,
        });
    } catch {
        /* notifications optional */
    }
};

/** Install once: hold inbound clipboard for Paste by CWSP (Accept bypass). */
export const installCrxCwspClipboardHold = (): void => {
    if (inboundHookInstalled) return;
    inboundHookInstalled = true;
    getCrxNetworkCoordinator().onServerClipboardUpdate((text, meta) => {
        const t = String(text ?? "");
        if (!t.trim()) return;
        heldInbound = {
            text: t,
            at: Date.now(),
            source: meta?.source,
        };
    });
};

export const takeHeldCwspClipboard = (): string => {
    const t = heldInbound?.text ?? "";
    heldInbound = null;
    if (t.trim()) return t;
    return String(getLastServerClipboard() || "");
};

export const peekHeldCwspClipboard = (): string => {
    const held = heldInbound?.text?.trim() ? heldInbound.text : "";
    return held || String(getLastServerClipboard() || "");
};

const ensureHubConnected = async (): Promise<{ ok: boolean; error?: string; host?: string }> => {
    // Keep paste snappy — do not block OS-stash path on a long hub dial.
    const result = await getCrxNetworkCoordinator().ensureConnected({ force: true, timeoutMs: 2500 });
    return result;
};

const resolveShareNodes = (): string[] => {
    const share = getClipboardShareDestinationNodes();
    if (share.length) return share;
    return getClipboardBroadcastTargetNodes();
};

const pasteTargetDedupeKey = (id: string): string => {
    const raw = String(id || "").trim().toLowerCase();
    if (!raw) return "";
    const full = /^l-192\.168\.0\.(\d{1,3})$/.exec(raw);
    if (full) return `l-${full[1]}`;
    if (/^l-\d{1,3}$/.test(raw)) return raw;
    return raw;
};

/** True when ask target is this peer (incl. L-110 ≡ L-192.168.0.110). */
const isSelfPasteTarget = (target: string, selfId: string): boolean => {
    const t = String(target || "").trim().toLowerCase();
    const s = String(selfId || "").trim().toLowerCase();
    if (!t || !s) return false;
    if (t === s || t === "self") return true;
    const tk = pasteTargetDedupeKey(t);
    const sk = pasteTargetDedupeKey(s);
    return Boolean(tk && sk && tk === sk);
};

/**
 * Paste ask targets: share destinations / phones — never self (L-110).
 */
const resolvePasteAskNodes = (): string[] => {
    const selfId = String(getAirPadClientId() || "").trim();
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
        const t = String(id || "").trim();
        if (!t || t === "*" || t === "self") return;
        if (isSelfPasteTarget(t, selfId)) return;
        const key = pasteTargetDedupeKey(t);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(t);
    };
    for (const n of resolveShareNodes()) push(n);
    push("L-196");
    push("L-210");
    push("L-200");
    return out.length ? out : ["L-196"];
};

/**
 * Copy selection/text to local clipboard and fan-out `clipboard:update` (Share bypass).
 */
export const copyAndShareByCwsp = async (
    text: string,
    tabId?: number
): Promise<{ ok: boolean; error?: string }> => {
    const payload = String(text ?? "");
    if (!payload.trim()) {
        return { ok: false, error: "No text to share" };
    }

    installCrxCwspClipboardHold();
    await COPY_HACK(chrome, { ok: true, data: payload as any }, tabId).catch(() => undefined);

    const hub = await ensureHubConnected();
    if (!hub.ok) {
        return { ok: false, error: hub.error || "CWSP hub not connected" };
    }

    const nodes = resolveShareNodes();
    const sent = getCrxNetworkCoordinator().sendCoordinatorAct(
        "clipboard:update",
        { text: payload, source: "chrome-crx-share" },
        nodes.length ? nodes : undefined
    );
    if (!sent) {
        return {
            ok: false,
            error: `Connected to ${hub.host || "hub"} but send failed — socket may have closed (auth/TLS).`,
        };
    }
    return { ok: true };
};

const extractAskText = (result: unknown): string => {
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
        const o = result as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
        if (typeof o.content === "string") return o.content;
        if (typeof o.result === "string") return o.result;
        if (typeof o.body === "string") return o.body;
        if (typeof o.data === "string") return o.data;
        if (o.data && typeof o.data === "object") {
            const nested = extractAskText(o.data);
            if (nested) return nested;
        }
        if (o.result && typeof o.result === "object") {
            const nested = extractAskText(o.result);
            if (nested) return nested;
        }
        if (o.payload && typeof o.payload === "object") {
            const nested = extractAskText(o.payload);
            if (nested) return nested;
        }
    }
    return "";
};

type PasteTabOpts = { tabId?: number; frameId?: number };

const tabMessageOptions = (opts?: PasteTabOpts): chrome.tabs.MessageSendOptions | undefined => {
    if (opts?.frameId != null && opts.frameId >= 0) return { frameId: opts.frameId };
    return undefined;
};

/** Content-script stash filled on contextmenu (user-gesture clipboard read). */
const readContentScriptStash = async (opts?: PasteTabOpts): Promise<string> => {
    const tabId = opts?.tabId;
    if (tabId == null || tabId < 0) return "";
    try {
        const resp = await chrome.tabs.sendMessage(
            tabId,
            { type: "CWSP_PASTE_STASH_GET" },
            tabMessageOptions(opts)
        );
        const text = String(resp?.text ?? "").trim();
        if (text) return text;
    } catch {
        /* content script missing */
    }
    return "";
};

/**
 * Resolve paste body: Neutralino Accept-take → held → OS stash → peers → OS.
 * WHY: inbound ask-hold lives in Neutralino Node hub (not CRX); OS stash is
 * stale desk clipboard while Accept popup is up — take must win first.
 */
export const resolveCwspPasteText = async (
    opts?: PasteTabOpts
): Promise<{ text: string; error?: string; source?: string }> => {
    installCrxCwspClipboardHold();

    // 1) Neutralino inbound ask → Accept + full text (dismisses popup).
    try {
        const taken = await takeNeutralinoInboundAskClipboard();
        if (taken.text.trim()) {
            return { text: taken.text, source: taken.source || "neutralino-take" };
        }
    } catch {
        /* control host offline — fall through */
    }

    // 2) CRX-held inbound (applyRemote=false path when CRX saw the packet).
    const peeked = peekHeldCwspClipboard().trim();
    if (peeked) {
        takeHeldCwspClipboard();
        return { text: peeked, source: "cwsp-held" };
    }

    // 3) Content-script OS stash (contextmenu gesture) — local clipboard only.
    const stash = await readContentScriptStash(opts);
    if (stash) return { text: stash, source: "os-stash" };

    // Offscreen / SW read — often fails without gesture; try quickly then ask peers.
    const osPromise = READ_CLIPBOARD(chrome, opts?.tabId).catch(() => ({
        ok: false as const,
        error: "read failed",
    }));

    const hubErrors: string[] = [];
    const hub = await ensureHubConnected();
    if (hub.ok) {
        const targets = resolvePasteAskNodes().slice(0, 2);
        for (const target of targets) {
            try {
                const result = await Promise.race([
                    getCrxNetworkCoordinator().sendCoordinatorAsk(
                        "clipboard:get",
                        { source: "chrome-crx-paste" },
                        [target]
                    ),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
                ]);
                if (result == null) {
                    hubErrors.push(`${target}: timeout`);
                    continue;
                }
                const text = extractAskText(result).trim();
                if (text) return { text, source: `ask:${target}` };
                hubErrors.push(`${target}: empty`);
            } catch (e) {
                hubErrors.push(
                    `${target}: ${e instanceof Error ? e.message : typeof e === "object" && e && "error" in e ? String((e as { error?: unknown }).error) : "ask failed"}`
                );
            }
        }

        const late = takeHeldCwspClipboard().trim();
        if (late) return { text: late, source: "cwsp-late" };
    } else {
        hubErrors.push(hub.error || "hub not connected");
    }

    const os = await osPromise;
    if (os.ok && typeof os.data === "string" && os.data.length) {
        return { text: os.data, source: "os-clipboard" };
    }

    // Last chance: stash may have filled after a slow clipboard.readText.
    const stash2 = await readContentScriptStash(opts);
    if (stash2) return { text: stash2, source: "os-stash-late" };

    return {
        text: "",
        error:
            hubErrors.length > 0
                ? `No CWSP clipboard (${hubErrors.slice(0, 2).join("; ")}); OS: ${os.error || "empty"}`
                : `No CWSP clipboard; OS: ${os.error || "empty"}`,
    };
};

/** Self-contained insert for executeScript backup (isolated world; no module state). */
const pageInsertFunc = (value: string): boolean => {
    const text = String(value ?? "");
    if (!text) return false;

    const usable = (el: Element | null): el is HTMLElement => {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (el instanceof HTMLInputElement) {
            const t = (el.type || "text").toLowerCase();
            if (["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"].includes(t)) {
                return false;
            }
            return !el.disabled && !el.readOnly;
        }
        if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
        return el.isContentEditable;
    };

    let target: HTMLElement | null = usable(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    if (!target) {
        const marked = document.querySelector("[data-cwsp-paste-target='1']");
        if (usable(marked)) target = marked;
    }
    if (!target) return false;

    try {
        target.focus();
    } catch {
        /* ignore */
    }

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        const next = target.value.slice(0, start) + text + target.value.slice(end);
        try {
            const proto = target instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            if (desc?.set) desc.set.call(target, next);
            else target.value = next;
        } catch {
            target.value = next;
        }
        const caret = start + text.length;
        try {
            target.setSelectionRange(caret, caret);
        } catch {
            /* ignore */
        }
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    if (target.isContentEditable) {
        try {
            if (document.execCommand("insertText", false, text)) return true;
        } catch {
            /* fall through */
        }
        target.appendChild(document.createTextNode(text));
        target.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    }
    return false;
};

const scriptTarget = (opts: PasteTabOpts): chrome.scripting.InjectionTarget => {
    const tabId = opts.tabId!;
    if (opts.frameId != null && opts.frameId >= 0) {
        return { tabId, frameIds: [opts.frameId] };
    }
    return { tabId };
};

const insertPasteIntoTab = async (opts: PasteTabOpts, text: string): Promise<boolean> => {
    const tabId = opts.tabId;
    if (tabId == null || tabId < 0) return false;
    const msgOpts = tabMessageOptions(opts);

    // Prefer content-script path (tracks lastEditable + DOM mark).
    try {
        const resp = await chrome.tabs.sendMessage(
            tabId,
            { type: "CWSP_PASTE_INSERT", text },
            msgOpts
        );
        if (resp?.ok) return true;
    } catch {
        try {
            await chrome.scripting.executeScript({
                target: scriptTarget(opts),
                files: ["content/main.ts"],
            });
            // Give contextmenu stash a beat if script just injected (no prior gesture stash).
            await new Promise((r) => setTimeout(r, 50));
            const resp = await chrome.tabs.sendMessage(
                tabId,
                { type: "CWSP_PASTE_INSERT", text },
                msgOpts
            );
            if (resp?.ok) return true;
        } catch {
            /* fall through */
        }
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: scriptTarget(opts),
            func: pageInsertFunc,
            args: [text],
        });
        return Boolean(results?.[0]?.result);
    } catch {
        return false;
    }
};

/**
 * Paste CWSP/OS content into the active editable + mirror to local clipboard.
 */
export const pasteByCwsp = async (
    tabId?: number,
    frameId?: number
): Promise<{ ok: boolean; error?: string; length?: number; source?: string }> => {
    const opts: PasteTabOpts = { tabId, frameId };
    const resolved = await resolveCwspPasteText(opts);
    const text = resolved.text;
    if (!text) {
        return { ok: false, error: resolved.error || "No clipboard content (CWSP or OS)" };
    }

    // WHY: WS paste-hold may already have text while Accept popup still shows —
    // dismiss Neutralino hold after we own the body (take path already accepted).
    const src = String(resolved.source || "");
    if (!src.startsWith("neutralino-take")) {
        void dismissNeutralinoInboundAsk();
    }

    // WHY: insert BEFORE COPY_HACK — copy path re-injects content script and can wipe lastEditable.
    let inserted = false;
    if (tabId != null && tabId >= 0) {
        inserted = await insertPasteIntoTab(opts, text);
    }

    await COPY_HACK(chrome, { ok: true, data: text as any }, tabId).catch(() => undefined);

    if (inserted) {
        return { ok: true, length: text.length, source: resolved.source };
    }

    return {
        ok: true,
        length: text.length,
        source: resolved.source,
        error: "Copied to clipboard (page insert unavailable — use Ctrl+V)",
    };
};

export const notifyCwspClipboard = notify;
