/**
 * CRX Service API
 *
 * Handles all service-worker-side operations:
 *  - Tab capture (screenshot) with optional crop rect
 *  - AI processing pipeline (recognize, solve, code, css, custom)
 *  - Clipboard copy (COPY_HACK multi-fallback)
 *  - Markdown loading with URL normalization
 *  - Runtime channel message routing
 */

import { ableToShowImage, encodeWithJSquash, removeAnyPrefix } from "core/workers/ImageProcess";
import type { RecognizeResult } from "com/service/service/RecognizeData";
import { toText } from "./sw-text";
import * as swAiMod from "../sw-ai-modules";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Compress images larger than 2 MB */
const SIZE_THRESHOLD = 2 * 1024 * 1024;

const MARKDOWN_EXT_RE = /\.(?:md|markdown|mdown|mkd|mkdn|mdtxt|mdtext)(?:$|[?#])/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnipMode = "recognize" | "solve" | "code" | "css" | "custom";

interface CaptureOptions {
    rect?: { x: number; y: number; width: number; height: number };
    scale?: number;
}

interface CaptureResult {
    ok: boolean;
    data?: string;
    error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isProbablyUrl = (v: string) => { try { return Boolean(new URL(v)); } catch { return false; } };

const formatRuntimeError = (e: unknown): string => {
    if (e instanceof Error) {
        const firstStackLine = e.stack?.split?.("\n")?.[1]?.trim?.();
        return firstStackLine ? `${e.name}: ${e.message} @ ${firstStackLine}` : `${e.name}: ${e.message}`;
    }
    return String(e);
};

const dataUrlToFile = async (dataUrl: string, name = "snip.png"): Promise<File | Blob> => {
    try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        try { return new File([blob], name, { type: blob.type || "image/png", lastModified: Date.now() }); }
        catch { return blob; }
    } catch {
        return new Blob([dataUrl], { type: "text/plain" });
    }
};

const compressIfNeeded = async (dataUrl: string): Promise<string> => {
    if (dataUrl.length <= SIZE_THRESHOLD) return dataUrl;
    try {
        // @ts-ignore — Uint8Array.fromBase64/toBase64 available in modern Chrome
        const binary = Uint8Array.fromBase64(removeAnyPrefix(dataUrl), { alphabet: "base64" });
        const blob = new Blob([binary], { type: "image/png" });
        const bitmap = await createImageBitmap(blob);
        const ab = await encodeWithJSquash(bitmap);
        bitmap?.close?.();
        if (ab) {
            // @ts-ignore
            return `data:image/jpeg;base64,${new Uint8Array(ab).toBase64({ alphabet: "base64" })}`;
        }
    } catch (e) {
        console.warn("[api] compression failed:", e);
    }
    return dataUrl;
};

/** Best-available timing function (RAF → setTimeout → immediate) */
const schedule = (() => {
    if (typeof requestAnimationFrame !== "undefined") return requestAnimationFrame;
    if (typeof setTimeout !== "undefined") return (cb: () => void) => setTimeout(cb, 0);
    return (cb: () => void) => cb();
})();

/** Extract meaningful text from an AI recognition result */
const extractRecognizedText = (result: RecognizeResult): string => {
    if (typeof result === "string") return result;
    if (!result?.ok) return "";

    let text = result.data;
    if (text && typeof text !== "string") {
        try { text = JSON.stringify(text); } catch { text = String(text); }
    }
    if (!text) return "";

    // Try to unwrap JSON wrappers
    if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        try {
            const p = JSON.parse(text);
            const candidate =
                p?.recognized_data ?? p?.data ?? p?.text;
            if (typeof candidate === "string") return candidate.trim();
            if (candidate != null) return JSON.stringify(candidate);
        } catch { /* not JSON */ }
    }
    return (typeof text === "string" ? text : String(text)).trim();
};

// ---------------------------------------------------------------------------
// Unified Tab Capture
// ---------------------------------------------------------------------------

/**
 * Capture the visible tab as a data-URL, optionally cropped.
 * Compresses large images and validates the result.
 */
const captureVisibleTab = async (options?: CaptureOptions): Promise<string> => {
    const captureOpts: { format: "png" | "jpeg"; quality?: number; rect?: any; scale?: number } = {
        format: "png",
        scale: options?.scale ?? 1,
    };
    if (options?.rect && options.rect.width > 0 && options.rect.height > 0) {
        captureOpts.rect = options.rect;
    }

    const dataUrl = await new Promise<string>((resolve, reject) => {
        chrome.tabs.captureVisibleTab(captureOpts, (url) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(url);
        });
    });

    let finalUrl = await compressIfNeeded(dataUrl);
    if (!finalUrl || !(await ableToShowImage(finalUrl))) finalUrl = dataUrl;
    return finalUrl;
};

