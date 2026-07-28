/**
 * CWSP-shell — Chrome Extension Service Worker
 *
 * Responsibilities:
 *  - Context menu setup (copy-as-*, CWSP share/paste, snip modes, markdown viewer, custom instructions)
 *  - Keyboard command handling (Ctrl+Shift+X/Y)
 *  - AI recognition message dispatch (gpt:recognize, gpt:solve, gpt:code, gpt:css, gpt:custom, gpt:translate)
 *  - Markdown URL detection & auto-redirect to viewer
 *  - CRX result pipeline (clipboard → content-script → popup → workcenter → notification)
 *  - CRX unified messaging + CWSP hub (localhost Neutralino or WAN as L-110-crx)
 *
 * Heavy capture/AI/clipboard logic is in `./service/api.ts`.
 */

// WHY: first import — alias missing `window` before Vite preload / Capacitor touch it.
import "./sw-window-polyfill";

import { createTimelineGenerator, requestNewTimeline } from "com/service/service/MakeTimeline";
import { COPY_HACK, enableCapture } from "./service/api";
import type { GPTResponses } from "com/service/model/GPT-Responses";
import type { CustomInstruction } from "com/service/instructions/CustomInstructions";
import { ensureCrxCwspSettingsSeeded, loadSettings } from "com/config/Settings";

import * as swAi from "./sw-ai-modules";
import type { ActionContext, ActionInput } from "com/service/misc/ActionHistory";
import { crxMessaging, registerCrxHandler, broadcastToCrxTabs } from "com/core/CrxMessaging";
import {
    CRX_SOLVE_AND_ANSWER_INSTRUCTION,
    CRX_WRITE_CODE_INSTRUCTION,
    CRX_EXTRACT_CSS_INSTRUCTION,
} from "com/core/BuiltInAI";
import { unifiedMessaging } from "com/core/UnifiedMessagingSw";
import { createInteropEnvelope } from "com/core/UniformInterop";
import { isUserScopePath } from "fest/core";
import { getCrxNetworkCoordinator } from "./network/Coordinator";
import {
    copyAndShareByCwsp,
    installCrxCwspClipboardHold,
    notifyCwspClipboard,
    pasteByCwsp,
} from "./network/cwsp-clipboard-actions";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const isInCrxEnvironment = crxMessaging.isCrxEnvironment();

if (isInCrxEnvironment) {
    // WHY: seed L-110-crx + maintain hub before first connect (shared local Neutralino backend).
    void (async () => {
        try {
            await ensureCrxCwspSettingsSeeded();
        } catch {
            /* seed best-effort */
        }
        ensureCwspContextMenus();
        installCrxCwspClipboardHold();
        await getCrxNetworkCoordinator().startFromStoredSettings().catch(() => undefined);
    })();
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

const TOAST_CHANNEL = "rs-toast";
const AI_RECOGNITION_CHANNEL = "rs-ai-recognition";
const POPUP_CHANNEL = "rs-popup";

const broadcast = (channel: string, message: unknown): void => {
    try { const bc = new BroadcastChannel(channel); bc.postMessage(message); bc.close(); }
    catch { /* ignore */ }
};

const showExtensionToast = (message: string, kind: "info" | "success" | "warning" | "error" = "info"): void =>
    broadcast(TOAST_CHANNEL, { type: "show-toast", options: { message, kind, duration: 3000 } });

// Keep a chronological fallback of the last known active tab for popup-facing APIs.
let lastKnownActiveTab: {
    tabId: number | null;
    windowId: number | null;
    title: string | null;
    url: string | null;
    updatedAt: number;
} | null = null;

const isContentTabCandidate = (tab?: chrome.tabs.Tab | null) => {
    if (!tab) return false;
    if (typeof tab.id !== "number" || tab.id < 0) return false;
    const url = tab.url || "";
    return !url.startsWith("chrome-extension://") && !url.startsWith("chrome://") && !url.startsWith("devtools://");
};

const normalizeTabForState = (tab?: chrome.tabs.Tab | null) => {
    if (!isContentTabCandidate(tab)) return null;
    return {
        tabId: tab.id,
        windowId: tab.windowId ?? null,
        title: tab.title ?? null,
        url: tab.url ?? null,
        updatedAt: Date.now(),
    };
};

const updateLastKnownActiveTab = (tab?: chrome.tabs.Tab | null) => {
    const next = normalizeTabForState(tab);
    if (!next) return;
    lastKnownActiveTab = next;
};

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!activeInfo || typeof activeInfo.tabId !== "number" || activeInfo.tabId < 0) return;
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (!isContentTabCandidate(tab)) return;
        updateLastKnownActiveTab(tab);
    } catch {
        lastKnownActiveTab = {
            tabId: activeInfo.tabId,
            windowId: activeInfo.windowId ?? null,
            title: null,
            url: null,
            updatedAt: Date.now(),
        };
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (!lastKnownActiveTab || lastKnownActiveTab.tabId !== tabId) return;
    lastKnownActiveTab = null;
});

const getChronologicalActiveTab = async () => {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true, lastFocusedWindow: true }).catch(() => []);
        const direct = tabs?.find(isContentTabCandidate);
        if (direct) {
            updateLastKnownActiveTab(direct);
            return normalizeTabForState(direct);
        }
        if (lastKnownActiveTab?.tabId != null) {
            const last = await chrome.tabs.get(lastKnownActiveTab.tabId).catch(() => null);
            if (isContentTabCandidate(last)) {
                updateLastKnownActiveTab(last);
                return normalizeTabForState(last);
            }
            lastKnownActiveTab = null;
        }
    } catch {
        /* ignore */
    }
    return lastKnownActiveTab ? { ...lastKnownActiveTab } : null;
};

const decodeBase64ToUint8 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

const requestUserFsViaActiveTab = async (payload: { action: "list" | "read-file"; path: string }) => {
    const active = await getChronologicalActiveTab();
    if (!active?.tabId || active.tabId < 0) {
        throw new Error("No active tab available for /user bridge");
    }
    return chrome.tabs.sendMessage(active.tabId, createInteropEnvelope({
        type: "request:crx-user-fs-bridge",
        source: "service-worker",
        destination: "content-script",
        target: "content-script",
        protocol: "chrome",
        transport: "chrome-tabs",
        purpose: ["invoke", "mail"],
        op: "invoke",
        data: {
            action: payload.action,
            path: payload.path
        },
        metadata: {
            bridge: "user-fs"
        }
    }));
};

// ---------------------------------------------------------------------------
// Clipboard shortcut
// ---------------------------------------------------------------------------

