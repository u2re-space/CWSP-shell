/*
 * Filename: paste-cwsp.ts
 * FullPath: apps/CWSP-shell/src/crx/content/paste-cwsp.ts
 * Change date and time: 15.05.00_19.07.2026
 * Reason for changes: Stash OS clipboard on contextmenu (user gesture) — Paste by CWSP.
 */

import { showToast } from "boot/ts/overlay";

/** WHY: context-menu click blurs the field before SW sends CWSP_PASTE_INSERT. */
let lastEditable: HTMLElement | null = null;

/**
 * WHY: `navigator.clipboard.readText` needs a user gesture. Contextmenu has one;
 * by the time the SW asks via offscreen/READ_HACK the gesture is gone and read fails.
 */
let stashedOsClipboard = "";
let stashedOsAt = 0;
const STASH_TTL_MS = 60_000;

const isEditableElement = (el: Element | null | undefined): el is HTMLElement => {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el instanceof HTMLInputElement) {
        const t = (el.type || "text").toLowerCase();
        if (["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"].includes(t)) {
            return false;
        }
        return !el.disabled && !el.readOnly;
    }
    if (el instanceof HTMLTextAreaElement) {
        return !el.disabled && !el.readOnly;
    }
    return el.isContentEditable;
};

const closestEditable = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    let cur: Element | null = node;
    while (cur) {
        if (isEditableElement(cur)) return cur;
        cur = cur.parentElement;
    }
    return null;
};

const rememberEditable = (el: HTMLElement | null): void => {
    if (el && document.contains(el)) lastEditable = el;
};

const markPasteTarget = (el: HTMLElement | null): void => {
    try {
        document.querySelectorAll("[data-cwsp-paste-target]").forEach((n) => {
            n.removeAttribute("data-cwsp-paste-target");
        });
        el?.setAttribute("data-cwsp-paste-target", "1");
    } catch {
        /* ignore */
    }
};

const resolvePasteTarget = (): HTMLElement | null => {
    const active = document.activeElement;
    if (isEditableElement(active)) return active;
    if (lastEditable && document.contains(lastEditable) && isEditableElement(lastEditable)) {
        try {
            lastEditable.focus({ preventScroll: true });
        } catch {
            try {
                lastEditable.focus();
            } catch {
                /* ignore */
            }
        }
        return lastEditable;
    }
    const marked = document.querySelector("[data-cwsp-paste-target='1']");
    if (isEditableElement(marked)) {
        try {
            marked.focus({ preventScroll: true });
        } catch {
            /* ignore */
        }
        return marked;
    }
    return null;
};

const insertIntoEditable = (target: HTMLElement, value: string): boolean => {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const el = target;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const next = el.value.slice(0, start) + value + el.value.slice(end);
        // Prefer native setter so React/Vue controlled inputs see the change.
        try {
            const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            if (desc?.set) desc.set.call(el, next);
            else el.value = next;
        } catch {
            el.value = next;
        }
        const caret = start + value.length;
        try {
            el.setSelectionRange(caret, caret);
        } catch {
            /* some input types reject selection */
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    if (target.isContentEditable) {
        try {
            if (document.execCommand("insertText", false, value)) return true;
        } catch {
            /* fall through */
        }
        try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(document.createTextNode(value));
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
                target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
                return true;
            }
        } catch {
            /* ignore */
        }
        try {
            target.appendChild(document.createTextNode(value));
            target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
            return true;
        } catch {
            /* ignore */
        }
    }

    return false;
};

const takeStashedOsClipboard = (): string => {
    if (!stashedOsClipboard) return "";
    if (Date.now() - stashedOsAt > STASH_TTL_MS) {
        stashedOsClipboard = "";
        return "";
    }
    return stashedOsClipboard;
};

const peekStashedOsClipboard = (): string => {
    if (!stashedOsClipboard) return "";
    if (Date.now() - stashedOsAt > STASH_TTL_MS) return "";
    return stashedOsClipboard;
};

/** Capture editable + OS clipboard while the contextmenu user-gesture is alive. */
document.addEventListener(
    "contextmenu",
    (ev) => {
        const el = closestEditable(ev.target);
        rememberEditable(el);
        markPasteTarget(el);

        // Fire-and-forget read — gesture stays valid for the async clipboard call.
        void (async () => {
            try {
                if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
                    const text = await navigator.clipboard.readText();
                    if (typeof text === "string" && text.length) {
                        stashedOsClipboard = text;
                        stashedOsAt = Date.now();
                    }
                }
            } catch {
                /* NotAllowedError / empty — SW may still resolve CWSP held text */
            }
        })();
    },
    true
);

document.addEventListener(
    "focusin",
    (ev) => {
        rememberEditable(closestEditable(ev.target));
    },
    true
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CWSP_PASTE_STASH_GET") {
        sendResponse?.({
            ok: true,
            text: peekStashedOsClipboard(),
            hadTarget: Boolean(resolvePasteTarget() || lastEditable),
        });
        return true;
    }

    if (message?.type !== "CWSP_PASTE_INSERT") return;

    const fromSw = String(message?.text ?? "");
    const text = fromSw || takeStashedOsClipboard();
    const target = resolvePasteTarget();
    const ok = Boolean(target && text && insertIntoEditable(target, text));
    if (ok) {
        try {
            showToast?.({ message: "Pasted by CWSP", kind: "success", duration: 2200 });
        } catch {
            /* toast optional */
        }
    }
    sendResponse?.({
        ok,
        hadTarget: Boolean(target),
        length: text.length,
        usedStash: !fromSw && Boolean(text),
    });
    return true;
});
