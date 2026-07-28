/**
 * CWSP-shell — Popup Script
 *
 * Manages:
 *  - Snip & Process actions (Feature #2)
 *  - Copy-as-* buttons (Feature #3)
 *  - Markdown Viewer URL opener (Feature #1)
 *  - Settings (API key, language, translate, SVG)
 */

//@ts-ignore
import "./index.scss";
import { createRuntimeChannelModule } from "../shared/runtime";

// ---------------------------------------------------------------------------
// CRX environment
// ---------------------------------------------------------------------------

const isInCrx = typeof chrome !== "undefined" && chrome.runtime?.id;

let popupModule: any = null;
const getModule = async () => {
    if (!popupModule && isInCrx) popupModule = await createRuntimeChannelModule("crx-popup");
    return popupModule;
};

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "rs-settings";
type ResponseLanguage = "en" | "ru" | "auto" | "follow";
type MCPConfig = {
    id: string;
    serverLabel: string;
    origin: string;
    clientKey: string;
    secretKey: string;
};
type CollectMcpRowsResult = {
    mcp: MCPConfig[];
    errors: string[];
};
type CrxUiSettings = {
    theme?: "system" | "light" | "dark";
    font?: "system" | "ui" | "mono";
    accent?: "blue" | "violet" | "green" | "orange";
};

type PopupSettings = {
    crxUi?: CrxUiSettings;
    ai?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        customModel?: string;
        defaultReasoningEffort?: "none" | "low" | "medium" | "high";
        defaultVerbosity?: "low" | "medium" | "high";
        maxOutputTokens?: number;
        contextTruncation?: "disabled" | "auto";
        promptCacheRetention?: "in-memory" | "24h";
        maxToolCalls?: number;
        parallelToolCalls?: boolean;
        requestTimeout?: { low?: number; medium?: number; high?: number };
        maxRetries?: number;
        responseLanguage?: ResponseLanguage;
        translateResults?: boolean;
        generateSvgGraphics?: boolean;
        mcp?: MCPConfig[];
    };
    [k: string]: unknown
};

const parseNumberOrDefault = (value: string | undefined, fallback: number): number => {
    const parsed = Number((value || "").trim());
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
};

const sanitizeMcpConfig = (raw: MCPConfig): MCPConfig => ({
    id: (raw?.id || `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`).toString().trim(),
    serverLabel: String(raw?.serverLabel || "").trim(),
    origin: String(raw?.origin || "").trim(),
    clientKey: String(raw?.clientKey || "").trim(),
    secretKey: String(raw?.secretKey || "").trim(),
});

const readMcpConfigFromStorage = (raw: unknown): MCPConfig[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => sanitizeMcpConfig(item as MCPConfig));
};

const formatMcpValue = (value: string) => (value || "").toString().trim();

const normalizeOrigin = (value: string) => {
    const prepared = formatMcpValue(value);
    if (!prepared) return "";
    return /^https?:\/\//i.test(prepared) ? prepared : `https://${prepared}`;
};