// ---------------------------------------------------------------------------
// Unified AI processing
// ---------------------------------------------------------------------------

const dispatchAi = async (mode: SnipMode, file: File | Blob): Promise<CaptureResult> => {
    if (mode === "solve") return swAiMod.solveAndAnswer(file) as Promise<CaptureResult>;
    if (mode === "code") return swAiMod.writeCode(file) as Promise<CaptureResult>;
    if (mode === "css") return swAiMod.extractCSS(file) as Promise<CaptureResult>;
    return swAiMod.recognizeImageData(file) as Promise<CaptureResult>;
};

/**
 * Capture visible tab + run AI processing + copy result to clipboard.
 * Handles all modes (recognize, solve, code, css, custom).
 */
const captureAndProcess = async (
    ext: typeof chrome,
    rect: CaptureOptions["rect"],
    mode: SnipMode = "recognize",
    extra?: { instructionId?: string; sender?: chrome.runtime.MessageSender },
): Promise<CaptureResult> => {
    // 1. Screenshot
    const imageUrl = await captureVisibleTab({ rect });

    // 2. Convert to file
    const file = await dataUrlToFile(imageUrl, "snip.png");

    // 3. Process
    let result: CaptureResult;

    if (mode === "custom" && extra?.instructionId) {
        const instructions = await swAiMod.getCustomInstructions().catch(() => []);
        const instruction = instructions.find((i) => i.id === extra.instructionId);
        if (!instruction) return { ok: false, error: "Custom instruction not found" };

        const input = [{
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: imageUrl }],
        }];
        const raw = await swAiMod.recognizeByInstructions(input, instruction.instruction);
        const text = extractRecognizedText(raw);
        result = {
            ok: raw?.ok ?? !!text,
            data: text,
            error: raw?.error || (!text ? `${instruction.label} failed` : undefined),
        };
    } else {
        result = await dispatchAi(mode, file);
    }

    // 4. Copy to clipboard
    if (result.ok && result.data) {
        await COPY_HACK(ext, result, extra?.sender?.tab?.id).catch(console.warn);
    }

    return result;
};

// ---------------------------------------------------------------------------
// Runtime channel handlers (for createRuntimeChannelModule calls)
// ---------------------------------------------------------------------------

const handleCapture = (ext: typeof chrome, data: any, sender: any) =>
    captureAndProcess(ext, data.rect, data.mode || "recognize", { sender });

const handleCaptureScreenshot = async (_ext: typeof chrome, data: any) => {
    const imageUrl = await captureVisibleTab({ rect: data.rect });
    return { ok: true, data: imageUrl, imageData: imageUrl };
};

const handleProcessImage = async (ext: typeof chrome, data: any, sender: any) => {
    const imageData = data.imageData;
    const mode: SnipMode = data.mode || "recognize";
    const file = typeof imageData === "string" ? await dataUrlToFile(imageData) : imageData;

    const result = await dispatchAi(mode, file);

    if (result.ok && result.data) {
        await COPY_HACK(ext, result, sender?.tab?.id).catch(console.warn);
    }
    return result;
};

const handleProcessText = async (_ext: typeof chrome, data: any) =>
    swAiMod.recognizeImageData(new Blob([data.content], { type: "text/plain" }));

const handleDoCopy = async (ext: typeof chrome, data: any) => {
    const result = await COPY_HACK(ext, data.data, data.tabId);
    return { success: result?.ok || false };
};

const handleCaptureWithRect = async (data: any) =>
    ({ status: "rect_selection_required", mode: data.mode } as const);

// ---------------------------------------------------------------------------
// Markdown loader (service-worker-side)
// ---------------------------------------------------------------------------

const normalizeSourceUrl = (candidate: string): string => {
    try {
        const u = new URL(candidate);

        // GitHub blob → raw.githubusercontent.com
        if (u.hostname === "github.com") {
            const parts = u.pathname.split("/").filter(Boolean);
            const idx = parts.indexOf("blob") === 2 ? 2 : parts.indexOf("raw") === 2 ? 2 : -1;
            if (parts.length >= 5 && idx === 2) {
                return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts[3]}/${parts.slice(4).join("/")}`;
            }
        }

        // GitLab blob → raw
        if (u.hostname.endsWith("gitlab.com")) {
            const parts = u.pathname.split("/").filter(Boolean);
            const di = parts.indexOf("-");
            if (di >= 0 && parts[di + 1] === "blob") {
                return `https://${u.hostname}/${parts.slice(0, di).join("/")}/-/raw/${parts[di + 2] || ""}/${parts.slice(di + 3).join("/")}`;
            }
        }

        // Bitbucket — ?raw=1
        if (u.hostname === "bitbucket.org") {
            if (!u.searchParams.has("raw")) u.searchParams.set("raw", "1");
            return u.toString();
        }

        return u.toString();
    } catch { return candidate; }
};

