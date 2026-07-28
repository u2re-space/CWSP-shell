/**
 * CRX Markdown Viewer
 *
 * Standalone markdown viewer for the Chrome extension.
 * Loads markdown from URL params (src/mdk), session storage, or clipboard.
 * Renders using marked + KaTeX with DOMPurify sanitization.
 * Supports raw/rendered toggle, copy, print, and reload.
 */

import { marked, type MarkedExtension } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from 'dompurify';
import { downloadMarkdownAsDocx } from "core/document/DocxExport";

// ---------------------------------------------------------------------------
// Marked + KaTeX setup
// ---------------------------------------------------------------------------

try {
    marked.use(
        markedKatex({
            throwOnError: false,
            nonStandard: true,
            output: "mathml",
            strict: false,
        }) as unknown as MarkedExtension,
        { gfm: true, breaks: true }
    );
} catch (e) {
    console.warn("[Viewer] marked-katex setup failed:", e);
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const rawPre = document.getElementById("raw-md") as HTMLPreElement | null;
const appDiv = document.getElementById("app") as HTMLDivElement | null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentSource = "";      // original source URL
let currentMarkdown = "";    // raw markdown text
let showRaw = false;

// ---------------------------------------------------------------------------
// URL params
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const paramSrc = params.get("src");   // source URL (http/https/file)
const paramMdk = params.get("mdk");   // session-storage key for pre-fetched markdown

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const looksLikeHtml = (text: string): boolean => {
    const t = text.trimStart().toLowerCase();
    return t.startsWith("<!doctype html") || t.startsWith("<html") || t.startsWith("<head") || t.startsWith("<body");
};

/** Sanitize and render markdown to HTML string */
const renderMarkdown = async (md: string): Promise<string> => {
    try {
        const raw = await marked.parse(md);
        return DOMPurify.sanitize(raw, {
            ADD_TAGS: ["math", "mrow", "mi", "mo", "mn", "msub", "msup", "mfrac", "msqrt", "mroot", "mover", "munder", "mtable", "mtr", "mtd", "mtext", "mspace", "menclose", "semantics", "annotation"],
            ADD_ATTR: ["xmlns", "mathvariant", "display", "encoding", "columnalign", "rowalign"],
        });
    } catch (e) {
        console.warn("[Viewer] marked.parse failed, using raw:", e);
        return `<pre>${escapeHtml(md)}</pre>`;
    }
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const buildToolbar = (): HTMLElement => {
    const bar = document.createElement("header");
    bar.className = "viewer-toolbar";

    const titleSpan = document.createElement("span");
    titleSpan.className = "viewer-title";
    titleSpan.textContent = extractTitle(currentMarkdown) || "Markdown Viewer";

    const actions = document.createElement("div");
    actions.className = "viewer-actions";

    const mkBtn = (label: string, title: string, handler: () => void) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener("click", handler);
        return btn;
    };

    actions.append(
        mkBtn("Raw", "Toggle raw markdown", toggleRaw),
        mkBtn("Copy", "Copy markdown to clipboard", copyMarkdown),
        mkBtn("Print", "Print rendered view", () => globalThis?.print?.()),
        mkBtn("Reload", "Reload from source", reloadFromSource),
        mkBtn("DOCX", "Download as DOCX", downloadAsDocx),
        mkBtn("Close", "Close the viewer", () => globalThis?.close?.()),
    );

    bar.append(titleSpan, actions);
    return bar;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const showRendered = async () => {
    if (!appDiv) return;

    const html = await renderMarkdown(currentMarkdown);

    // Build structure
    appDiv.innerHTML = "";
    appDiv.appendChild(buildToolbar());

    const body = document.createElement("article");
    body.className = "markdown-body";
    body.innerHTML = html;

    // Rewrite relative links against source URL
    if (currentSource) {
        try {
            const base = new URL(currentSource);
            body.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
                const href = a.getAttribute("href") || "";
                if (href && !href.startsWith("#") && !href.startsWith("http") && !href.startsWith("mailto:")) {
                    try { a.href = new URL(href, base).toString(); } catch { /* skip */ }
                }
                a.target = "_blank";
                a.rel = "noopener noreferrer";
            });
            body.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
                const src = img.getAttribute("src") || "";
                if (src && !src.startsWith("http") && !src.startsWith("data:")) {
                    try { img.src = new URL(src, base).toString(); } catch { /* skip */ }
                }
            });
        } catch { /* source isn't a valid URL - skip rewriting */ }
    }

    appDiv.appendChild(body);

    // Hide raw view
    if (rawPre) rawPre.hidden = true;

    document.title = extractTitle(currentMarkdown) || "Markdown Viewer";
};