const isValidOrigin = (value: string) => {
    const origin = normalizeOrigin(value);
    if (!origin) return false;
    try {
        const parsed = new URL(origin);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
};

const createField = (label: string, value: string, type = "text", placeholder = "") => {
    const labelEl = document.createElement("label");
    labelEl.className = "mcp-field-label";
    labelEl.textContent = label;

    const inputEl = document.createElement("input");
    inputEl.type = type;
    inputEl.value = value;
    inputEl.placeholder = placeholder;

    return { labelEl, inputEl };
};

const collectMcpRows = (container: HTMLElement | null): CollectMcpRowsResult => {
    if (!container) return { mcp: [], errors: [] };
    const rows = Array.from(container.querySelectorAll(".mcp-row")) as HTMLElement[];
    const mcp: MCPConfig[] = [];
    const errors: string[] = [];

    rows.forEach((row, idx) => {
        const rowId = String(row.dataset.id || `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        const serverLabel = formatMcpValue((row.querySelector(".mcp-server-label") as HTMLInputElement)?.value);
        const origin = formatMcpValue((row.querySelector(".mcp-origin") as HTMLInputElement)?.value);
        const clientKey = formatMcpValue((row.querySelector(".mcp-client-key") as HTMLInputElement)?.value);
        const secretKey = formatMcpValue((row.querySelector(".mcp-secret-key") as HTMLInputElement)?.value);
        const inputFields = [serverLabel, origin, clientKey, secretKey];
        const hasAnyValue = inputFields.some(Boolean);

        if (!hasAnyValue) {
            row.classList.remove("mcp-row-invalid");
            return;
        }

        const rowErrors: string[] = [];
        if (!origin) {
            rowErrors.push("origin is required");
        } else if (!isValidOrigin(origin)) {
            rowErrors.push(`origin "${origin}" is invalid`);
        }
        if (!clientKey) rowErrors.push("client key is required");
        if (!secretKey) rowErrors.push("secret key is required");

        if (rowErrors.length) {
            row.classList.add("mcp-row-invalid");
            errors.push(`MCP row ${idx + 1}: ${rowErrors.join(", ")}`);
            return;
        }

        row.classList.remove("mcp-row-invalid");
        mcp.push({
            id: rowId,
            serverLabel,
            origin: normalizeOrigin(origin),
            clientKey,
            secretKey,
        });
    });

    return { mcp, errors };
};

const setMcpValidationError = (message: string) => {
    const target = document.getElementById("mcp-validation-error") as HTMLParagraphElement;
    if (!target) return;
    target.textContent = message;
    target.style.display = message ? "block" : "none";
};

const appendMcpRow = (container: HTMLElement | null, cfg: MCPConfig) => {
    if (!container) return;
    const row = document.createElement("div");
    row.className = "mcp-row";
    row.dataset.id = cfg.id;

    const fields: Array<{ labelEl: HTMLLabelElement; inputEl: HTMLInputElement }> = [
        createField("Server label", cfg.serverLabel, "text", "default"),
        createField("Origin", cfg.origin, "url", "https://..."),
        createField("Client key", cfg.clientKey, "text"),
        createField("Secret key", cfg.secretKey, "text"),
    ];

    const labels = ["server-label", "origin", "client-key", "secret-key"];
    fields[0].inputEl.classList.add(`mcp-${labels[0]}`);
    fields[1].inputEl.classList.add(`mcp-${labels[1]}`);
    fields[2].inputEl.classList.add(`mcp-${labels[2]}`);
    fields[3].inputEl.classList.add(`mcp-${labels[3]}`);

    for (const f of fields) {
        row.appendChild(f.labelEl);
        row.appendChild(f.inputEl);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "mcp-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => row.remove());
    row.appendChild(removeBtn);

    container.appendChild(row);
};

const renderMcpRows = (container: HTMLElement | null, list: MCPConfig[]) => {
    if (!container) return;
    container.innerHTML = "";
    const normalized = readMcpConfigFromStorage(list);
    if (!normalized.length) {
        const empty = document.createElement("p");
        empty.className = "mcp-empty";
        empty.textContent = "No MCP servers configured";
        container.appendChild(empty);
        return;
    }
    normalized.forEach((cfg) => appendMcpRow(container, cfg));
};

const loadSettings = async (): Promise<PopupSettings> => {
    try { return ((await chrome.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY] as PopupSettings) || {}; }
    catch { return {}; }
};

const saveSettings = async (updates: {
    ai?: Partial<NonNullable<PopupSettings["ai"]> & { mcp?: MCPConfig[] }>;
    crxUi?: Partial<CrxUiSettings>;
}) => {
    try {
        const current = await loadSettings();
        await chrome.storage.local.set({
            [SETTINGS_KEY]: {
                ...current,
                ai: { ...(current.ai || {}), ...(updates.ai || {}) },
                crxUi: { ...(current.crxUi || {}), ...(updates.crxUi || {}) },
            },
        });
        return true;
    } catch { return false; }
};

const defaultCrxUi = (): CrxUiSettings => ({
    theme: "dark",
    font: "system",
    accent: "blue",
});

const applyCrxUi = (ui: Partial<CrxUiSettings>) => {
    const t = { ...defaultCrxUi(), ...ui };
    const root = document.documentElement;
    root.dataset.crxTheme = t.theme || "dark";
    root.dataset.crxFont = t.font || "system";
    root.dataset.crxAccent = t.accent || "blue";
};

/** Windows / Unix absolute paths → file: URL for markdown open. */
const pathInputToFileUrl = (raw: string): string | null => {
    const t = (raw || "").trim();
    if (!t) return null;
    if (/^file:/i.test(t)) {
        try { return new URL(t).href; } catch { return null; }
    }
    if (/^[a-z]:[\\/]/i.test(t)) {
        const p = t.replace(/\\/g, "/");
        try { return new URL(`file:///${p}`).href; } catch { return null; }
    }
    if (t.startsWith("\\\\")) {
        const p = t.replace(/\\/g, "/");
        try { return new URL(`file:${p}`).href; } catch { return null; }
    }
    if (t.startsWith("/")) {
        try { return new URL(`file://${t}`).href; } catch { return null; }
    }
    return null;
};

const isMarkdownPath = (href: string) =>
    /\.(?:md|markdown|mdown|mkd|mkdn|mdtxt|mdtext)(?:$|[?#])/i.test(href);

// ---------------------------------------------------------------------------
// Helper: send message to active tab content script, then close popup
// ---------------------------------------------------------------------------

const getActiveTabFromService = async () => {
    return new Promise<number | null>((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "crx-query-active-tab" }, (response) => {
                if (chrome.runtime.lastError) return resolve(null);
                const tabId = typeof response?.tabId === "number" ? response.tabId : null;
                const url = typeof response?.url === "string" ? response.url : "";
                if (typeof tabId === "number" && (url.startsWith("chrome-extension://") || url.startsWith("chrome://") || url.startsWith("devtools://"))) {
                    return resolve(null);
                }
                resolve(Number.isFinite(tabId) && tabId >= 0 ? tabId : null);
            });
        } catch {
            resolve(null);
        }
    });
};

const isUsablePopupTargetTab = (tab: chrome.tabs.Tab | undefined | null) => {
    if (!tab) return false;
    if (typeof tab.id !== "number" || tab.id < 0) return false;
    const url = tab.url || "";
    return !url.startsWith("chrome-extension://") && !url.startsWith("chrome://") && !url.startsWith("devtools://");
};

const getActiveTabId = async () => {
    const direct = await chrome.tabs.query({ active: true, lastFocusedWindow: true, currentWindow: true }).catch(() => []);
    const directTab = direct.find(isUsablePopupTargetTab);
    if (directTab?.id != null) return directTab.id;
    return getActiveTabFromService();
};

const sendToTab = async (type: string, extra?: Record<string, any>) => {
    const tabId = await getActiveTabId();
    if (tabId == null) return;
    try {
        await chrome.tabs.sendMessage(tabId, { type, ...extra });
    } catch (error) {
        console.warn(error);
    }
    globalThis?.close?.();
};

// ---------------------------------------------------------------------------
// Feature 2: Snip & Process
// ---------------------------------------------------------------------------

const getSelectionText = async () => {
    const tabId = await getActiveTabId();
    if (tabId == null) return "";

    const messageResult = await new Promise<string>((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "highlight-selection" }, (response) => {
            if (chrome.runtime.lastError) return resolve("");
            const selection = typeof response?.selection === "string" ? response.selection : "";
            resolve(selection);
        });
    });

    if (messageResult) return messageResult;

    try {
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => (typeof window != "undefined" ? window : globalThis)?.getSelection()?.toString?.() || "" });
        return String(results[0]?.result || "");
    } catch {
        return "";
    }
};