const looksLikeHtmlDocument = (text: string): boolean => {
    const t = (text || "").trimStart().toLowerCase();
    return t.startsWith("<!doctype html") || t.startsWith("<html") || t.startsWith("<head") || t.startsWith("<body");
};

const looksLikeMarkdown = (text: string): boolean => {
    const t = (text || "").trim();
    if (!t || looksLikeHtmlDocument(t)) return false;
    let hits = 0;
    if (/^#{1,6}\s+.+$/m.test(t)) hits++;
    if (/^\s*[-*+]\s+\S+/m.test(t)) hits++;
    if (/^\s*\d+\.\s+\S+/m.test(t)) hits++;
    if (/```[\s\S]*?```/.test(t)) hits++;
    if (/\[([^\]]+)\]\(([^)]+)\)/.test(t)) hits++;
    return hits >= 2;
};

const guessLanguage = (url: URL): string => {
    const ext = ((url.pathname.split("/").pop() || "").split(".").pop() || "").toLowerCase();
    const map: Record<string, string> = {
        ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", json: "json",
        css: "css", scss: "scss", html: "html", htm: "html", xml: "xml",
        yml: "yaml", yaml: "yaml", py: "py", sh: "sh", go: "go", rs: "rs", java: "java",
    };
    return map[ext] || "";
};

