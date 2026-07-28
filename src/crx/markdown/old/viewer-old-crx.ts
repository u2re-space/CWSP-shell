import frontend from "../../../frontend/shells/boot/ts/frontend-entry";

// Import CRX runtime channel module for inline coding style
import { createRuntimeChannelModule } from 'crx/shared/runtime';

// Create runtime module for inline usage
let viewerModule: any = null;
const getViewerModule = async () => {
    if (!viewerModule) {
        viewerModule = await createRuntimeChannelModule('crx-markdown-viewer');
    }
    return viewerModule;
};

const mount = document.getElementById("app") as HTMLElement | null;
const raw = document.getElementById("raw-md") as HTMLPreElement | null;

const LAST_SRC_KEY = "rs-md-viewer-last-src";
const LAST_MD_KEY = "rs-markdown";

const loadLastMarkdown = () => {
    try {
        return localStorage.getItem(LAST_MD_KEY) || "";
    } catch {
        return "";
    }
};

const saveLastSrc = (src: string) => {
    try {
        localStorage.setItem(LAST_SRC_KEY, src);
    } catch {
        // ignore
    }
};

const loadLastSrc = () => {
    try {
        return localStorage.getItem(LAST_SRC_KEY) || "";
    } catch {
        return "";
    }
};

const isProbablyUrl = (value: string) => {
    try {
        // Avoid persisting huge raw markdown strings as a "src".
        return Boolean(new URL(value));
    } catch {
        return false;
    }
};

const looksLikeHtmlDocument = (text: string): boolean => {
    const t = (text || "").trimStart().toLowerCase();
    if (t.startsWith("<!doctype html")) return true;
    if (t.startsWith("<html")) return true;
    if (t.startsWith("<head")) return true;
    if (t.startsWith("<body")) return true;
    if (t.startsWith("<?xml") && t.includes("<html")) return true;
    return false;
};

