/*
 * Filename: clipboard-handler.ts
 * FullPath: apps/CWSP-shell/src/crx/shared/clipboard-handler.ts
 * Change date and time: 14.25.00_19.07.2026
 * Reason for changes: Add READ_HACK for Paste by CWSP OS-clipboard fallback via offscreen.
 */

/**
 * Unified CRX Clipboard Handler
 * Works in both content script and offscreen document contexts
 * Auto-detects context and handles messages appropriately
 */

import { toText } from "core/modules/Clipboard";

export type CopyResponse = {
    ok: boolean;
    data?: string;
    method?: string;
    error?: string;
};

export type ReadResponse = {
    ok: boolean;
    data?: string;
    method?: string;
    error?: string;
};

export type CRXClipboardContext = "content" | "offscreen" | "unknown";

const tryParseJson = (input: string): unknown => {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
};

const extractLLMContent = (data: unknown): string => {
    if (data == null) return "";

    // If we got a JSON string, try to parse it first.
    if (typeof data === "string") {
        const parsed = tryParseJson(data);
        if (parsed != null) {
            const extracted = extractLLMContent(parsed);
            if (extracted) return extracted;
        }
        return data;
    }

    // OpenAI Chat Completions: { choices: [ { message: { content } } ] }
    if (typeof data === "object") {
        const anyData = data as any;

        const choice0 = anyData?.choices?.[0];
        const chatContent = choice0?.message?.content ?? choice0?.delta?.content ?? choice0?.text;
        if (typeof chatContent === "string" && chatContent.trim()) return chatContent;

        // OpenAI Responses: { output_text } or { output: [ { content: [ { text } ] } ] }
        const outputText = anyData?.output_text;
        if (typeof outputText === "string" && outputText.trim()) return outputText;

        const output0 = anyData?.output?.[0];
        const outText =
            output0?.content?.find?.((c: any) => typeof c?.text === "string")?.text ??
            output0?.content?.[0]?.text ??
            output0?.content?.[0]?.content ??
            output0?.text;
        if (typeof outText === "string" && outText.trim()) return outText;

        // Common wrappers: { message: { content } } or { content }
        const directMessage = anyData?.message?.content;
        if (typeof directMessage === "string" && directMessage.trim()) return directMessage;
        if (typeof anyData?.content === "string" && anyData.content.trim()) return anyData.content;

        // ExecutionCore-like: { result: { ... } } – try recursively.
        if (anyData?.result != null) {
            const nested = extractLLMContent(anyData.result);
            if (nested) return nested;
        }
    }

    return "";
};

/**
 * Get the best available timing function for scheduling callbacks
 * Prefers requestAnimationFrame when available, falls back to setTimeout
 */
export const getTimingFunction = (): ((callback: () => void) => void) => {
    if (typeof requestAnimationFrame !== 'undefined') {
        return requestAnimationFrame;
    }
    if (typeof setTimeout !== 'undefined') {
        return (cb) => setTimeout(cb, 0);
    }
    // Last resort: execute immediately
    return (cb) => cb();
};

/**
 * Detect current CRX context
 */
export const detectContext = (): CRXClipboardContext => {
    try {
        // Offscreen documents have limited APIs and specific URL pattern
        if (typeof location !== "undefined" && location.href.includes("offscreen")) {
            return "offscreen";
        }
        // Content scripts have access to the page DOM
        if (typeof document !== "undefined" && document.body) {
            return "content";
        }
    } catch {
        // Ignore errors in context detection
    }
    return "unknown";
};

/**
 * Show toast feedback (only works in content script context)
 */
const showFeedback = (message: string, toastFn?: (message: string) => void): void => {
    if (toastFn) {
        toastFn(message);
    } else {
        console.log("[Clipboard]", message);
    }
};

/**
 * Enhanced clipboard write with RAF timing and multiple retries
 */
