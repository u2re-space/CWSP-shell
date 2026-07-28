import type { CrxRuntimeModule, WorkerChannel } from "fest/uniform";
import { detectExecutionContext } from "fest/uniform";

/**
 * Create a chrome extension runtime messaging channel
 * Uses chrome.runtime.sendMessage instead of Web Workers
 */
export const createChromeExtensionRuntimeChannel = (channelName: string): WorkerChannel => {
    const context = detectExecutionContext();
    if (context != 'chrome-extension') {
        // Return a no-op channel when not in CRX context instead of throwing
        console.warn('Chrome extension runtime channels requested but not in chrome extension context. Returning no-op channel.');
        return {
            async request(method: string, args: any[] = []) {
                console.warn(`CRX messaging not available: ${method}`, args);
                throw new Error('Chrome extension messaging is not available in this context');
            },
            close() {
                // No-op
            }
        };
    }

    // Create a simple CRX channel that directly uses chrome.runtime.sendMessage
    return {
        async request(method: string, args: any[] = []) {
            // Prepare the message for CRX runtime messaging
            const message = {
                id: `crx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: method,
                source: context,
                target: channelName,
                data: args.length === 1 ? args[0] : args,
                metadata: { timestamp: Date.now() }
            };

            // Send via chrome runtime messaging with callback handling
            return new Promise((resolve, reject) => {
                try {
                    if (!chrome?.runtime?.id) {
                        resolve({ ok: false, error: "runtime-unavailable" });
                        return;
                    }
                    console.log('[Runtime Channel] Sending message:', message);
                    chrome.runtime.sendMessage(message, (response) => {
                        if (chrome.runtime.lastError) {
                            const runtimeErrorMessage = chrome.runtime.lastError.message || "runtime-error";
                            console.warn('[Runtime Channel] Chrome runtime error:', runtimeErrorMessage);
                            // Keep consumers alive after extension reload/invalidation.
                            resolve({ ok: false, error: runtimeErrorMessage });
                            return;
                        }

                        console.log('[Runtime Channel] Received response for', method, ':', response);
                        resolve(response);
                    });
                } catch (error) {
                    console.error('[Runtime Channel] Failed to send message:', error);
                    reject(error);
                }
            });
        },

        close() {
            // CRX runtime channels don't need explicit closing
        }
    };
};

/**
 * Chrome Extension Runtime Channel Module
 * Creates a module-like interface for CRX functionality that can be used inline
 */
export const createRuntimeChannelModule = async (channelName: string, options?: {
    context?: 'content-script' | 'popup' | 'background';
    timeout?: number;
}): Promise<CrxRuntimeModule> => {
    const context = detectExecutionContext();
    if (context !== 'chrome-extension') {
        throw new Error('Runtime channel modules can only be created in chrome extension context');
    }

    // Create the underlying messaging channel
    const messagingChannel = createChromeExtensionRuntimeChannel(channelName);

    console.log('messagingChannel', messagingChannel);

    // Create a module-like interface
    const module: CrxRuntimeModule = {
        // Screen capture functionality (capture + AI processing)
        async capture(rect?: { x: number; y: number; width: number; height: number }, mode?: string) {
            const result = await messagingChannel?.request?.('capture', [{
                rect,
                mode: mode || 'recognize'
            }]);
            return result;
        },

        // Just capture screenshot, return image data
        async captureScreenshot(rect?: { x: number; y: number; width: number; height: number }) {
            const result = await messagingChannel?.request?.('captureScreenshot', [{
                rect
            }]);
            return result;
        },

        // Process captured image data with AI
        async processImage(imageData: string | Blob, mode?: string) {
            const result = await messagingChannel?.request?.('processImage', [{
                imageData,
                mode: mode || 'recognize'
            }]);
            return result;
        },

        // Text processing functionality
        async processText(text: string, options?: { type?: string }) {
            const result = await messagingChannel?.request?.('processText', [{
                content: text,
                contentType: options?.type || 'text'
            }]);
            return result;
        },

        // Copy to clipboard functionality
        async doCopy(data: { text?: string; data?: any }, options?: { showToast?: boolean }) {
            const result = await messagingChannel?.request?.('doCopy', [{
                data,
                showToast: options?.showToast !== false
            }]);

            // Show toast if requested and available
            if (options?.showToast !== false && result?.success && typeof chrome !== 'undefined' && chrome.notifications) {
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'icons/icon.png',
                    title: 'CWSP-shell',
                    message: 'Copied to clipboard!'
                });
            }

            return result;
        },

        // Load markdown functionality
        async loadMarkdown(src: string) {
            const result = await messagingChannel?.request?.('loadMarkdown', [src]);
            return result;
        },

        // Custom screen capture with rectangle selection
        async captureWithRect(mode?: string) {
            // This would trigger rectangle selection in content script
            // and then capture the selected area
            const result = await messagingChannel?.request?.('captureWithRect', [{
                mode: mode || 'default'
            }]);
            return result;
        },

        // Get current tab information
        async getCurrentTab() {
            if (typeof chrome !== 'undefined' && chrome.tabs) {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                return tabs[0];
            }
            return null;
        },

        // Send custom message
        async sendMessage(type: string, data?: any) {
            const result = await messagingChannel?.request?.(type, data ? [data] : []);
            return result;
        },

        // Close the module/channel
        close() {
            messagingChannel?.close?.();
        }
    };

    return module;
};