const requestClipboardCopy = async (data: unknown, showFeedback = true, tabId?: number): Promise<void> => {
    try {
        let resolvedTabId = tabId;
        if ((!resolvedTabId || resolvedTabId <= 0) && showFeedback) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
            resolvedTabId = tabs?.[0]?.id;
        }
        await COPY_HACK(chrome, { ok: true, data: data as any }, resolvedTabId);
    } catch (e) { console.warn("[SW] clipboard copy failed:", e); }
};

// ---------------------------------------------------------------------------
// Custom instructions helper
// ---------------------------------------------------------------------------

const loadCustomInstructions = async (): Promise<CustomInstruction[]> => {
    try { return await swAi.getCustomInstructions(); }
    catch { return []; }
};

// ---------------------------------------------------------------------------
// Execution core wrapper
// ---------------------------------------------------------------------------

const processChromeExtensionAction = async (
    input: ActionInput,
    sessionId?: string,
): Promise<{ success: boolean; result?: any; error?: string }> => {
    try {
        const context: ActionContext = {
            source: "chrome-extension",
            sessionId: sessionId || `crx_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        };
        const result = await swAi.executionCore.execute(input, context);
        if (result.type === "error") {
            return { success: false, error: result?.content || result?.error || "Processing failed", result };
        }
        return { success: true, result };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
};

// ============================================================================
// DIRECT CHROME MESSAGE HANDLING
// ============================================================================

if (isInCrxEnvironment && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message?.type) return false;

        // --- processCapture (direct) ---
        if (message.type === "processCapture") {
            (async () => {
                try {
                    const rect = message.data?.rect;
                    const opts: chrome.tabs.CaptureVisibleTabOptions & { rect?: any; scale?: number } = { format: "png", scale: 1 };
                    if (rect?.width > 0 && rect?.height > 0) opts.rect = rect;

                    const dataUrl = await new Promise<string>((resolve, reject) => {
                        chrome.tabs.captureVisibleTab(opts, (url) => {
                            chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(url);
                        });
                    });
                    const blob = await (await fetch(dataUrl)).blob();
                    const result = await swAi.recognizeImageData(blob);
                    sendResponse({ success: true, result });
                } catch (error) {
                    sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
                }
            })();
            return true;
        }

        // --- processText (direct) ---
        if (message.type === "processText") {
            sendResponse({ success: true, result: { type: "text", content: message.data?.content, processed: true } });
            return false;
        }

        return false;
    });
}

// ============================================================================
// CRX UNIFIED MESSAGING HANDLERS
// ============================================================================

if (isInCrxEnvironment) {
    registerCrxHandler("processImage", async (data: { imageData: string; mode: string; customInstructionId?: string }) => {
        const result = await processChromeExtensionAction({ type: "recognize", data: data.imageData, mode: data.mode as any, customInstructionId: data.customInstructionId });
        crxMessaging.sendRuntimeMessage({ type: "processingComplete", data: { result }, metadata: { progress: 100 } }).catch(() => {});
        return result;
    });

    registerCrxHandler("processCapture", async (data: any) =>
        processChromeExtensionAction({ type: "capture", data, mode: data.type?.toLowerCase().replace("capture_", "") || "recognize" })
    );

    registerCrxHandler("processText", async (data: { content: string; contentType: string }) =>
        processChromeExtensionAction({ type: "process", data: data.content, contentType: data.contentType })
    );

    registerCrxHandler("getProcessingStatus", async (data: { operationId: string }) =>
        ({ status: "completed", operationId: data.operationId })
    );

    registerCrxHandler("cancelProcessing", async (data: { operationId: string }) =>
        ({ cancelled: true, operationId: data.operationId })
    );
}

registerCrxHandler("getSettings", async () => { try { return await loadSettings(); } catch (e) { throw e; } });
registerCrxHandler("updateSettings", async (updates: any) => ({ success: true }));
registerCrxHandler("ping", async () => ({ status: "ok", context: "service-worker", timestamp: Date.now() }));

registerCrxHandler("broadcastResult", async (data: { result: any; type: string }) => {
    await broadcastToCrxTabs({ type: "ai-result", data: data.result, metadata: { source: "service-worker" } });
    broadcast(AI_RECOGNITION_CHANNEL, { type: data.type, result: data.result, timestamp: Date.now(), source: "crx-service-worker" });
    return { broadcasted: true };
});

// ============================================================================
// CRX RESULT PIPELINE
// ============================================================================

interface CrxResult {
    id: string;
    type: "text" | "image" | "markdown" | "processed";
    content: string | ArrayBuffer;
    source: "crx-snip" | "content-script" | "ai-processing";
    timestamp: number;
    metadata?: Record<string, any>;
}

interface CrxDestination {
    type: "clipboard" | "content-script" | "popup" | "workcenter" | "notification";
    tabId?: number;
    frameId?: number;
    options?: Record<string, any>;
}

interface PendingResult {
    id: string;
    result: CrxResult;
    destinations: CrxDestination[];
    status: "pending" | "processing" | "completed" | "failed";
    attempts: number;
    createdAt: number;
    completedAt?: number;
    error?: string;
}

class CrxResultPipeline {
    resultQueue: PendingResult[] = [];
    private maxQueueSize = 50;
    private maxRetries = 3;
    private interval: ReturnType<typeof setInterval> | null = null;

    constructor() { this.interval = globalThis.setInterval(() => this.processQueue(), 1000); }

    async enqueue(result: CrxResult, destinations: CrxDestination[]): Promise<string> {
        const pr: PendingResult = { id: crypto.randomUUID(), result, destinations, status: "pending", attempts: 0, createdAt: Date.now() };
        this.resultQueue.push(pr);
        if (this.resultQueue.length > this.maxQueueSize) this.resultQueue.shift();
        return pr.id;
    }

    getStatus() {
        const c = { pending: 0, processing: 0, completed: 0, failed: 0 };
        for (const r of this.resultQueue) c[r.status]++;
        return { queueSize: this.resultQueue.length, ...c };
    }

    getPending(dest?: string) {
        return this.resultQueue.filter((r) => r.status === "pending" && (!dest || r.destinations.some((d) => d.type === dest)));
    }

    clearCompleted() {
        const n = this.resultQueue.filter((r) => r.status === "completed").length;
        this.resultQueue = this.resultQueue.filter((r) => r.status !== "completed");
        return n;
    }

    destroy() { if (this.interval) clearInterval(this.interval); this.interval = null; this.resultQueue = []; }

    // --- internal ---

    private async processQueue() {
        for (const pr of this.resultQueue.filter((r) => r.status === "pending")) {
            pr.status = "processing";
            pr.attempts++;
            let anyOk = false;
            for (const dest of pr.destinations) {
                try { await this.deliver(pr.result, dest); anyOk = true; } catch { /* continue */ }
            }
            if (anyOk) { pr.status = "completed"; pr.completedAt = Date.now(); }
            else if (pr.attempts >= this.maxRetries) { pr.status = "failed"; pr.error = "All destinations failed"; }
            else pr.status = "pending";
        }
    }

    private async deliver(result: CrxResult, dest: CrxDestination) {
        const textContent = typeof result.content === "string" ? result.content : `[Binary ${(result.content as ArrayBuffer).byteLength} bytes]`;

        switch (dest.type) {
            case "clipboard":
                await requestClipboardCopy(textContent, dest.options?.showFeedback !== false, dest.tabId);
                break;

            case "content-script": {
                const msg = { type: "crx-result-delivered", result, destination: dest.type, timestamp: Date.now() };
                if (dest.tabId) await chrome.tabs.sendMessage(dest.tabId, msg, { frameId: dest.frameId });
                else await broadcastToCrxTabs(msg as any);
                break;
            }
            case "popup":
                broadcast(POPUP_CHANNEL, { type: "crx-result-delivered", result, destination: dest.type, timestamp: Date.now() });
                break;

            case "workcenter":
                try {
                    await unifiedMessaging.sendMessage({
                        id: result.id, type: "content-share", source: "crx-snip", destination: "workcenter",
                        contentType: result.type, data: { text: textContent, processed: true, source: result.source, metadata: result.metadata },
                        metadata: { title: `CRX-Snip ${result.type} Result`, timestamp: result.timestamp, source: result.source },
                    });
                } catch { throw new Error("WorkCenter delivery failed"); }
                break;

            case "notification":
                await chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: `CWSP-shell ${result.source}`, message: textContent.length > 100 ? textContent.slice(0, 100) + "..." : textContent });
                break;
        }
    }
}

const pipeline = new CrxResultPipeline();

// Cleanup on termination
self.addEventListener("beforeunload", () => pipeline.destroy());

// Pipeline convenience helpers
const enqueueText = (content: string, destinations: CrxDestination[]) =>
    pipeline.enqueue({ id: crypto.randomUUID(), type: "text", content, source: "crx-snip", timestamp: Date.now() }, destinations);

const processCrxSnipWithPipeline = async (
    content: string | ArrayBuffer,
    contentType = "text",
    extraDest: CrxDestination[] = [],
): Promise<{ success: boolean; resultId?: string; error?: string }> => {
    try {
        let processedContent: string | ArrayBuffer = content;
        let finalType = contentType;

        if ((contentType === "image" || content instanceof ArrayBuffer) && content instanceof ArrayBuffer) {
            const blob = new Blob([content], { type: "image/png" });
            const rec = await swAi.recognizeImageData(blob);
            processedContent = rec?.text || rec?.data || "";
            finalType = "text";
        }

        const input: ActionInput = {
            type: "process", content: processedContent, contentType: finalType as any,
            metadata: { source: "crx-snip", timestamp: Date.now(), background: true, originalType: contentType },
        };
        const result = await processChromeExtensionAction(input);

        if (result.success && result.result) {
            const crxResult: CrxResult = {
                id: crypto.randomUUID(), type: "processed",
                content: typeof result.result === "string" ? result.result : String(result.result),
                source: "crx-snip", timestamp: Date.now(),
            };
            const destinations: CrxDestination[] = [
                { type: "clipboard", options: { showFeedback: true } },
                { type: "content-script" },
                { type: "workcenter" },
                { type: "notification" },
                ...extraDest,
            ];
            const resultId = await pipeline.enqueue(crxResult, destinations);
            return { success: true, resultId };
        }
        return { success: false, error: result.error };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
};

// ============================================================================
// MARKDOWN VIEWER SUPPORT
// ============================================================================

const VIEWER_PAGE = "markdown/viewer.html";
const VIEWER_ORIGIN = chrome.runtime.getURL("");
const VIEWER_URL = chrome.runtime.getURL(VIEWER_PAGE);
const MARKDOWN_EXT_RE = /\.(?:md|markdown|mdown|mkd|mkdn|mdtxt|mdtext)(?:$|[?#])/i;
const MD_VIEW_MENU_ID = "crossword:markdown-view";

const looksLikeHtmlDocument = (text: string): boolean => {
    const trimmed = (text || "").trimStart().toLowerCase();
    return trimmed.startsWith("<!doctype html")
        || trimmed.startsWith("<html")
        || trimmed.startsWith("<head")
        || trimmed.startsWith("<body");
};

const isMarkdownUrl = (candidate?: string | null): candidate is string => {
    if (!candidate || typeof candidate !== "string") return false;
    try {
        const url = new URL(candidate);
        if (url.protocol === "chrome-extension:") return false;
        if (!["http:", "https:", "file:", "ftp:"].includes(url.protocol)) return false;
        // GitHub blob/tree pages are HTML views, not raw markdown assets.
        if (url.hostname === "github.com" && /(^|\/)(blob|tree)\//i.test(url.pathname)) return false;
        if (MARKDOWN_EXT_RE.test(url.pathname)) return true;
        if (url.hostname === "raw.githubusercontent.com" || url.hostname === "gist.githubusercontent.com") {
            if (MARKDOWN_EXT_RE.test(url.pathname)) return true;
            if (/(^|\/)readme(\.md)?($|[?#])/i.test(url.pathname)) return true;
        }
        return false;
    } catch { return false; }
};

const markdownRedirectCooldown = new Map<number, number>();
const MARKDOWN_REDIRECT_COOLDOWN_MS = 2500;

const shouldThrottleMarkdownRedirect = (tabId: number) => {
    const now = Date.now();
    const last = markdownRedirectCooldown.get(tabId) || 0;
    if (now - last < MARKDOWN_REDIRECT_COOLDOWN_MS) return true;
    markdownRedirectCooldown.set(tabId, now);
    return false;
};

const parseMarkdownHeaders = (details: chrome.webRequest.WebResponseHeadersDetails) => {
    const headers = details.responseHeaders || [];
    let contentType = "";
    let contentDisposition = "";
    for (const header of headers) {
        const name = String(header?.name || "").toLowerCase();
        const value = String(header?.value || "");
        if (!name) continue;
        if (name === "content-type") contentType = value.toLowerCase();
        if (name === "content-disposition") contentDisposition = value.toLowerCase();
    }

    const typeLooksMarkdown =
        contentType.includes("text/markdown")
        || contentType.includes("text/x-markdown")
        || contentType.includes("application/markdown")
        || contentType.includes("application/x-markdown");

    const dispositionHasMarkdownName = /filename\*?=.*\.(md|markdown|mdown|mkd|mkdn|mdtxt|mdtext)/i.test(contentDisposition);
    const plainTextWithMarkdownHint = contentType.includes("text/plain") && dispositionHasMarkdownName;

    return {
        typeLooksMarkdown,
        dispositionHasMarkdownName,
        plainTextWithMarkdownHint
    };
};

const isMarkdownContent = (text: string): boolean => {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) return false;
    if (/<[a-zA-Z][^>]*>/.test(trimmed)) return false;

    let score = 0, hits = 0;
    const patterns: [RegExp, number][] = [
        [/^---[\s\S]+?---/, 0.9], [/^#{1,6}\s+.+$/m, 0.8], [/^\s*[-*+]\s+\S+/m, 0.7],
        [/^\s*\d+\.\s+\S+/m, 0.7], [/`{1,3}[^`]*`{1,3}/, 0.6], [/\[([^\]]+)\]\(([^)]+)\)/, 0.5],
        [/!\[([^\]]+)\]\(([^)]+)\)/, 0.5], [/\*\*[^*]+\*\*/, 0.4], [/\*[^*]+\*/, 0.3],
    ];
    for (const [re, s] of patterns) { if (re.test(text)) { score += s; hits++; } }
    return hits >= 2 && score >= 0.8;
};

