/**
 * CWSP-shell — Content Script Entry
 *
 * Injected into every page at document_start.
 * Handles:
 *  - Overlay + toast initialization
 *  - Copy-as-* operations (LaTeX, MathML, Markdown, HTML)
 *  - Snip & recognize (rect selection → capture → AI)
 *  - Rect-selector global registration
 *  - CRX result pipeline delivery (notifications)
 *  - Coordinate / element tracking for context-menu operations
 */

import { showToast, initOverlay } from "boot/ts/overlay";
import { copyAsHTML, copyAsMathML, copyAsMarkdown, copyAsTeX } from "core/document/Conversion";
import { isUserScopePath, toUserRelativePath } from "fest/core";

// Content-script modules
import "./copy";           // COPY_HACK handler
import "./paste-cwsp";     // CWSP_PASTE_INSERT (Paste by CWSP context menu)
import "./rect-selector";  // global crxSnipSelectRect
import "./snip";           // START_SNIP / SOLVE_AND_ANSWER / WRITE_CODE / EXTRACT_CSS / CUSTOM_INSTRUCTION

// ---------------------------------------------------------------------------
// Init overlay & broadcast receivers
// ---------------------------------------------------------------------------

// Overlay: injects shared styles + toast/clipboard receivers only; DOM nodes are created on demand.
initOverlay();

// ---------------------------------------------------------------------------
// Coordinate / element tracking (for context-menu hit-testing)
// ---------------------------------------------------------------------------

const coordinate: [number, number] = [0, 0];
let lastElement: HTMLElement | null = null;
let selectionNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastSelectionKey = "0";
const notifySelectionState = () => {
    const selectedText = (typeof window != "undefined" ? window : globalThis)?.getSelection?.()?.toString?.() || "";
    const trimmed = selectedText.trim();
    const hasSelection = Boolean(trimmed);
    const length = trimmed.length;
    const nextKey = `${hasSelection ? "1" : "0"}-${length}`;
    if (nextKey === lastSelectionKey) return;
    lastSelectionKey = nextKey;
    try {
        if (!chrome?.runtime?.id) return;
        chrome.runtime.sendMessage({ type: "crx-selection-change", hasSelection, length }, () => {
            if (chrome.runtime.lastError) {
                // Ignore when content script belongs to a stale extension context.
                return;
            }
        });
    } catch {
        // ignore
    }
};

document.addEventListener("selectionchange", () => {
    if (selectionNotifyTimer) clearTimeout(selectionNotifyTimer);
    selectionNotifyTimer = setTimeout(() => notifySelectionState(), 120);
});
setTimeout(() => notifySelectionState(), 120);

