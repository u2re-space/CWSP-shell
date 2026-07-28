/**
 * CRX Offscreen Document - Clipboard Handler
 * Uses unified clipboard handler module
 */

import { initClipboardHandler } from "crx/shared/clipboard-handler";

// Initialize handler for offscreen context
// - Only responds to messages with target: "offscreen"
// - No toast feedback (offscreen can't show UI)
console.log("[Offscreen] Initializing clipboard handler for offscreen context");

initClipboardHandler({
    targetFilter: "offscreen",
    showFeedback: false
});

console.log("[Offscreen] Clipboard document ready - listening for messages with target: 'offscreen'");

// Add a simple heartbeat to ensure the document stays alive
setInterval(() => {
    console.log("[Offscreen] Heartbeat - clipboard document active");
}, 30000); // Every 30 seconds