const isDefinitelyMarkdownResponse = (sourceUrl: string, text: string, contentType = ""): boolean => {
    if (!text?.trim() || looksLikeHtmlDocument(text)) return false;

    const ct = (contentType || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return false;
    if (ct.includes("text/markdown") || ct.includes("text/x-markdown")) return true;

    const pathname = (() => {
        try { return new URL(sourceUrl).pathname; } catch { return ""; }
    })();
    const hasMarkdownFileExt = MARKDOWN_EXT_RE.test(pathname);
    const hasMarkdownSyntax = isMarkdownContent(text);

    if (hasMarkdownSyntax) return true;
    // Extension alone can be spoofed; require plain text-ish response to trust it.
    if (hasMarkdownFileExt && (ct.includes("text/plain") || !ct)) return true;
    return false;
};

const toViewerUrl = (source?: string | null, markdownKey?: string | null) => {
    if (!source) return VIEWER_URL;
    const p = new URLSearchParams();
    const isFileUrl = source.startsWith("file:");
    // Never put file:// in the viewer query string: extension pages cannot fetch it, and
    // passing it may contribute to Chromium's "unique security origins" / nested file loads.
    if (!isFileUrl) {
        p.set("src", source);
    }
    if (markdownKey) p.set("mdk", markdownKey);
    if (isFileUrl) p.set("origin", "file");
    return `${VIEWER_URL}?${p}`;
};

const openViewer = (source?: string | null, tabId?: number, markdownKey?: string | null) => {
    const url = toViewerUrl(source ?? undefined, markdownKey);
    if (typeof tabId === "number") chrome.tabs.update(tabId, { url })?.catch?.(console.warn);
    else chrome.tabs.create({ url })?.catch?.(console.warn);
};

const createSessionKey = () => {
    try { return `md:${crypto.randomUUID()}`; }
    catch { return `md:${Date.now()}:${Math.random().toString(16).slice(2)}`; }
};

const markdownFallbackStorageKey = (key: string) => `md-fallback:${key}`;

const putMarkdownToSession = async (text: string) => {
    const key = createSessionKey();
    let stored = false;

    try {
        await chrome.storage?.session?.set?.({ [key]: text });
        stored = true;
    } catch {
        /* ignore */
    }

    try {
        await chrome.storage?.local?.set?.({
            [markdownFallbackStorageKey(key)]: {
                text,
                createdAt: Date.now()
            }
        });
        stored = true;
    } catch {
        /* ignore */
    }

    return stored ? key : null;
};

const fetchMarkdownText = async (candidate: string) => {
    const src = candidate;
    const res = await fetch(src, { credentials: "include", cache: "no-store" });
    const text = await res.text().catch(() => "");
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    return { ok: res.ok, status: res.status, src, text, contentType };
};

const openMarkdownInViewer = async (originalUrl: string, tabId: number) => {
    if (tabId > 0 && shouldThrottleMarkdownRedirect(tabId)) return true;
    if (originalUrl.startsWith("file:")) {
        const text = tabId > 0 ? await tryReadMarkdownFromTab(tabId, originalUrl) : "";
        const key = text ? await putMarkdownToSession(text) : null;
        openViewer(originalUrl, tabId, key);
        return true;
    }
    const fetched = await fetchMarkdownText(originalUrl).catch(() => null);
    if (!fetched || !fetched.ok || !fetched.text) return false;
    if (!isDefinitelyMarkdownResponse(fetched.src, fetched.text, fetched.contentType)) return false;
    const key = await putMarkdownToSession(fetched.text);
    openViewer(fetched.src, tabId, key);
    return true;
};

const tryReadMarkdownFromTab = async (tabId: number, url?: string) => {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (pageUrl: string) => {
                if (pageUrl.includes("github.com")) {
                    const rawBtn = document.querySelector("a[href*='raw']") as HTMLAnchorElement;
                    if (rawBtn?.href) return `__RAW_URL__${rawBtn.href}`;
                    const md = document.querySelector(".markdown-body");
                    if (md?.textContent?.trim()) return md.textContent.trim();
                }
                return document?.body?.innerText?.trim() || "";
            },
            args: [url || ""],
        });
        const val = results?.[0]?.result;
        if (typeof val === "string" && val.startsWith("__RAW_URL__")) {
            try { const r = await fetch(val.replace("__RAW_URL__", "")); if (r.ok) return await r.text(); } catch { /* fallback */ }
        }
        return typeof val === "string" ? val : "";
    } catch { return ""; }
};