const handleLoadMarkdown = async (src: string) => {
    let text = "";
    let normalizedSrc: string | undefined;

    try {
        normalizedSrc = normalizeSourceUrl(src);
        const u = new URL(normalizedSrc);
        const res = await fetch(u.href, { credentials: "include", cache: "no-store", headers: { accept: "text/markdown,text/plain,*/*" } });
        if (!res.ok) return { error: `Failed to load: ${res.status}` };

        text = await res.text();

        if (!looksLikeHtmlDocument(text)) {
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            const isMd = MARKDOWN_EXT_RE.test(u.pathname) || ct.includes("text/markdown") || looksLikeMarkdown(text);
            if (!isMd) {
                const lang = guessLanguage(u);
                text = `\`\`\`${lang}\n${text.replace(/\r\n/g, "\n")}\n\`\`\`\n`;
            }
        }
    } catch {
        text = src; // not a URL — treat as raw markdown
    }

    const key = `md_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await chrome.storage.session.set({ [key]: text });
    return { key, src: isProbablyUrl(normalizedSrc || src) ? (normalizedSrc || src) : undefined };
};

// ---------------------------------------------------------------------------
// COPY_HACK — multi-fallback clipboard write
// ---------------------------------------------------------------------------

export const COPY_HACK = async (
    ext: typeof chrome,
    data: { ok?: boolean; data?: string; error?: string },
    tabId?: number,
): Promise<{ ok: boolean; error?: string }> => {
    const text = toText(data?.data).trim();
    if (!text) return { ok: false, error: "Empty content" };

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        schedule(async () => {
            // 1. Content-script on specified tab
            if (tabId && tabId > 0) {
                try {
                    const tab = await ext.tabs.get(tabId).catch(() => null);
                    if (tab) {
                        await ext.scripting.executeScript({ target: { tabId }, files: ["content/main.ts"] }).catch(() => {});
                        const r = await ext.tabs.sendMessage(tabId, { type: "COPY_HACK", data: text });
                        if (r?.ok) return resolve({ ok: true });
                    }
                } catch { /* continue */ }
            }

            // 2. Offscreen document
            try {
                const offscreenUrl = "offscreen/copy.html";
                const existing = await ext.runtime.getContexts?.({
                    contextTypes: [ext.runtime.ContextType.OFFSCREEN_DOCUMENT as any],
                    documentUrls: [ext.runtime.getURL(offscreenUrl)],
                })?.catch?.(() => []);

                if (!existing?.length) {
                    await ext.offscreen.createDocument({
                        url: offscreenUrl,
                        reasons: [ext.offscreen.Reason.CLIPBOARD],
                        justification: "Clipboard access for copied text",
                    });
                    await new Promise((r) => setTimeout(r, 500));
                }
                const r = await ext.runtime.sendMessage({ target: "offscreen", type: "COPY_HACK", data: text });
                if (r?.ok) return resolve({ ok: true });
            } catch { /* continue */ }

            // 3. Any available tab
            try {
                const tabs = await ext.tabs.query({}).catch(() => []);
                for (const tab of tabs || []) {
                    if (tab?.id && tab.id !== tabId) {
                        try {
                            await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/main.ts"] }).catch(() => {});
                            const r = await ext.tabs.sendMessage(tab.id, { type: "COPY_HACK", data: text });
                            if (r?.ok) return resolve({ ok: true });
                        } catch { /* next tab */ }
                    }
                }
            } catch { /* continue */ }

            // 4. Direct clipboard API (service worker — limited support)
            try {
                if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                    return resolve({ ok: true });
                }
            } catch { /* continue */ }

            resolve({ ok: false, error: "All clipboard methods failed" });
        });
    });
};

/**
 * Read OS clipboard text (offscreen preferred; content-script fallback).
 * Used by Paste by CWSP when CWSP peers return empty.
 */
export const READ_CLIPBOARD = async (
    ext: typeof chrome,
    tabId?: number,
): Promise<{ ok: boolean; data?: string; error?: string }> => {
    // 1. Offscreen (has clipboardRead + focused document)
    try {
        const offscreenUrl = "offscreen/copy.html";
        const existing = await ext.runtime.getContexts?.({
            contextTypes: [ext.runtime.ContextType.OFFSCREEN_DOCUMENT as any],
            documentUrls: [ext.runtime.getURL(offscreenUrl)],
        })?.catch?.(() => []);

        if (!existing?.length) {
            await ext.offscreen.createDocument({
                url: offscreenUrl,
                reasons: [ext.offscreen.Reason.CLIPBOARD],
                justification: "Read clipboard for Paste by CWSP",
            });
            await new Promise((r) => setTimeout(r, 400));
        }
        const r = await ext.runtime.sendMessage({ target: "offscreen", type: "READ_HACK" });
        if (r?.ok && typeof r.data === "string" && r.data.length) {
            return { ok: true, data: r.data };
        }
        if (r && r.ok === false && r.error) {
            // keep trying other paths
        }
    } catch {
        /* continue */
    }

    // 2. Active tab content script
    if (tabId && tabId > 0) {
        try {
            const r = await ext.tabs.sendMessage(tabId, { type: "READ_HACK" });
            if (r?.ok && typeof r.data === "string" && r.data.length) {
                return { ok: true, data: r.data };
            }
        } catch {
            /* continue */
        }
    }

    // 3. Direct (rarely works in SW)
    try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
            const text = await navigator.clipboard.readText();
            if (typeof text === "string" && text.length) {
                return { ok: true, data: text };
            }
        }
    } catch {
        /* continue */
    }

    return { ok: false, error: "Could not read OS clipboard" };
};

// ---------------------------------------------------------------------------
// Public: enableCapture — registers message listeners on service worker
// ---------------------------------------------------------------------------

/**
 * Register all capture/processing/markdown message listeners on the service worker.
 * Called once from sw.ts at startup.
 */
export const enableCapture = (ext: typeof chrome) => {
    ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        // ---- Runtime channel messages (from createRuntimeChannelModule) ----
        if (msg?.id?.startsWith("crx_") && msg?.type && msg?.data) {
            (async () => {
                try {
                    const route: Record<string, () => Promise<any>> = {
                        capture: () => handleCapture(ext, msg.data, sender),
                        captureScreenshot: () => handleCaptureScreenshot(ext, msg.data),
                        processImage: () => handleProcessImage(ext, msg.data, sender),
                        processText: () => handleProcessText(ext, msg.data),
                        doCopy: () => handleDoCopy(ext, msg.data),
                        loadMarkdown: () => handleLoadMarkdown(msg.data),
                        captureWithRect: () => handleCaptureWithRect(msg.data),
                    };
                    const handler = route[msg.type];
                    sendResponse(handler ? await handler() : { ok: false, error: `Unknown method: ${msg.type}` });
                } catch (e) {
                    sendResponse({ ok: false, error: formatRuntimeError(e) });
                }
            })();
            return true;
        }

        // ---- Legacy direct messages (CAPTURE / CAPTURE_SOLVE / etc.) ----
        const CAPTURE_MODES: Record<string, SnipMode> = {
            CAPTURE: "recognize",
            CAPTURE_SOLVE: "solve",
            CAPTURE_ANSWER: "solve",
            CAPTURE_CODE: "code",
            CAPTURE_CSS: "css",
            CAPTURE_CUSTOM: "custom",
        };

        if (msg?.type && msg.type in CAPTURE_MODES) {
            const mode = CAPTURE_MODES[msg.type];
            (async () => {
                try {
                    const result = await captureAndProcess(ext, msg.rect, mode, {
                        instructionId: msg.instructionId,
                        sender,
                    });
                    sendResponse(result);
                } catch (e) {
                    sendResponse({ ok: false, error: formatRuntimeError(e) });
                }
            })();
            return true;
        }

        // ---- Download ----
        if (msg?.type === "DOWNLOAD" && msg.dataUrl) {
            chrome.downloads.download(
                { url: msg.dataUrl, filename: "snip.png", saveAs: true },
                (id) => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message, dataUrl: msg.dataUrl });
                    } else {
                        sendResponse({ ok: true, id });
                    }
                },
            );
            return true;
        }

        return false;
    });
};