const maybeRedirectFileMarkdownToViewer = () => {
    try {
        const href = String(globalThis?.location?.href || "");
        if (!href.startsWith("file:")) return;
        const pathname = String(globalThis?.location?.pathname || "");
        if (!/\.(?:md|markdown|mdown|mkd|mkdn|mdtxt|mdtext)(?:$|[?#])/i.test(pathname)) return;
        if (globalThis?.sessionStorage?.getItem("crx-file-markdown-redirected") === "1") return;
        const maxAttempts = 8;
        const attemptDelayMs = 120;
        let attempts = 0;
        const sendWhenReady = () => {
            attempts += 1;
            const text = (document?.body?.innerText || document?.documentElement?.innerText || "").trim();
            if (!text) {
                if (attempts < maxAttempts) {
                    globalThis.setTimeout(sendWhenReady, attemptDelayMs);
                }
                return;
            }
            globalThis?.sessionStorage?.setItem?.("crx-file-markdown-redirected", "1");
            chrome.runtime.sendMessage({ type: "crx:file-markdown-open", url: href, text }, () => {
                if (chrome.runtime.lastError) {
                    // Keep quiet in stale contexts / disabled runtime.
                    return;
                }
            });
        };
        sendWhenReady();
    } catch {
        /* ignore */
    }
};

if (document.readyState === "loading") {
    globalThis.setTimeout(maybeRedirectFileMarkdownToViewer, 0);
    document.addEventListener("DOMContentLoaded", () => {
        globalThis.setTimeout(maybeRedirectFileMarkdownToViewer, 40);
    }, { once: true });
} else {
    globalThis.setTimeout(maybeRedirectFileMarkdownToViewer, 0);
    globalThis.setTimeout(maybeRedirectFileMarkdownToViewer, 120);
}

const savePosition = (e: PointerEvent | MouseEvent) => {
    coordinate[0] = e.clientX;
    coordinate[1] = e.clientY;
    lastElement = e.target as HTMLElement | null;
};

document.addEventListener("pointerdown", savePosition, { passive: true, capture: true });
document.addEventListener("pointerup", savePosition, { passive: true, capture: true });
document.addEventListener("click", savePosition as EventListener, { passive: true, capture: true });
document.addEventListener("contextmenu", (e) => {
    savePosition(e);
    lastElement = (e.target as HTMLElement) || lastElement;
}, { passive: true, capture: true });

// ---------------------------------------------------------------------------
// Copy-as-* operations (context menu → content script)
// ---------------------------------------------------------------------------

const copyOps = new Map<string, (el: HTMLElement) => unknown>([
    ["copy-as-latex", copyAsTeX],
    ["copy-as-mathml", copyAsMathML],
    ["copy-as-markdown", copyAsMarkdown],
    ["copy-as-html", copyAsHTML],
]);

const toUserFsPath = (rawPath: string): string => {
    const value = String(rawPath || "").trim();
    if (!isUserScopePath(value)) return "";
    return toUserRelativePath(value);
};

const encodeArrayBufferBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};

const listUserFsDirectory = async (path: string) => {
    const relPath = toUserFsPath(path);
    if (relPath === "" && path !== "/user/" && path !== "/user") return { ok: false, error: "Invalid /user path" };

    let dir = await navigator.storage.getDirectory();
    for (const part of relPath.split("/").filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part, { create: false });
    }

    const entries: Array<{ name: string; kind: "file" | "directory" }> = [];
    for await (const [name, handle] of dir.entries()) {
        entries.push({ name, kind: handle.kind as "file" | "directory" });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, path, entries };
};

const readUserFsFile = async (path: string) => {
    const relPath = toUserFsPath(path);
    if (!relPath || relPath.endsWith("/")) return { ok: false, error: "Invalid file path" };

    const parts = relPath.split("/").filter(Boolean);
    const filename = parts.pop();
    if (!filename) return { ok: false, error: "Missing filename" };

    let dir = await navigator.storage.getDirectory();
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: false });
    }
    const fileHandle = await dir.getFileHandle(filename, { create: false });
    const file = await fileHandle.getFile();
    const base64 = encodeArrayBufferBase64(await file.arrayBuffer());
    return {
        ok: true,
        path,
        file: {
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            lastModified: file.lastModified,
            base64
        }
    };
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Selection query
    if (msg?.type === "highlight-selection") {
        sendResponse({ selection: (typeof window != "undefined" ? window : globalThis)?.getSelection()?.toString?.() ?? "" });
        return true;
    }

    // Copy-as-* operations
    if (typeof msg?.type === "string" && copyOps.has(msg.type)) {
        (async () => {
            const op = copyOps.get(msg.type)!;
            const target =
                lastElement ||
                (document.elementFromPoint(coordinate[0], coordinate[1]) as HTMLElement | null) ||
                document.body;

            try {
                const mayTranslate = msg.type === "copy-as-markdown" || msg.type === "copy-as-html";
                if (mayTranslate) showToast("Processing...");
                await op(target);
                showToast("Copied");
                sendResponse({ ok: true });
            } catch (e) {
                console.warn("[Content] Copy operation failed:", e);
                showToast("Failed to copy");
                sendResponse({ ok: false });
            }
        })();
        return true;
    }

    if (msg?.type === "crx-user-fs-bridge" || msg?.type === "request:crx-user-fs-bridge") {
        (async () => {
            try {
                const bridgeData = (msg?.data && typeof msg.data === "object") ? msg.data : msg;
                const action = String(bridgeData?.action || "").trim();
                const path = String(bridgeData?.path || "").trim();
                if (action === "list") {
                    sendResponse(await listUserFsDirectory(path));
                    return;
                }
                if (action === "read-file") {
                    sendResponse(await readUserFsFile(path));
                    return;
                }
                sendResponse({ ok: false, error: `Unknown action: ${action}` });
            } catch (error) {
                sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        })();
        return true;
    }

    return false;
});

// ---------------------------------------------------------------------------
// Rect-selector for CRX-Snip (triggered by popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "crx-snip-select-rect") return false;

    (async () => {
        try {
            if (!(typeof window != "undefined" ? window : globalThis).crxSnipSelectRect) await new Promise((r) => setTimeout(r, 100));
            if (!(typeof window != "undefined" ? window : globalThis).crxSnipSelectRect) throw new Error("Rect selector not available");
            sendResponse({ rect: await (typeof window != "undefined" ? window : globalThis)?.crxSnipSelectRect?.() });
        } catch (e) {
            sendResponse({ rect: null, error: e instanceof Error ? e.message : String(e) });
        }
    })();
    return true;
});

// ---------------------------------------------------------------------------
// CRX result pipeline delivery (page notifications)
// ---------------------------------------------------------------------------

const showPageNotification = (message: string, type: "success" | "error" | "info" = "info") => {
    try {
        const prefix = type === "error" ? "❌ " : type === "success" ? "✅ " : "";
        showToast({ message: `${prefix}${message}`, kind: type === "error" ? "error" : type === "success" ? "success" : "info", duration: 4200 });
    } catch {
        if ("Notification" in (typeof window != "undefined" ? window : globalThis) && Notification.permission === "granted") {
            new Notification("CWSP-shell", { body: message, icon: chrome.runtime.getURL("icons/icon.png") });
        }
    }
};

// BroadcastChannel listener
const resultBC = new BroadcastChannel("rs-content-script");
resultBC.onmessage = ({ data }) => {
    if (data?.type === "crx-result-delivered" && data.result?.type === "processed" && typeof data.result.content === "string") {
        const preview = data.result.content.length > 60 ? data.result.content.slice(0, 60) + "..." : data.result.content;
        showPageNotification(`📋 Copied to clipboard!\n${preview}`, "success");
    }
};

// chrome.runtime listener (SW → content script)
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "crx-result-delivered" && msg.result?.type === "processed" && typeof msg.result.content === "string") {
        const preview = msg.result.content.length > 60 ? msg.result.content.slice(0, 60) + "..." : msg.result.content;
        showPageNotification(`📋 Copied to clipboard!\n${preview}`, "success");
    }
});