// ============================================================================
// CONTEXT MENUS
// ============================================================================

const CTX_CONTEXTS = ["all", "page", "frame", "selection", "link", "editable", "image", "video", "audio", "action"] as const satisfies
    [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]];

const CTX_ITEMS = [
    { id: "copy-as-latex", title: "Copy as LaTeX" },
    { id: "copy-as-mathml", title: "Copy as MathML" },
    { id: "copy-as-markdown", title: "Copy as Markdown" },
    { id: "copy-as-html", title: "Copy as HTML" },
    { id: "START_SNIP", title: "Snip and Recognize (AI)" },
    { id: "SOLVE_AND_ANSWER", title: "Solve / Answer (AI)" },
    { id: "WRITE_CODE", title: "Write Code (AI)" },
    { id: "EXTRACT_CSS", title: "Extract CSS Styles (AI)" },
];

/** CWSP share/paste — bypass Neutralino/Android Share & Accept popups. */
const CWSP_CTX_COPY_SHARE = "cwsp-copy-and-share";
const CWSP_CTX_PASTE = "cwsp-paste";

/**
 * Chrome contextMenus treat a single `&` as a mnemonic accelerator (Windows-style),
 * so "Copy & Share" renders as "Copy  Share". Use `&&` for a literal ampersand.
 */
const CTX_MENU_AMP = "&&";

/**
 * Idempotent — safe on SW wake (onInstalled alone misses already-installed updates).
 * WHY: clipboard menus use hub WS + ecosystem token; Control pairing is Settings-only.
 */