const processSelectedText = async () => {
    const text = (await getSelectionText()).trim();
    if (!text) {
        chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell", message: "Select text first!" });
        return;
    }

    try {
        const module = await getModule();
        if (!module) throw new Error("Module unavailable");
        const result = await module.processText(text);
        chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell", message: result?.ok !== false ? "Text processed!" : `Failed: ${result?.error || "Unknown"}` });
    } catch (e) {
        chrome.notifications.create({ type: "basic", iconUrl: "icons/icon.png", title: "CWSP-shell", message: `Failed: ${e instanceof Error ? e.message : String(e)}` });
    }
};

const initSnipActions = () => {
    const select = document.getElementById("snip-action-select") as HTMLSelectElement;
    const btn = document.getElementById("snip-do") as HTMLButtonElement;
    const copySection = document.getElementById("copy-section") as HTMLElement;
    const selectionSection = (document.getElementById("selection-section") as HTMLElement) || copySection;
    const selectionEmpty = document.getElementById("selection-empty") as HTMLParagraphElement;
    const selectionBtn = document.getElementById("selection-process") as HTMLButtonElement;

    const setSectionHidden = (section: HTMLElement | null, isHidden: boolean) => {
        if (!section) return;
        if (isHidden) {
            section.setAttribute("hidden", "");
        } else {
            section.removeAttribute("hidden");
        }
    };

    const setSelectionState = (hasSelection: boolean, selectedText: string, selectionLength?: number) => {
        const safeText = (selectedText || "").trim();
        const resolvedLength = Number.isFinite(selectionLength as number) ? Number(selectionLength) : safeText.length;
        setSectionHidden(selectionSection, !hasSelection);
        setSectionHidden(copySection, !hasSelection);
        if (selectionEmpty) {
            selectionEmpty.textContent = hasSelection
                ? `${resolvedLength} character(s) selected`
                : "Select text in the page to use this action.";
        }
    };

    const refreshSelectionSection = async () => {
        const text = (await getSelectionText()).trim();
        setSelectionState(Boolean(text), text);
    };

    const requestSelectionStateOnOpen = () => {
        void refreshSelectionSection();
    };

    const handleSelectionMessage = (message: unknown) => {
        if (!message || typeof message !== "object") return;
        if ((message as { type?: string }).type !== "crx-selection-change") return;
        const hasSelection = Boolean((message as { hasSelection?: unknown }).hasSelection);
        const length = Number((message as { length?: unknown }).length || 0);
        setSelectionState(hasSelection, "", length);
        if (selectionEmpty) {
            selectionEmpty.textContent = hasSelection
                ? `${length} character(s) selected`
                : "Select text in the page to use this action.";
        }
    };

    chrome.runtime.onMessage.addListener(handleSelectionMessage);

    btn?.addEventListener("click", async () => {
        const action = select?.value;
        if (!action) return;

        if (action === "CRX_SNIP_SCREEN") {
            // Close popup first, then trigger rect selection in content script
            const tabId = await getActiveTabId();
            if (tabId == null) return;
            globalThis?.close?.();

            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: "crx-snip-select-rect" }, (response) => {
                    if (chrome.runtime.lastError || !response?.rect) return;
                    chrome.runtime.sendMessage({ type: "crx-snip-screen-capture", rect: response.rect, scale: 1 }).catch(console.warn);
                });
            }, 100);
            return;
        }

        // Regular snip modes → content script
        sendToTab(action);
    });

    selectionBtn?.addEventListener("click", async () => {
        await processSelectedText();
        globalThis?.close?.();
    });

    selectionSection?.addEventListener("mouseenter", () => { void refreshSelectionSection(); });
    window.addEventListener("focus", () => { void refreshSelectionSection(); });
    window.addEventListener("pageshow", requestSelectionStateOnOpen);
    document.addEventListener("readystatechange", () => {
        if (document.readyState === "interactive" || document.readyState === "complete") {
            void refreshSelectionSection();
        }
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void refreshSelectionSection();
    });
    window.addEventListener("selectionchange", () => { void refreshSelectionSection(); });
    void refreshSelectionSection();
};