const showRawView = () => {
    if (rawPre) {
        rawPre.textContent = currentMarkdown;
        rawPre.hidden = false;
    }
    if (appDiv) appDiv.innerHTML = "";
    // Re-add toolbar in app div for consistency
    if (appDiv) appDiv.appendChild(buildToolbar());
};

const toggleRaw = () => {
    showRaw = !showRaw;
    if (showRaw) {
        showRawView();
    } else {
        showRendered();
    }
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const copyMarkdown = async () => {
    try {
        await navigator.clipboard.writeText(currentMarkdown);
    } catch {
        // Fallback for content-script-like restrictions
        const ta = document.createElement("textarea");
        ta.value = currentMarkdown;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        ta.remove();
    }
};

const extractTitle = (md: string): string => {
    const m = md.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : "";
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load markdown from chrome.storage.session by key */
const loadFromSessionKey = async (key: string): Promise<string | null> => {
    try {
        const data = await chrome.storage?.session?.get?.(key);
        const text = data?.[key];
        if (typeof text === "string" && text.trim()) return text;
    } catch (e) {
        console.warn("[Viewer] session storage read failed:", e);
    }
    return null;
};

/** Ask service worker to fetch markdown (benefits from host_permissions) */
const fetchViaServiceWorker = (src: string): Promise<{ ok: boolean; text?: string; key?: string; src?: string }> => {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "md:load", src }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn("[Viewer] SW fetch failed:", chrome.runtime.lastError);
                resolve({ ok: false });
                return;
            }
            resolve(response || { ok: false });
        });
    });
};