const ensureCwspContextMenus = () => {
    const upsert = (
        id: string,
        title: string,
        contexts: chrome.contextMenus.ContextType[]
    ) => {
        try {
            chrome.contextMenus.update(id, { title, enabled: true }, () => {
                if (chrome.runtime.lastError) {
                    try {
                        chrome.contextMenus.create(
                            { id, title, contexts, enabled: true },
                            () => {
                                void chrome.runtime.lastError;
                            }
                        );
                    } catch {
                        /* unavailable */
                    }
                }
            });
        } catch {
            try {
                chrome.contextMenus.create({ id, title, contexts, enabled: true }, () => {
                    void chrome.runtime.lastError;
                });
            } catch {
                /* unavailable */
            }
        }
    };
    upsert(CWSP_CTX_COPY_SHARE, `Copy ${CTX_MENU_AMP} Share by CWSP`, ["selection"]);
    upsert(CWSP_CTX_PASTE, "Paste by CWSP", ["editable", "page", "frame"]);
};

const CUSTOM_PREFIX = "CUSTOM_INSTRUCTION:";
let customMenuIds: string[] = [];

const updateCustomInstructionMenus = async () => {
    for (const id of customMenuIds) { try { await chrome.contextMenus.remove(id); } catch { /* ignore */ } }
    customMenuIds = [];

    const enabled = (await loadCustomInstructions().catch(() => [])).filter((i) => i.enabled);
    if (!enabled.length) return;

    const sepId = "CUSTOM_SEP";
    try { chrome.contextMenus.create({ id: sepId, type: "separator", contexts: CTX_CONTEXTS }); customMenuIds.push(sepId); } catch { /* */ }
    for (const inst of enabled) {
        const id = `${CUSTOM_PREFIX}${inst.id}`;
        try { chrome.contextMenus.create({ id, title: `🎯 ${inst.label}`, contexts: CTX_CONTEXTS }); customMenuIds.push(id); } catch { /* */ }
    }
};

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["rs-settings"]) updateCustomInstructionMenus().catch(() => {});
});

// ============================================================================
// onInstalled — create context menus
// ============================================================================

chrome.runtime.onInstalled.addListener(() => {
    for (const item of CTX_ITEMS) {
        try { chrome.contextMenus.create({ id: item.id, title: item.title, visible: true, contexts: CTX_CONTEXTS }); } catch { /* */ }
    }
    try {
        chrome.contextMenus.create({
            id: MD_VIEW_MENU_ID, title: "Open in Markdown Viewer", contexts: ["link", "page"],
            targetUrlPatterns: ["*://*/*.md", "*://*/*.markdown", "file://*/*.md", "file://*/*.markdown"],
        });
    } catch { /* */ }

    // CRX-Snip context menus
    try { chrome.contextMenus.create({ id: "crx-snip-text", title: "Process Text with CWSP-shell (CRX-Snip)", contexts: ["selection"] }); } catch { /* */ }
    try {
        chrome.contextMenus.create({
            id: "crx-snip-screen",
            title: `Capture ${CTX_MENU_AMP} Process Screen Area (CRX-Snip)`,
            contexts: ["page", "frame", "editable"]
        });
    } catch { /* */ }

    ensureCwspContextMenus();

    updateCustomInstructionMenus().catch(() => {});
});

// ============================================================================
// Context menu click routing
// ============================================================================

const sendToTabOrActive = async (tabId: number | undefined, message: unknown) => {
    if (tabId != null && tabId >= 0) return chrome.tabs.sendMessage(tabId, message)?.catch?.(console.warn);
    const tabs = await chrome.tabs.query({ currentWindow: true, active: true })?.catch?.(() => []);
    for (const tab of tabs || []) {
        if (tab?.id != null && tab.id >= 0) return chrome.tabs.sendMessage(tab.id, message)?.catch?.(console.warn);
    }
};

chrome.contextMenus.onClicked.addListener((info, tab) => {
    const tabId = tab?.id;
    const menuId = String(info.menuItemId);

    // Snip / AI modes
    const snipMap: Record<string, string> = {
        START_SNIP: "START_SNIP", SOLVE_AND_ANSWER: "SOLVE_AND_ANSWER",
        WRITE_CODE: "WRITE_CODE", EXTRACT_CSS: "EXTRACT_CSS",
    };
    if (menuId in snipMap) { sendToTabOrActive(tabId, { type: snipMap[menuId] }); return; }

    // Custom instructions
    if (menuId.startsWith(CUSTOM_PREFIX)) {
        sendToTabOrActive(tabId, { type: "CUSTOM_INSTRUCTION", instructionId: menuId.slice(CUSTOM_PREFIX.length) });
        return;
    }

    // Markdown viewer
    if (menuId === MD_VIEW_MENU_ID) {
        const candidate = (info as any).linkUrl || (info as any).pageUrl;
        if (candidate && isMarkdownUrl(candidate)) {
            void openMarkdownInViewer(candidate, tabId ?? 0).then((opened) => {
                if (!opened) {
                    chrome.notifications.create({
                        type: "basic",
                        iconUrl: "icons/icon.png",
                        title: "CWSP-shell Markdown Viewer",
                        message: "Skipped: response is HTML or not confidently Markdown.",
                    });
                }
            });
            return;
        }
        openViewer(candidate, tabId);
        return;
    }

    // CRX-Snip text/screen via context menu
    if (menuId === "crx-snip-text" && info.selectionText) {
        processCrxSnipWithPipeline(info.selectionText, "text").then((r) => {
            chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: r.success ? "Text processed and copied!" : `Failed: ${r.error || "Unknown"}` });
        });
        return;
    }
    if (menuId === "crx-snip-screen") {
        (async () => {
            try {
                const imageData = await captureScreenArea();
                if (!imageData) { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: "Capture cancelled" }); return; }
                const r = await processCrxSnipWithPipeline(imageData, "image");
                chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: r.success ? "Captured and processed!" : `Failed: ${r.error || "Unknown"}` });
            } catch { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: "Capture failed" }); }
        })();
        return;
    }

    // CWSP Copy & Share — selection → local copy + clipboard:update (Share bypass)
    if (menuId === CWSP_CTX_COPY_SHARE) {
        void (async () => {
            let text = String(info.selectionText || "").trim();
            if (!text && tabId != null && tabId >= 0) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => (typeof window !== "undefined" ? window : globalThis)?.getSelection?.()?.toString?.() || "",
                    });
                    text = String(results?.[0]?.result || "").trim();
                } catch { /* ignore */ }
            }
            const r = await copyAndShareByCwsp(text, tabId);
            notifyCwspClipboard(
                "CWSP Share",
                r.ok ? "Copied & shared via CWSP" : (r.error || "Share failed")
            );
        })();
        return;
    }

    // CWSP Paste — OS stash / held inbound / peer clipboard → insert (Accept bypass)
    if (menuId === CWSP_CTX_PASTE) {
        void (async () => {
            const frameId = typeof info.frameId === "number" ? info.frameId : undefined;
            const r = await pasteByCwsp(tabId, frameId);
            notifyCwspClipboard(
                "CWSP Paste",
                r.ok
                    ? (r.error || `Pasted ${r.length || 0} chars${r.source ? ` (${r.source})` : ""}`)
                    : (r.error || "Paste failed")
            );
        })();
        return;
    }

    // Copy-as-* and other operations → forward to content script
    sendToTabOrActive(tabId, { type: menuId });
});

