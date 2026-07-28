/**
 * CWSP-shell — Snip Module (Content Script)
 *
 * Provides the selection overlay + AI capture pipeline.
 * Modes: recognize | solve | code | css | custom
 *
 * Triggered by:
 *  - Context menu (START_SNIP, SOLVE_AND_ANSWER, WRITE_CODE, EXTRACT_CSS, CUSTOM_INSTRUCTION)
 *  - Keyboard shortcuts (Ctrl+Shift+X/Y forwarded by SW)
 */

import { getBox, getHint, getOverlay, getSizeBadge, hideSelection, showSelection, showToast } from "boot/ts/overlay";
import { createRuntimeChannelModule } from "../shared/runtime";
import { registerCrxHandler } from "com/core/CrxMessaging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CropArea { x: number; y: number; width: number; height: number }
export type SnipMode = "recognize" | "solve" | "code" | "css" | "custom";

// ---------------------------------------------------------------------------
// CRX environment & runtime module
// ---------------------------------------------------------------------------

const isInCrx = typeof chrome !== "undefined" && chrome.runtime?.id;

let crxModule: any = null;
const getCrxModule = async () => {
    if (!crxModule && isInCrx) crxModule = await createRuntimeChannelModule("crx-content-script");
    return crxModule;
};

// ---------------------------------------------------------------------------
// Mode metadata
// ---------------------------------------------------------------------------

const MODE_META: Record<SnipMode, { msgType: string; name: string; error: string; hint: string; action: string }> = {
    recognize: { msgType: "CAPTURE", name: "Recognition", error: "No data recognized", hint: "Select area. Esc — cancel", action: "Recognizing with AI..." },
    solve:     { msgType: "CAPTURE_SOLVE", name: "Solving/Answering", error: "Could not solve/answer", hint: "Select problem/question. Esc — cancel", action: "Solving / Answering..." },
    code:      { msgType: "CAPTURE_CODE", name: "Code generation", error: "Could not generate code", hint: "Select code request. Esc — cancel", action: "Generating code..." },
    css:       { msgType: "CAPTURE_CSS", name: "CSS extraction", error: "Could not extract CSS", hint: "Select UI to extract CSS. Esc — cancel", action: "Extracting CSS styles..." },
    custom:    { msgType: "CAPTURE_CUSTOM", name: "Custom instruction", error: "Custom instruction failed", hint: "Select area. Esc — cancel", action: "Processing..." },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let injected = false;
let active = false;
let currentMode: SnipMode = "recognize";
let customInstructionId: string | null = null;
let customInstructionLabel: string | null = null;

// ---------------------------------------------------------------------------
// Capture helper
// ---------------------------------------------------------------------------

const captureTab = async (rect?: CropArea, mode: SnipMode = "recognize") => {
    if (!isInCrx) return Promise.reject(new Error("Not in CRX environment"));

    const module = await getCrxModule();
    if (!module) throw new Error("CRX runtime module not available");

    const meta = MODE_META[mode];
    const payload: any = { type: meta.msgType, rect };
    if (mode === "custom" && customInstructionId) payload.instructionId = customInstructionId;

    const result = await module.capture(rect, mode);

    if (!result?.ok) {
        const rawError = (result?.error || meta.error || "").trim();
        // Keep diagnostics readable in toast, but don't cut too aggressively.
        const visibleError = rawError.length > 500 ? `${rawError.slice(0, 500)}\n…` : rawError;
        showToast(visibleError || meta.error);
    } else if (!result.data) {
        showToast("No text found in selected area");
    }

    return result;
};

// ---------------------------------------------------------------------------
// Snip activation
// ---------------------------------------------------------------------------

export function startSnip(mode: SnipMode = "recognize", instructionId?: string, instructionLabel?: string) {
    if (active) return;

    currentMode = mode;
    customInstructionId = instructionId || null;
    customInstructionLabel = instructionLabel || null;

    const overlay = getOverlay();
    const box = getBox();
    const hint = getHint();
    const sizeBadge = getSizeBadge();

    if (!overlay || !box) { console.warn("[Snip] overlay not ready"); return; }

    let startX = 0, startY = 0, currX = 0, currY = 0, dragging = false;

    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); } };

    const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0 || !active) return;
        e.preventDefault(); e.stopPropagation();
        dragging = true;
        startX = e.clientX; startY = e.clientY; currX = startX; currY = startY;
        updateBox();
        if (hint) hint.textContent = "";
        if (sizeBadge) sizeBadge.textContent = "";
    };

    const onMouseMove = (e: MouseEvent) => { if (!dragging) return; e.preventDefault(); currX = e.clientX; currY = e.clientY; updateBox(); };

    const onMouseUp = async (e: MouseEvent) => {
        if (!dragging) return;
        e.preventDefault();
        dragging = false;

        const x = Math.min(startX, currX), y = Math.min(startY, currY);
        const w = Math.abs(currX - startX), h = Math.abs(currY - startY);
        cleanup();

        if (w < 2 || h < 2) { showToast("Selection is too small"); return; }

        const meta = MODE_META[currentMode];
        const actionText = currentMode === "custom" && customInstructionLabel ? `${customInstructionLabel}...` : meta.action;
        showToast(actionText);

        try {
            const result = await captureTab({ x, y, width: w, height: h }, currentMode).catch(() => null);
            if (!result?.ok) { /* captureTab already shows toast */ }
        } catch { showToast(`${meta.name} failed`); }
    };

    const onCancel = () => { if (dragging) { dragging = false; cleanup(); } };

    function updateBox() {
        const x = Math.min(startX, currX), y = Math.min(startY, currY);
        const w = Math.abs(currX - startX), h = Math.abs(currY - startY);
        box.style.left = `${x}px`; box.style.top = `${y}px`;
        box.style.width = `${w}px`; box.style.height = `${h}px`;
        if (sizeBadge) {
            sizeBadge.textContent = `${Math.round(w)} × ${Math.round(h)}`;
            sizeBadge.style.left = `${w}px`; sizeBadge.style.top = `${h}px`;
            if (!sizeBadge.isConnected) box.appendChild(sizeBadge);
        }
    }

    function cleanup() {
        active = false; dragging = false;
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.removeEventListener("mousedown", onMouseDown);
        overlay.removeEventListener("mousemove", onMouseMove);
        overlay.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("mousecancel", onCancel, true);
        hideSelection();
    }

    // Attach
    document.addEventListener("keydown", onKeyDown, true);
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousecancel", onCancel, true);

    active = true;
    showSelection();

    const hintText = currentMode === "custom" && customInstructionLabel
        ? `Select for "${customInstructionLabel}". Esc — cancel`
        : MODE_META[currentMode].hint;
    if (hint) hint.textContent = hintText;
    if (sizeBadge) sizeBadge.textContent = "";
}