const MARKDOWN_EXTENSION_PATTERN = /\.(?:md|markdown|mdown|mkd|mkdn|mdtxt|mdtext)(?:$|[?#])/i;

const looksLikeMarkdown = (text: string): boolean => {
    const trimmed = (text || "").trim();
    if (!trimmed) return false;
    if (looksLikeHtmlDocument(trimmed)) return false;
    let hits = 0;
    if (/^#{1,6}\s+.+$/m.test(trimmed)) hits++;
    if (/^\s*[-*+]\s+\S+/m.test(trimmed)) hits++;
    if (/^\s*\d+\.\s+\S+/m.test(trimmed)) hits++;
    if (/```[\s\S]*?```/.test(trimmed)) hits++;
    if (/\[([^\]]+)\]\(([^)]+)\)/.test(trimmed)) hits++;
    return hits >= 2;
};

const guessLanguageFromUrl = (url: URL): string => {
    const name = (url.pathname.split("/").pop() || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() : "";
    switch (ext) {
        case "ts": return "ts";
        case "tsx": return "tsx";
        case "js": return "js";
        case "jsx": return "jsx";
        case "json": return "json";
        case "css": return "css";
        case "scss": return "scss";
        case "html":
        case "htm": return "html";
        case "xml": return "xml";
        case "yml":
        case "yaml": return "yaml";
        case "py": return "py";
        case "sh": return "sh";
        case "go": return "go";
        case "rs": return "rs";
        case "java": return "java";
        default: return "";
    }
};

const wrapAsCodeFence = (text: string, lang: string) => {
    const safe = (text || "").replace(/\r\n/g, "\n");
    const fence = "```";
    const tag = lang ? `${lang}` : "";
    return `${fence}${tag}\n${safe}\n${fence}\n`;
};

const normalizeSourceUrl = (candidate: string) => {
    try {
        const u = new URL(candidate);

        // GitHub: /{owner}/{repo}/blob/{ref}/{path} -> raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
        if (u.hostname === "github.com") {
            const parts = u.pathname.split("/").filter(Boolean);
            const blobIdx = parts.indexOf("blob");
            if (parts.length >= 5 && blobIdx === 2) {
                const owner = parts[0];
                const repo = parts[1];
                const ref = parts[3];
                const rest = parts.slice(4).join("/");
                return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest}`;
            }

            // GitHub: /{owner}/{repo}/raw/{ref}/{path} -> raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
            const rawIdx = parts.indexOf("raw");
            if (parts.length >= 5 && rawIdx === 2) {
                const owner = parts[0];
                const repo = parts[1];
                const ref = parts[3];
                const rest = parts.slice(4).join("/");
                return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest}`;
            }
        }

        // GitLab: /{group}/{repo}/-/blob/{ref}/{path} -> /{group}/{repo}/-/raw/{ref}/{path}
        if (u.hostname.endsWith("gitlab.com")) {
            const parts = u.pathname.split("/").filter(Boolean);
            const dashIdx = parts.indexOf("-");
            if (dashIdx >= 0 && parts[dashIdx + 1] === "blob") {
                const base = parts.slice(0, dashIdx).join("/");
                const ref = parts[dashIdx + 2] || "";
                const rest = parts.slice(dashIdx + 3).join("/");
                return `https://${u.hostname}/${base}/-/raw/${ref}/${rest}`;
            }
        }

        // Bitbucket: `?raw=1` works for many src URLs
        if (u.hostname === "bitbucket.org") {
            if (!u.searchParams.has("raw")) u.searchParams.set("raw", "1");
            return u.toString();
        }

        return u.toString();
    } catch {
        return candidate;
    }
};

const loadTextFromSrc = async (src: string): Promise<string> => {
    const trimmed = src.trim();
    if (!trimmed) return "";
    try {
        const normalized = normalizeSourceUrl(trimmed);
        if (normalized !== trimmed && isProbablyUrl(normalized)) {
            saveLastSrc(normalized);
        }

        const u = new URL(normalized);
        const res = await fetch(u.href, { credentials: "include", cache: "no-store", headers: { accept: "text/markdown,text/plain,*/*" } });
        if (!res.ok) {
            const cached = loadLastMarkdown();
            return cached || `# Failed to load\n\n**Status**: ${res.status}\n`;
        }
        let text = await res.text();

        // If we fetched HTML (e.g. GitHub HTML page), keep it raw; the in-app viewer will default to raw mode.
        if (looksLikeHtmlDocument(text)) {
            console.warn("[CRX-MD-Viewer] Fetched HTML document, not markdown:", u.href);
        } else {
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            const isMdByUrl = MARKDOWN_EXTENSION_PATTERN.test(u.pathname);
            const isMdByCt = ct.includes("text/markdown");
            if (!isMdByUrl && !isMdByCt && !looksLikeMarkdown(text)) {
                text = wrapAsCodeFence(text, guessLanguageFromUrl(u));
            }
        }

        return text;
    } catch {
        // Not a URL - treat as raw markdown
        return trimmed;
    }
};

const loadTextFromSessionKey = async (key: string) => {
    try {
        const obj = await chrome.storage?.session?.get?.(key);
        const text = obj?.[key];
        if (typeof text === "string") {
            chrome.storage?.session?.remove?.(key)?.catch?.(() => { });
            return text;
        }
    } catch {
        // ignore
    }
    return "";
};

const requestMarkdownFromServiceWorker = async (src: string) => {
    try {
        const module = await getViewerModule();
        if (!module) {
            return "";
        }

        // Inline coding style: await module.loadMarkdown(src)
        const res = await module.loadMarkdown(src);
        const key = res?.key;
        const normalized = res?.src;
        if (typeof normalized === "string" && normalized && normalized !== src && isProbablyUrl(normalized)) {
            saveLastSrc(normalized);
        }
        if (typeof key === "string" && key) {
            return await loadTextFromSessionKey(key);
        }
    } catch {
        // ignore
    }
    return "";
};

void (async () => {
    if (!mount) return;
    // Show something immediately (sync) while we load the real markdown payload.
    // This is an internal "clipboard emulation" UX: raw-first, app-after.
    if (raw) raw.textContent = loadLastMarkdown() || "";

    const params = new URLSearchParams(location.search);
    const mdk = (params.get("mdk") || "").trim();
    const src = (params.get("src") || "").trim() || loadLastSrc();
    if (src && isProbablyUrl(src)) saveLastSrc(src);
    const text =
        mdk
            ? await loadTextFromSessionKey(mdk)
            : (src ? (await requestMarkdownFromServiceWorker(src)) : "") || (src ? await loadTextFromSrc(src) : "");

    // Display raw markdown ASAP (before loading the heavier app bundle).
    if (raw) raw.textContent = text || "";

    // Persist last markdown for "instant" raw fallback next time.
    try {
        if (text) localStorage.setItem(LAST_MD_KEY, text);
    } catch {
        // ignore
    }

    // Mount the app with the markdown content
    frontend(mount, { initialView: "markdown-viewer", initialMarkdown: text || undefined });

    // Once the app mounts, hide the raw layer.
    if (raw) raw.style.display = "none";
})();