// ============================================================================
// Keyboard commands
// ============================================================================

chrome.commands.onCommand.addListener(async (command) => {
    if (command === "crx-snip-text") {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.id) return;
        try {
            const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: () => (typeof window != "undefined" ? window : globalThis)?.getSelection()?.toString() || "" });
            const text = results[0]?.result || "";
            if (text) {
                const r = await processCrxSnipWithPipeline(text, "text");
                chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: r.success ? "Text processed!" : `Failed: ${r.error}` });
            } else {
                chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: "Select text first, then Ctrl+Shift+X" });
            }
        } catch { /* ignore */ }
    } else if (command === "crx-snip-screen") {
        try {
            const imageData = await captureScreenArea();
            if (imageData) {
                const r = await processCrxSnipWithPipeline(imageData, "image");
                chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: r.success ? "Captured and processed!" : `Failed: ${r.error}` });
            } else {
                chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: "Capture cancelled" });
            }
        } catch { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell CRX-Snip", message: "Capture failed" }); }
    }
});

// ============================================================================
// Screen capture helper (tab capture + desktop capture fallback)
// ============================================================================

const captureScreenArea = async (options?: { rect?: { x: number; y: number; width: number; height: number }; scale?: number }): Promise<ArrayBuffer | null> => {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.id) throw new Error("No active tab");

        const opts: chrome.tabs.CaptureVisibleTabOptions & { rect?: any; scale?: number } = { format: "png", quality: 100, scale: options?.scale ?? 1 };
        if (options?.rect) opts.rect = options.rect;

        const screenshot = await chrome.tabs.captureVisibleTab(tabs[0].windowId, opts);
        const b64 = screenshot.split(",")[1];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    } catch {
        // Fallback: desktop capture via offscreen document
        try {
            const streamId = await new Promise<string>((resolve: (id: string) => void, reject: (error: Error) => void) => {
                chrome.desktopCapture.chooseDesktopMedia(["screen", "window"], (id) => id ? resolve(id) : reject(new Error("Cancelled")));
            });

            const offscreenUrl = chrome.runtime.getURL("offscreen/capture.html");
            const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
            if (!existing.length) {
                await chrome.offscreen.createDocument({ url: offscreenUrl, reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: "Screen capture" });
            }
            const response = await chrome.runtime.sendMessage({ type: "capture-desktop", streamId });
            return response?.success && response?.imageData ? response.imageData : null;
        } catch { return null; }
    }
};

// ============================================================================
// AI MESSAGE HANDLERS (gpt:recognize, gpt:solve, gpt:code, gpt:css, gpt:custom, gpt:translate)
// ============================================================================