// ---------------------------------------------------------------------------
// Message listener (from SW / context menu)
// ---------------------------------------------------------------------------

const initSnip = () => {
    if (injected) return;
    injected = true;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "START_SNIP") startSnip("recognize");
        if (msg?.type === "SOLVE_AND_ANSWER" || msg?.type === "SOLVE_EQUATION" || msg?.type === "ANSWER_QUESTION") startSnip("solve");
        if (msg?.type === "WRITE_CODE") startSnip("code");
        if (msg?.type === "EXTRACT_CSS") startSnip("css");
        if (msg?.type === "CUSTOM_INSTRUCTION" && msg?.instructionId) startSnip("custom", msg.instructionId, msg.label);
    });
};

// ---------------------------------------------------------------------------
// CRX messaging handlers (progress/error feedback)
// ---------------------------------------------------------------------------

if (isInCrx) {
    registerCrxHandler("processingStarted", () => showToast(`Starting ${MODE_META[currentMode].name}...`));
    registerCrxHandler("processingError", (data: any) =>
        showToast({ message: `Processing failed: ${data?.error || "unknown"}`, kind: "error", duration: 4200 }));
    registerCrxHandler("processingProgress", (data: any) => {
        if (data.progress > 0 && data.progress < 100) showToast(`${MODE_META[currentMode].name}: ${data.progress}%`);
    });
    registerCrxHandler("processingComplete", () => { /* handled by main response */ });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

initSnip();