/** Direct fetch (for same-origin or CORS-enabled resources) */
const fetchDirect = async (src: string): Promise<string | null> => {
    try {
        const res = await fetch(src, { credentials: "include", cache: "no-store" });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
};

/** Load markdown by source URL - tries session key first, then SW fetch, then direct */
const loadMarkdown = async (src: string, sessionKey?: string | null): Promise<string> => {
    currentSource = src;

    // 1. Pre-fetched markdown in session storage
    if (sessionKey) {
        const text = await loadFromSessionKey(sessionKey);
        if (text) return text;
    }

    // 2. Ask service worker to fetch (has host_permissions)
    const swResult = await fetchViaServiceWorker(src);
    if (swResult.ok && swResult.key) {
        const text = await loadFromSessionKey(swResult.key);
        if (text) return text;
    }

    // 3. Direct fetch fallback
    const text = await fetchDirect(src);
    if (text) return text;

    return `> Failed to load markdown from:\n> ${src}`;
};

const reloadFromSource = async () => {
    if (!currentSource) return;
    currentMarkdown = await loadMarkdown(currentSource);
    if (showRaw) showRawView();
    else showRendered();
};

const downloadAsDocx = async () => {
    if (!currentMarkdown) return;
    await downloadMarkdownAsDocx(currentMarkdown, {
        title: extractTitle(currentMarkdown) || "Markdown Content",
    });
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

const init = async () => {
    // Show loading state
    if (rawPre) {
        rawPre.textContent = "Loading...";
        rawPre.hidden = false;
    }

    let markdown = "";

    if (paramSrc) {
        markdown = await loadMarkdown(paramSrc, paramMdk);
    } else if (paramMdk) {
        markdown = (await loadFromSessionKey(paramMdk)) || "";
    }

    // If still empty, show empty state
    if (!markdown.trim()) {
        markdown = "# No content\n\nOpen a markdown file or navigate to a `.md` URL.";
    }

    // If content looks like HTML, show raw with a note
    if (looksLikeHtml(markdown)) {
        markdown = `> **Note:** The fetched content is HTML, not Markdown.\n> Showing raw content below.\n\n\`\`\`html\n${markdown}\n\`\`\``;
    }

    currentMarkdown = markdown;
    await showRendered();
};

init().catch((e) => {
    console.error("[Viewer] init failed:", e);
    if (rawPre) {
        rawPre.textContent = `Failed to initialize viewer: ${e}`;
        rawPre.hidden = false;
    }
});

// ---------------------------------------------------------------------------
// Styles (injected inline for the standalone CRX page)
// ---------------------------------------------------------------------------

const style = document.createElement("style");
style.textContent = /* css */ `
@layer viewer {
    :root {
        color-scheme: light dark;
        --vw-bg: light-dark(#fff, #0d1117);
        --vw-fg: light-dark(#1f2328, #e6edf3);
        --vw-fg-muted: light-dark(#656d76, #8b949e);
        --vw-border: light-dark(#d0d7de, #30363d);
        --vw-code-bg: light-dark(#f6f8fa, #161b22);
        --vw-link: light-dark(#0969da, #58a6ff);
        --vw-blockquote-border: light-dark(#d0d7de, #3b434b);
        --vw-toolbar-bg: light-dark(#f6f8fa, #161b22);
    }

    html, body {
        margin: 0;
        padding: 0;
        background: var(--vw-bg);
        color: var(--vw-fg);
        font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
        overflow: auto;
    }

    #raw-md {
        background: var(--vw-code-bg);
        color: var(--vw-fg);
        margin: 0;
        padding: 16px 24px;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
    }

    #raw-md[hidden] { display: none; }

    #app {
        display: flex;
        flex-direction: column;
        min-block-size: 100dvb;
    }

    .viewer-toolbar {
        position: sticky;
        inset-block-start: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 24px;
        background: var(--vw-toolbar-bg);
        border-block-end: 1px solid var(--vw-border);
        backdrop-filter: blur(8px);
    }

    .viewer-title {
        font-size: 14px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-inline-size: 0;
        flex: 1;
    }

    .viewer-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }

    .viewer-actions button {
        padding: 4px 12px;
        border-radius: 6px;
        border: 1px solid var(--vw-border);
        background: transparent;
        color: var(--vw-fg);
        font: 12px/1.3 system-ui;
        cursor: pointer;
        white-space: nowrap;
    }
    .viewer-actions button:hover {
        background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06));
    }
    .viewer-actions button:active {
        background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.1));
    }

    /* GitHub-flavored markdown body styles */
    .markdown-body {
        max-inline-size: 980px;
        margin: 0 auto;
        padding: 32px 24px 64px;
        word-wrap: break-word;
        overflow-wrap: break-word;
    }

    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {
        margin-block: 24px 16px;
        font-weight: 600;
        line-height: 1.25;
    }
    .markdown-body h1 { font-size: 2em; padding-block-end: .3em; border-block-end: 1px solid var(--vw-border); }
    .markdown-body h2 { font-size: 1.5em; padding-block-end: .3em; border-block-end: 1px solid var(--vw-border); }
    .markdown-body h3 { font-size: 1.25em; }
    .markdown-body h4 { font-size: 1em; }

    .markdown-body p { margin-block: 0 16px; }
    .markdown-body a { color: var(--vw-link); text-decoration: none; }
    .markdown-body a:hover { text-decoration: underline; }

    .markdown-body code {
        padding: 0.2em 0.4em;
        margin: 0;
        font-size: 85%;
        white-space: break-spaces;
        background: var(--vw-code-bg);
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .markdown-body pre {
        padding: 16px;
        overflow: auto;
        font-size: 85%;
        line-height: 1.45;
        background: var(--vw-code-bg);
        border-radius: 6px;
        margin-block: 0 16px;
    }
    .markdown-body pre code {
        padding: 0;
        background: transparent;
        border-radius: 0;
        white-space: pre;
    }

    .markdown-body blockquote {
        margin: 0 0 16px;
        padding: 0 1em;
        color: var(--vw-fg-muted);
        border-inline-start: .25em solid var(--vw-blockquote-border);
    }

    .markdown-body img {
        max-inline-size: 100%;
        block-size: auto;
        border-radius: 6px;
    }

    .markdown-body table {
        border-spacing: 0;
        border-collapse: collapse;
        margin-block: 0 16px;
        display: block;
        inline-size: max-content;
        max-inline-size: 100%;
        overflow: auto;
    }
    .markdown-body th, .markdown-body td {
        padding: 6px 13px;
        border: 1px solid var(--vw-border);
    }
    .markdown-body th {
        font-weight: 600;
        background: var(--vw-code-bg);
    }

    .markdown-body hr {
        block-size: .25em;
        padding: 0;
        margin: 24px 0;
        background-color: var(--vw-border);
        border: 0;
        border-radius: 2px;
    }

    .markdown-body ul, .markdown-body ol {
        padding-inline-start: 2em;
        margin-block: 0 16px;
    }
    .markdown-body li + li { margin-block-start: .25em; }

    .markdown-body input[type="checkbox"] {
        margin: 0 .2em .25em -1.6em;
        vertical-align: middle;
    }

    /* KaTeX / MathML */
    .markdown-body .katex { font-size: 1.1em; }
    .markdown-body math { font-size: 1.1em; }
    .markdown-body .katex-display { margin: 1em 0; overflow-x: auto; overflow-y: hidden; }

    /* Print styles */
    @media print {
        .viewer-toolbar { display: none; }
        .markdown-body { max-inline-size: none; padding: 0; }
    }
}
`;
document.head.appendChild(style);