// ---------------------------------------------------------------------------
// Feature 3: Copy-as-* buttons
// ---------------------------------------------------------------------------

const initCopyButtons = () => {
    document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", () => sendToTab(btn.dataset.copy!));
    });
};

// ---------------------------------------------------------------------------
// Feature 1: Markdown Viewer
// ---------------------------------------------------------------------------

const initMarkdownViewer = () => {
    const input = document.getElementById("md-url") as HTMLInputElement;
    const btn = document.getElementById("md-open") as HTMLButtonElement;

    const normalizeMarkdownCandidate = (value: string): string => {
        const raw = (value || "").trim();
        if (!raw) return "";
        const fileFromPath = pathInputToFileUrl(raw);
        if (fileFromPath && isMarkdownPath(fileFromPath)) return fileFromPath;
        if (/^(https?:|file:|ftp:)/i.test(raw)) return raw;
        if (raw.startsWith("//")) return `https:${raw}`;
        return `https://${raw}`;
    };

    const openUrl = () => {
        const raw = (input?.value || "").trim();
        if (!raw) return;

        const tryFile = pathInputToFileUrl(raw) || (/^file:/i.test(raw) ? normalizeMarkdownCandidate(raw) : "");
        if (tryFile && /^file:/i.test(tryFile) && isMarkdownPath(tryFile)) {
            chrome.runtime.sendMessage({ type: "crx:open-markdown-file", url: tryFile }, (r) => {
                if (chrome.runtime.lastError || !r?.ok) {
                    const vu = chrome.runtime.getURL("markdown/viewer.html");
                    const guide =
                        "> **CWSP-shell could not read this local markdown file.**\n>\n" +
                        "> 1. Open `chrome://extensions`, find CWSP-shell.\n>\n" +
                        "> 2. Enable **Allow access to file URLs**.\n>\n" +
                        "> 3. Try again.\n>\n" +
                        "> Opening the raw `file:` tab is blocked by Chromium nested-file security.";
                    chrome.tabs.create({ url: `${vu}?append=${encodeURIComponent(guide)}` });
                    globalThis?.close?.();
                    return;
                }
                globalThis?.close?.();
            });
            return;
        }

        const url = normalizeMarkdownCandidate(raw);
        if (!url) return;
        if (/^file:/i.test(url)) {
            chrome.runtime.sendMessage({ type: "crx:open-markdown-file", url }, (r) => {
                if (chrome.runtime.lastError || !r?.ok) {
                    const vu = chrome.runtime.getURL("markdown/viewer.html");
                    const guide =
                        "> **CWSP-shell could not read this local markdown file.**\n>\n" +
                        "> 1. Open `chrome://extensions`, find CWSP-shell.\n>\n" +
                        "> 2. Enable **Allow access to file URLs**.\n>\n" +
                        "> 3. Try again.\n>\n" +
                        "> Opening the raw `file:` tab is blocked by Chromium nested-file security.";
                    chrome.tabs.create({ url: `${vu}?append=${encodeURIComponent(guide)}` });
                }
                globalThis?.close?.();
            });
            return;
        }
        const viewerUrl = chrome.runtime.getURL("markdown/viewer.html");
        chrome.tabs.create({ url: `${viewerUrl}?src=${encodeURIComponent(url)}` });
        globalThis?.close?.();
    };

    btn?.addEventListener("click", openUrl);
    input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") openUrl();
    });
};