/** Helper: process with GPT using a built-in instruction */
const processWithBuiltInInstruction = async (
    instruction: string,
    input: any,
    sender: chrome.runtime.MessageSender,
    mode: string,
    sendResponse: (r: any) => void,
) => {
    const requestId = `${mode}_${Date.now()}`;
    broadcast(AI_RECOGNITION_CHANNEL, { type: mode, requestId, status: "processing" });

    try {
        const gpt = await swAi.getGPTInstance();
        if (!gpt) { const err = { ok: false, error: "AI service not available" }; broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, mode, ...err }); sendResponse(err); return; }

        gpt.getPending?.()?.push?.({ type: "message", role: "user", content: [{ type: "input_text", text: instruction }, { type: "input_text", text: input || "" }] });
        const rawResponse = await gpt.sendRequest("high", "medium");
        const response = { ok: !!rawResponse, data: rawResponse || "", error: rawResponse ? undefined : "Failed" };

        broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, mode, ...response });
        if (response.ok && response.data) await requestClipboardCopy(response.data, true, sender?.tab?.id);
        sendResponse(response);
    } catch (e) {
        const err = { ok: false, error: String(e) };
        broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, mode, ...err });
        showExtensionToast(`${mode} failed: ${e}`, "error");
        sendResponse(err);
    }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type) return false;

    if (message.type === "crx:file-markdown-open") {
        (async () => {
            const source = String(message?.url || "").trim();
            const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : -1;
            if (!source || !source.startsWith("file:") || !isMarkdownUrl(source)) {
                sendResponse({ ok: false, error: "unsupported-source" });
                return;
            }
            if (tabId > 0 && shouldThrottleMarkdownRedirect(tabId)) {
                sendResponse({ ok: true, redirected: false, reason: "throttled" });
                return;
            }
            let text = typeof message?.text === "string" ? message.text : "";
            if (!text.trim() && tabId > 0) {
                text = await tryReadMarkdownFromTab(tabId, source);
            }
            if (!text.trim()) {
                const fetched = await fetchMarkdownText(source).catch(() => null);
                if (fetched?.ok && fetched.text?.trim()) {
                    text = fetched.text;
                }
            }
            const key = text.trim() ? await putMarkdownToSession(text) : null;
            openViewer(source, tabId > 0 ? tabId : undefined, key);
            sendResponse({ ok: true, redirected: true, key: key || null });
        })().catch((error) => {
            sendResponse({ ok: false, error: String(error) });
        });
        return true;
    }

    /** Open local markdown in the extension viewer without relying on a loaded file:// tab (e.g. popup paste). */
    if (message.type === "crx:open-markdown-file") {
        (async () => {
            const raw = String(message?.url || "").trim();
            if (!raw) {
                sendResponse({ ok: false, error: "missing-url" });
                return;
            }
            let fileUrl = raw;
            try {
                if (!/^file:/i.test(fileUrl)) {
                    sendResponse({ ok: false, error: "not-file-url" });
                    return;
                }
                fileUrl = new URL(fileUrl).href;
            } catch {
                sendResponse({ ok: false, error: "bad-url" });
                return;
            }
            if (!isMarkdownUrl(fileUrl)) {
                sendResponse({ ok: false, error: "not-markdown-path" });
                return;
            }
            const fetched = await fetchMarkdownText(fileUrl).catch(() => null);
            if (!fetched?.ok || !fetched.text?.trim()) {
                sendResponse({ ok: false, error: "fetch-failed", status: fetched?.status });
                return;
            }
            if (!isDefinitelyMarkdownResponse(fetched.src, fetched.text, fetched.contentType) && !MARKDOWN_EXT_RE.test(new URL(fileUrl).pathname)) {
                sendResponse({ ok: false, error: "not-markdown" });
                return;
            }
            const key = await putMarkdownToSession(fetched.text);
            if (!key) {
                sendResponse({ ok: false, error: "session-store-failed" });
                return;
            }
            let filename = "";
            try {
                filename = decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() || "");
            } catch { /* ignore */ }
            const viewer = `${VIEWER_URL}?${new URLSearchParams({
                mdk: key,
                origin: "file",
                ...(filename ? { filename } : {}),
            }).toString()}`;
            chrome.tabs.create({ url: viewer })?.catch?.(console.warn);
            sendResponse({ ok: true, key });
        })().catch((error) => {
            sendResponse({ ok: false, error: String(error) });
        });
        return true;
    }

    if (message.type === "crx-query-active-tab") {
        (async () => {
            const activeTab = await getChronologicalActiveTab();
            sendResponse({
                ok: true,
                tabId: activeTab?.tabId ?? null,
                windowId: activeTab?.windowId ?? null,
                title: activeTab?.title ?? null,
                url: activeTab?.url ?? null,
            });
        })().catch((error) => {
            sendResponse({ ok: false, error: String(error) });
        });
        return true;
    }

    // Timeline
    if (message.type === "MAKE_TIMELINE") {
        createTimelineGenerator(message.source || null, message.speechPrompt || null).then(async (gptRes) => {
            sendResponse(await (requestNewTimeline(gptRes as unknown as GPTResponses) as unknown as Promise<any[]> || []));
        }).catch((e: Error) => sendResponse({ error: e.message }));
        return true;
    }

    // gpt:recognize
    if (message.type === "gpt:recognize") {
        const requestId = message.requestId || `rec_${Date.now()}`;
        broadcast(AI_RECOGNITION_CHANNEL, { type: "recognize", requestId, status: "processing" });
        void (async () => {
            try {
                const { recognizeImageData } = swAi;
                await recognizeImageData(message.input, async (result: any) => {
                    const response = { ok: result?.ok, data: result?.raw, error: result?.error };
                    broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, ...response });
                    if (result?.ok && result?.raw && message.autoCopy !== false) {
                        const text = typeof result.raw === "string" ? result.raw : result.raw?.latex || result.raw?.text || JSON.stringify(result.raw);
                        await requestClipboardCopy(text, true);
                    }
                    sendResponse(response);
                });
            } catch (e) {
                const err = { ok: false, error: String(e) };
                broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, ...err });
                showExtensionToast(`Recognition failed: ${e}`, "error");
                sendResponse(err);
            }
        })();
        return true;
    }

    // gpt:solve / gpt:answer / gpt:solve-answer
    if (message.type === "gpt:solve" || message.type === "gpt:answer" || message.type === "gpt:solve-answer") {
        processWithBuiltInInstruction(CRX_SOLVE_AND_ANSWER_INSTRUCTION, message.input, sender, "solve-answer", sendResponse);
        return true;
    }

    // gpt:code
    if (message.type === "gpt:code") {
        processWithBuiltInInstruction(CRX_WRITE_CODE_INSTRUCTION, message.input, sender, "code", sendResponse);
        return true;
    }

    // gpt:css
    if (message.type === "gpt:css") {
        processWithBuiltInInstruction(CRX_EXTRACT_CSS_INSTRUCTION, message.input, sender, "css", sendResponse);
        return true;
    }

    // gpt:custom
    if (message.type === "gpt:custom") {
        (async () => {
            let instructionText = message.instruction;
            let instructionLabel = "Custom";
            if (!instructionText && message.instructionId) {
                const found = (await loadCustomInstructions().catch(() => [])).find((i) => i.id === message.instructionId);
                if (found) { instructionText = found.instruction; instructionLabel = found.label; }
            }
            if (!instructionText) { sendResponse({ ok: false, error: "No instruction found" }); return; }

            const requestId = message.requestId || `custom_${Date.now()}`;
            broadcast(AI_RECOGNITION_CHANNEL, { type: "custom", requestId, label: instructionLabel, status: "processing" });

            swAi.processDataWithInstruction(message.input, { instruction: instructionText, outputFormat: "auto", intermediateRecognition: { enabled: false } })
                .then(async (result) => {
                    const response = { ok: result?.ok, data: result?.data, error: result?.error };
                    broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, mode: "custom", label: instructionLabel, ...response });
                    if (result?.ok && result?.data && message.autoCopy !== false) await requestClipboardCopy(result.data, true, sender?.tab?.id);
                    sendResponse(response);
                }).catch((e: any) => {
                    const err = { ok: false, error: String(e) };
                    broadcast(AI_RECOGNITION_CHANNEL, { type: "result", requestId, mode: "custom", label: instructionLabel, ...err });
                    showExtensionToast(`${instructionLabel} failed: ${e}`, "error");
                    sendResponse(err);
                });
        })();
        return true;
    }

    // gpt:translate
    if (message.type === "gpt:translate") {
        (async () => {
            const inputText = message.input;
            const targetLang = message.targetLanguage || "English";
            if (!inputText?.trim()) { sendResponse({ ok: false, error: "No text" }); return; }

            const instruction = `Translate the following text to ${targetLang}.\nPreserve formatting (Markdown, KaTeX, code blocks, etc.).\nOnly translate natural language, keep technical notation unchanged.\nReturn ONLY the translated text.`;
            try {
                const settings = await loadSettings();
                const ai = (await settings)?.ai;
                if (!ai?.apiKey) { sendResponse({ ok: false, error: "No API key configured" }); return; }

                const baseUrl = ai.baseUrl || "https://api.proxyapi.ru/openai/v1";
                const model = ai.model || "gpt-5.6-luna";
                const res = await fetch(`${baseUrl}/responses`, {
                    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
                    body: JSON.stringify({ model, input: inputText, instructions: instruction, reasoning: { effort: "low" }, text: { verbosity: "low" } }),
                });
                if (!res.ok) throw new Error(`Translation API: ${res.status}`);
                const data = await res.json();
                sendResponse({ ok: true, data: data?.output?.at?.(-1)?.content?.[0]?.text || inputText });
            } catch (e) { sendResponse({ ok: false, error: String(e), data: inputText }); }
        })();
        return true;
    }

    // share-target
    if (message.type === "share-target") {
        const { title, text, url, files } = message.data || {};
        chrome.storage?.local?.set?.({ "rs-share-target-data": { title, text, url, files: files?.map?.((f: File) => f.name) || [], timestamp: Date.now() } }).catch(() => {});
        broadcast("rs-share-target", { type: "share-received", data: { title, text, url, timestamp: Date.now() } });
        showExtensionToast("Content received", "info");
        sendResponse({ ok: true });
        return true;
    }

    return false;
});