const writeTextWithRAF = async (text: string, maxRetries = 3): Promise<{ ok: boolean; method?: string; error?: string }> => {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Empty content" };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Use RAF for proper timing, fallback to setTimeout for service workers
            const result = await new Promise<{ ok: boolean; method?: string; error?: string }>((resolve) => {
                const timerFn = getTimingFunction();
                timerFn(() => {
                    // Ensure document has focus for clipboard API (if in content script)
                    if (detectContext() === "content" && typeof document !== 'undefined' && document.hasFocus && !document.hasFocus()) {
                        try {
                            globalThis?.focus?.();
                        } catch {
                            // Ignore focus errors
                        }
                    }

                    // Try direct clipboard API first
                    const tryClipboardAPI = async () => {
                        try {
                            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                                await navigator.clipboard.writeText(trimmed);
                                return resolve({ ok: true, method: "clipboard-api" });
                            }
                        } catch (err) {
                            console.warn(`[Clipboard] Direct write failed (attempt ${attempt + 1}):`, err);
                        }

                        // Try with permissions query (Chrome extension specific)
                        try {
                            if (typeof navigator !== "undefined" && navigator.permissions) {
                                const result = await navigator.permissions.query({ name: "clipboard-write" } as unknown as PermissionDescriptor);
                                if (result.state === "granted" || result.state === "prompt") {
                                    await navigator.clipboard.writeText(trimmed);
                                    return resolve({ ok: true, method: "clipboard-api-permission" });
                                }
                            }
                        } catch (err) {
                            console.warn(`[Clipboard] Permission check failed (attempt ${attempt + 1}):`, err);
                        }

                        // Fallback: legacy execCommand (works in content scripts)
                        try {
                            if (detectContext() === "content" && typeof document !== "undefined") {
                                const textarea = document.createElement("textarea");
                                textarea.value = trimmed;
                                textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;z-index:-1;";
                                document.body.appendChild(textarea);
                                textarea.select();

                                // Focus the textarea for better compatibility
                                textarea.focus();
                                textarea.remove();

                                /*if (success) {
                                    return resolve({ ok: true, method: "legacy-execCommand" });
                                }*/
                            }
                        } catch (err) {
                            console.warn(`[Clipboard] Legacy execCommand failed (attempt ${attempt + 1}):`, err);
                        }

                        // Additional fallback: try again after a short delay
                        if (attempt < maxRetries - 1) {
                            setTimeout(() => tryClipboardAPI(), 100);
                            return;
                        }

                        resolve({ ok: false, error: "All clipboard methods failed" });
                    };

                    tryClipboardAPI();
                });
            });

            if (result.ok) {
                return result;
            }

            // If this attempt failed and we have retries left, wait before next attempt
            if (attempt < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
            }

        } catch (error) {
            console.warn(`[Clipboard] Attempt ${attempt + 1} completely failed:`, error);
            if (attempt < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
            }
        }
    }

    return { ok: false, error: `Failed after ${maxRetries} attempts` };
};

/**
 * Handle clipboard copy request with enhanced stability
 */
export const handleCopyRequest = async (
    data: unknown,
    options: { showFeedback?: boolean; errorMessage?: string; maxRetries?: number; toastFn?: (message: string) => void } = {}
): Promise<CopyResponse> => {
    const extracted = extractLLMContent(data);
    const text = (extracted || toText(data)).trim();
    const { maxRetries = 3 } = options;

    if (!text) {
        return { ok: false, error: "Empty content" };
    }

    console.log(`[Clipboard] Attempting to copy ${text.length} characters (${detectContext()})`);

    const result = await writeTextWithRAF(text, maxRetries);

    console.log(`[Clipboard] Copy result:`, result);

    // Show feedback if requested and in appropriate context
    if (options.showFeedback && detectContext() === "content") {
        if (result.ok) {
            showFeedback("Copied to clipboard", options.toastFn);
        } else {
            showFeedback(options.errorMessage || result.error || "Failed to copy", options.toastFn);
        }
    }

    return {
        ok: result.ok,
        data: text,
        method: result.method || detectContext(),
        error: result.error
    };
};

/**
 * Read OS clipboard text (offscreen / content — needs clipboardRead).
 */
export const handleReadRequest = async (): Promise<ReadResponse> => {
    try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
            const text = await navigator.clipboard.readText();
            if (typeof text === "string" && text.length) {
                return { ok: true, data: text, method: "clipboard-api" };
            }
            return { ok: false, error: "OS clipboard empty", data: "" };
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: false, error: "clipboard.readText unavailable" };
};

let _handlerRegistered = false;

/**
 * Initialize COPY_HACK / READ_HACK message handler
 * Auto-configures based on detected context
 */
export const initClipboardHandler = (
    options: {
        /** Only respond to messages with target matching this value */
        targetFilter?: string;
        /** Show toast feedback on copy */
        showFeedback?: boolean;
        /** Custom toast function */
        toastFn?: (message: string) => void;
    } = {}
): void => {
    if (_handlerRegistered) return;
    _handlerRegistered = true;

    const context = detectContext();
    const { targetFilter, showFeedback: feedback = context === "content", toastFn } = options;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log(`[Clipboard] Received message:`, message, `from:`, sender);

        // Filter by target if specified
        if (targetFilter && message?.target !== targetFilter) {
            console.log(`[Clipboard] Message filtered out by target:`, message?.target, `expected:`, targetFilter);
            return false;
        }

        // Handle COPY_HACK messages
        if (message?.type === "COPY_HACK") {
            console.log(`[Clipboard] Processing COPY_HACK message with data:`, message?.data?.substring?.(0, 50) + '...');
            handleCopyRequest(message?.data, {
                showFeedback: feedback,
                errorMessage: message?.error,
                toastFn: toastFn
            }).then(response => {
                console.log(`[Clipboard] COPY_HACK response:`, response);
                sendResponse(response);
            }).catch(error => {
                console.error(`[Clipboard] COPY_HACK error:`, error);
                sendResponse({ ok: false, error: String(error) });
            });
            return true; // async response
        }

        if (message?.type === "READ_HACK") {
            handleReadRequest()
                .then((response) => {
                    console.log(`[Clipboard] READ_HACK response:`, {
                        ok: response.ok,
                        len: response.data?.length ?? 0,
                        error: response.error,
                    });
                    sendResponse(response);
                })
                .catch((error) => {
                    console.error(`[Clipboard] READ_HACK error:`, error);
                    sendResponse({ ok: false, error: String(error) });
                });
            return true;
        }

        return false;
    });

    console.log(`[Clipboard] Handler initialized (${context})`);
};

// Re-export for convenience
export { writeText, toText } from "core/modules/Clipboard";