const initAppearance = () => {
    const theme = document.getElementById("crx-theme") as HTMLSelectElement;
    const font = document.getElementById("crx-font") as HTMLSelectElement;
    const accent = document.getElementById("crx-accent") as HTMLSelectElement;

    const persist = async () => {
        await saveSettings({
            crxUi: {
                theme: (theme?.value as CrxUiSettings["theme"]) || "dark",
                font: (font?.value as CrxUiSettings["font"]) || "system",
                accent: (accent?.value as CrxUiSettings["accent"]) || "blue",
            },
        });
    };

    loadSettings().then((s) => {
        const u = { ...defaultCrxUi(), ...(s.crxUi || {}) };
        if (theme) theme.value = u.theme || "dark";
        if (font) font.value = u.font || "system";
        if (accent) accent.value = u.accent || "blue";
        applyCrxUi(u);
    }).catch(console.warn);

    theme?.addEventListener("change", () => { applyCrxUi({ theme: theme.value as CrxUiSettings["theme"] }); void persist(); });
    font?.addEventListener("change", () => { applyCrxUi({ font: font.value as CrxUiSettings["font"] }); void persist(); });
    accent?.addEventListener("change", () => { applyCrxUi({ accent: accent.value as CrxUiSettings["accent"] }); void persist(); });
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const initSettingsUI = () => {
    const apiKey = document.getElementById("api-key") as HTMLInputElement;
    const apiUrl = document.getElementById("api-url") as HTMLInputElement;
    const saveBtn = document.getElementById("save-settings") as HTMLButtonElement;
    const showKey = document.getElementById("show-api-key") as HTMLInputElement;
    const langSel = document.getElementById("response-language") as HTMLSelectElement;
    const translateCb = document.getElementById("translate-results") as HTMLInputElement;
    const svgCb = document.getElementById("generate-svg") as HTMLInputElement;
    const modelSel = document.getElementById("model") as HTMLSelectElement;
    const customModelRow = document.getElementById("custom-model-row") as HTMLLIElement;
    const customModelInput = document.getElementById("custom-model") as HTMLInputElement;
    const defaultReasoningEffort = document.getElementById("default-reasoning-effort") as HTMLSelectElement;
    const defaultVerbosity = document.getElementById("default-verbosity") as HTMLSelectElement;
    const maxOutputTokens = document.getElementById("max-output-tokens") as HTMLInputElement;
    const contextTruncation = document.getElementById("context-truncation") as HTMLSelectElement;
    const promptCacheRetention = document.getElementById("prompt-cache-retention") as HTMLSelectElement;
    const maxToolCalls = document.getElementById("max-tool-calls") as HTMLInputElement;
    const parallelToolCalls = document.getElementById("parallel-tool-calls") as HTMLInputElement;
    const timeoutLow = document.getElementById("timeout-low") as HTMLInputElement;
    const timeoutMedium = document.getElementById("timeout-medium") as HTMLInputElement;
    const timeoutHigh = document.getElementById("timeout-high") as HTMLInputElement;
    const maxRetries = document.getElementById("max-retries") as HTMLInputElement;
    const mcpList = document.getElementById("mcp-config-list") as HTMLDivElement;
    const addMcpBtn = document.getElementById("mcp-add") as HTMLButtonElement;
    const importBtn = document.getElementById("mcp-import") as HTMLButtonElement;
    const exportBtn = document.getElementById("mcp-export") as HTMLButtonElement;
    const importFileInput = document.getElementById("mcp-import-file") as HTMLInputElement;

    const syncCustomModelVisibility = () => {
        const isCustom = (modelSel?.value || "").trim() === "custom";
        if (customModelRow) customModelRow.hidden = !isCustom;
        if (customModelInput) customModelInput.disabled = !isCustom;
    };
    modelSel?.addEventListener("change", syncCustomModelVisibility);
    customModelInput?.addEventListener("focus", () => {
        if (!modelSel) return;
        modelSel.value = "custom";
        syncCustomModelVisibility();
    });

    // Load
    loadSettings().then((s) => {
        if (apiUrl) apiUrl.value = (s.ai?.baseUrl || "").trim();
        if (apiKey) apiKey.value = (s.ai?.apiKey || "").trim();
        const storedModel = (s.ai?.model || "gpt-5.6-luna").trim();
        if (modelSel) {
            const hasOption = Array.from(modelSel.options).some((opt) => opt.value === storedModel);
            if (storedModel === "custom") {
                modelSel.value = "custom";
                if (customModelInput) customModelInput.value = (s.ai?.customModel || "").trim();
            } else if (hasOption) {
                modelSel.value = storedModel;
                if (customModelInput) customModelInput.value = (s.ai?.customModel || "").trim();
            } else {
                modelSel.value = "custom";
                if (customModelInput) customModelInput.value = (s.ai?.customModel || storedModel).trim();
            }
        }
        if (defaultReasoningEffort) defaultReasoningEffort.value = (s.ai?.defaultReasoningEffort || "medium") as any;
        if (defaultVerbosity) defaultVerbosity.value = (s.ai?.defaultVerbosity || "medium") as any;
        if (maxOutputTokens) maxOutputTokens.value = String(s.ai?.maxOutputTokens ?? 400000);
        if (contextTruncation) contextTruncation.value = (s.ai?.contextTruncation || "disabled") as any;
        if (promptCacheRetention) promptCacheRetention.value = (s.ai?.promptCacheRetention || "in-memory") as any;
        if (maxToolCalls) maxToolCalls.value = String(s.ai?.maxToolCalls ?? 8);
        if (parallelToolCalls) parallelToolCalls.checked = (s.ai?.parallelToolCalls ?? true) !== false;
        if (timeoutLow) timeoutLow.value = String(s.ai?.requestTimeout?.low ?? 60000);
        if (timeoutMedium) timeoutMedium.value = String(s.ai?.requestTimeout?.medium ?? 300000);
        if (timeoutHigh) timeoutHigh.value = String(s.ai?.requestTimeout?.high ?? 900000);
        if (maxRetries) maxRetries.value = String(s.ai?.maxRetries ?? 2);
        if (langSel) langSel.value = s.ai?.responseLanguage || "auto";
        if (translateCb) translateCb.checked = s.ai?.translateResults || false;
        if (svgCb) svgCb.checked = s.ai?.generateSvgGraphics || false;
        renderMcpRows(mcpList, s.ai?.mcp || []);
        setMcpValidationError("");
        syncCustomModelVisibility();
    }).catch(console.warn);

    addMcpBtn?.addEventListener("click", () => {
        const existing = collectMcpRows(mcpList).mcp;
        renderMcpRows(mcpList, existing.concat({
            id: `mcp-${Date.now()}`,
            serverLabel: "",
            origin: "",
            clientKey: "",
            secretKey: ""
        }));
    });

    importBtn?.addEventListener("click", () => {
        if (!importFileInput) return;
        importFileInput.value = "";
        importFileInput.click();
    });

    importFileInput?.addEventListener("change", async () => {
        if (!importFileInput.files?.length) return;
        const file = importFileInput.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const imported = Array.isArray(parsed) ? parsed : [parsed];
            const normalized = readMcpConfigFromStorage(imported);
            renderMcpRows(mcpList, normalized);
            setMcpValidationError("");
        } catch {
            setMcpValidationError("Failed to import MCP list. Provide valid JSON array.");
        }
    });

    exportBtn?.addEventListener("click", async () => {
        const { mcp, errors } = collectMcpRows(mcpList);
        if (errors.length) {
            setMcpValidationError(errors[0]);
            return;
        }
        setMcpValidationError("");

        const payload = JSON.stringify(mcp, null, 2);
        let copied = false;
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
                copied = true;
            }
        } catch {
            copied = false;
        }

        if (!copied) {
            try {
                const textarea = document.createElement("textarea");
                textarea.value = payload;
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                textarea.style.pointerEvents = "none";
                document.body.appendChild(textarea);
                textarea.select();
                textarea.remove();
            } catch {
                alert(`Export JSON:\n\n${payload}`);
            }
        }
    });

    // Save
    saveBtn?.addEventListener("click", async () => {
        const { mcp, errors } = collectMcpRows(mcpList);
        if (errors.length) {
            setMcpValidationError(errors[0]);
            return;
        }
        setMcpValidationError("");
        const ok = await saveSettings({
            ai: {
                apiKey: apiKey?.value?.trim() || "",
                baseUrl: apiUrl?.value?.trim() || "",
                model: modelSel?.value?.trim?.() || "gpt-5.6-luna",
                customModel: (modelSel?.value || "") === "custom" ? (customModelInput?.value?.trim?.() || "") : "",
                defaultReasoningEffort: (defaultReasoningEffort?.value as any) || "medium",
                defaultVerbosity: (defaultVerbosity?.value as any) || "medium",
                maxOutputTokens: parseNumberOrDefault(maxOutputTokens?.value, 400000),
                contextTruncation: (contextTruncation?.value as any) || "disabled",
                promptCacheRetention: (promptCacheRetention?.value as any) || "in-memory",
                maxToolCalls: parseNumberOrDefault(maxToolCalls?.value, 8),
                parallelToolCalls: (parallelToolCalls?.checked ?? true) !== false,
                requestTimeout: {
                    low: parseNumberOrDefault(timeoutLow?.value, 60000),
                    medium: parseNumberOrDefault(timeoutMedium?.value, 300000),
                    high: parseNumberOrDefault(timeoutHigh?.value, 900000),
                },
                maxRetries: parseNumberOrDefault(maxRetries?.value, 2),
                responseLanguage: (langSel?.value as ResponseLanguage) || "auto",
                translateResults: translateCb?.checked || false,
                generateSvgGraphics: svgCb?.checked || false,
                mcp,
            },
        });
        if (ok) {
            const orig = saveBtn.textContent;
            saveBtn.textContent = "Saved!";
            saveBtn.disabled = true;
            setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 1000);
        }
    });

    // Trim on change
    apiUrl?.addEventListener("change", () => { apiUrl.value = apiUrl.value.trim(); });
    apiKey?.addEventListener("change", () => { apiKey.value = apiKey.value.trim(); });
    customModelInput?.addEventListener("change", () => { customModelInput.value = customModelInput.value.trim(); });

    // Toggle key visibility
    showKey?.addEventListener("click", () => { if (apiKey) apiKey.type = showKey.checked ? "text" : "password"; });
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initAppearance();
initSnipActions();
initCopyButtons();
initMarkdownViewer();
initSettingsUI();