// ============================================================================
// Markdown auto-detection (webNavigation)
// ============================================================================

chrome.webNavigation?.onCommitted?.addListener?.((details) => {
    if (details.frameId !== 0) return;
    const { tabId, url } = details;
    if (!isMarkdownUrl(url) || url.startsWith(VIEWER_ORIGIN) || url.startsWith("file:")) return;
    void openMarkdownInViewer(url, tabId);
});

chrome.webNavigation?.onHistoryStateUpdated?.addListener?.((details) => {
    if (details.frameId !== 0) return;
    const { tabId, url } = details;
    if (!isMarkdownUrl(url) || url.startsWith(VIEWER_ORIGIN)) return;
    void openMarkdownInViewer(url, tabId);
});

chrome.webNavigation?.onCompleted?.addListener?.((details) => {
    (async () => {
        if (details.frameId !== 0) return;
        const { tabId, url } = details;
        if (!isMarkdownUrl(url) || url.startsWith(VIEWER_ORIGIN) || !url.startsWith("file:")) return;
        const text = await tryReadMarkdownFromTab(tabId, url);
        const key = text ? await putMarkdownToSession(text) : null;
        openViewer(url, tabId, key);
    })().catch(console.warn);
});

chrome.webRequest?.onHeadersReceived?.addListener?.((details: chrome.webRequest.WebResponseHeadersDetails) => {
    if (details?.tabId < 0) return;
    if (!details?.url || details?.url?.startsWith(VIEWER_ORIGIN)) return;
    // file:// is handled by onCompleted + session preload; headers here can race and
    // duplicate redirects with empty body reads.
    if (details?.url?.startsWith("file:")) return;
    if (details?.type !== "main_frame") return;

    const markdownHint = parseMarkdownHeaders(details);
    if (!markdownHint.typeLooksMarkdown && !markdownHint.plainTextWithMarkdownHint) return;

    void openMarkdownInViewer(details?.url, details?.tabId);
}, {
    urls: ["<all_urls>"],
    types: ["main_frame"]
}, ["responseHeaders", "extraHeaders"]);

// ============================================================================
// CRX-Snip and pipeline message handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
        // CRX-Snip processing
        if (message?.type === "crx-snip") {
            if (!message.content) { sendResponse({ success: false, error: "missing content" }); return; }
            sendResponse(await processCrxSnipWithPipeline(message.content, message.contentType || "text"));
            return;
        }

        // Screen capture trigger from popup
        if (message?.type === "crx-snip-screen-capture") {
            try {
                const imageData = await captureScreenArea(message.rect ? { rect: message.rect, scale: message.scale || 1 } : undefined);
                if (imageData) { sendResponse(await processCrxSnipWithPipeline(imageData, "image")); }
                else sendResponse({ success: false, error: "Capture cancelled" });
            } catch (e) { sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }); }
            return;
        }

        // Pipeline management
        if (message?.type === "crx-pipeline-status") { sendResponse({ success: true, status: pipeline.getStatus() }); return; }
        if (message?.type === "crx-pipeline-pending") { sendResponse({ success: true, pending: pipeline.getPending(message.destinationType) }); return; }
        if (message?.type === "crx-pipeline-clear-completed") { sendResponse({ success: true, clearedCount: pipeline.clearCompleted() }); return; }

        if (message?.type === "crx-result-send-to-destination") {
            const pr = pipeline.resultQueue.find((r) => r.id === message.resultId);
            if (!pr || !message.destination) { sendResponse({ success: false, error: "Not found" }); return; }
            pr.destinations.push(message.destination);
            if (pr.status === "completed") pr.status = "pending";
            sendResponse({ success: true, resultId: message.resultId });
            return;
        }

        if (message?.type === "crx:user-fs:request") {
            const action = (message?.action || "").trim();
            const path = (message?.path || "").trim();
            if (!isUserScopePath(path)) {
                sendResponse({ ok: false, error: "Only /user/* path is supported" });
                return;
            }
            if (action === "list") {
                sendResponse(await requestUserFsViaActiveTab({ action: "list", path }));
                return;
            }
            if (action === "read-file") {
                sendResponse(await requestUserFsViaActiveTab({ action: "read-file", path }));
                return;
            }
            sendResponse({ ok: false, error: `Unknown action: ${action}` });
            return;
        }

        if (message?.type === "crx:user-fs:fetch") {
            const path = (message?.path || "").trim();
            if (!isUserScopePath(path)) {
                sendResponse({ ok: false, status: 400, error: "Only /user/* path is supported" });
                return;
            }
            if (path.endsWith("/") || path === "/user") {
                const listed = await requestUserFsViaActiveTab({ action: "list", path });
                sendResponse({
                    ok: Boolean(listed?.ok),
                    status: listed?.ok ? 200 : 404,
                    contentType: "application/json",
                    bodyText: JSON.stringify(listed?.ok ? { path, entries: listed.entries || [] } : listed)
                });
                return;
            }
            const read = await requestUserFsViaActiveTab({ action: "read-file", path });
            if (!read?.ok || !read?.file?.base64) {
                sendResponse({ ok: false, status: 404, error: read?.error || "File not found" });
                return;
            }
            const bytes = decodeBase64ToUint8(read.file.base64);
            sendResponse({
                ok: true,
                status: 200,
                contentType: read.file.type || "application/octet-stream",
                file: {
                    name: read.file.name,
                    size: read.file.size,
                    lastModified: read.file.lastModified
                },
                bodyBase64: read.file.base64,
                bodyBytes: bytes.buffer
            });
            return;
        }

        // Markdown loading
        if (message?.type === "md:load") {
            const src = typeof message.src === "string" ? message.src : "";
            if (!src) { sendResponse({ ok: false, error: "missing src" }); return; }
            if (/^file:/i.test(src)) {
                sendResponse({ ok: false, src, error: "file-source" });
                return;
            }
            const fetched = await fetchMarkdownText(src);
            if (!fetched.ok || !fetched.text) {
                sendResponse({ ok: false, status: fetched.status, src: fetched.src, error: "fetch-failed" });
                return;
            }
            if (!isDefinitelyMarkdownResponse(fetched.src, fetched.text, fetched.contentType)) {
                sendResponse({ ok: false, status: fetched.status, src: fetched.src, error: "not-markdown" });
                return;
            }
            const key = await putMarkdownToSession(fetched.text);
            sendResponse({ ok: true, status: fetched.status, src: fetched.src, key });
            return;
        }
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
});

// ============================================================================
// Enable capture handlers from service/api.ts
// ============================================================================

enableCapture(chrome);
