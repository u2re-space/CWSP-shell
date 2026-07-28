// Offscreen document for desktop capture in CRX-Snip

const canvas = document.getElementById('capture-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');

// Handle messages from service worker
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.type === 'capture-desktop' && message.streamId) {
        try {
            console.log('[Offscreen] Starting desktop capture...');

            // Get media stream using the provided stream ID
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: message.streamId,
                        maxWidth: 4096,
                        maxHeight: 2160
                    }
                } as any
            });

            // Create video element to capture the stream
            const video = document.createElement('video');
            video.srcObject = stream;

            // Wait for video to load
            await new Promise<void>((resolve) => {
                video.onloadedmetadata = () => resolve();
            });

            video.play();

            // Set canvas size to video dimensions
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            // Draw video frame to canvas
            ctx?.drawImage(video, 0, 0);

            // Stop the stream
            stream.getTracks().forEach(track => track.stop());

            // Convert canvas to blob
            const blob = await new Promise<Blob>((resolve) =>
                canvas.toBlob(resolve, 'image/png', 1.0)
            );

            // Convert blob to ArrayBuffer
            const arrayBuffer = await blob.arrayBuffer();

            console.log('[Offscreen] Desktop capture completed, size:', arrayBuffer.byteLength);

            sendResponse({ success: true, imageData: arrayBuffer });

        } catch (error) {
            console.error('[Offscreen] Desktop capture failed:', error);
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }

    return true; // Keep message channel open for async response
});