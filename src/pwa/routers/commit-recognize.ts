import { registerRoute } from "workbox-routing";
import {
    controlChannel,
    DOC_DIR,
    detectInputType,
    getExtensionForType,
    tryToTimeout,
    type DetectedDataType,
    callBackendIfAvailable,
    getActiveCustomInstruction
} from "./shared";
import { pushToIDBQueue } from "com/service/service/ServiceHelper";
import { loadSettings } from "com/config/Settings";
import { getRuntimeSettings } from "com/config/RuntimeSettings";
import { fileToDataUrl, isProcessableImage, isImageDataUrl } from "../lib/ImageUtils";
import { recognizeByInstructions } from "com/service/AI-ops/service/RecognizeData2";
import { getUsableData } from "com/service/model/GPT-Responses";

// IDB utilities for clipboard operations
const CLIPBOARD_DB_NAME = 'rs-clipboard-queue';
const CLIPBOARD_STORE_NAME = 'operations';

const openClipboardDB = async (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CLIPBOARD_DB_NAME, 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(CLIPBOARD_STORE_NAME)) {
                const store = db.createObjectStore(CLIPBOARD_STORE_NAME, { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
};

const storeClipboardOperation = async (operation: any): Promise<void> => {
    try {
        const db = await openClipboardDB();
        const transaction = db.transaction([CLIPBOARD_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(CLIPBOARD_STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const request = store.put(operation);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        // Keep only last 10 operations
        const countRequest = store.count();
        const count = await new Promise<number>((resolve, reject) => {
            countRequest.onsuccess = () => resolve(countRequest.result);
            countRequest.onerror = () => reject(countRequest.error);
        });

        if (count > 10) {
            const index = store.index('timestamp');
            const cursorRequest = index.openCursor(null, 'next');

            await new Promise<void>((resolve, reject) => {
                let deletedCount = 0;
                cursorRequest.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest).result;
                    if (cursor && deletedCount < (count - 10)) {
                        cursor.delete();
                        deletedCount++;
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                cursorRequest.onerror = () => reject(cursorRequest.error);
            });
        }

        db.close();
        console.log('[Router] Stored clipboard operation:', operation.id);
    } catch (error) {
        console.warn('[Router] Failed to store clipboard operation:', error);
    }
};

//
export const commitRecognize = (e: any): Promise<any[] | void> => {
    return Promise.try(async () => {
        const fd = await e.request.formData()?.catch?.(console.warn.bind(console));
        if (!fd) {
            console.warn("[commit-recognize] Failed to parse FormData");
            return [];
        }

        const inputs = {
            title: String(fd.get('title') || '').trim(),
            text: String(fd.get('text') || '').trim(),
            url: String(fd.get('url') || '').trim(),
            files: fd.getAll('files') as File[],
            targetDir: String(fd.get('targetDir') || DOC_DIR).trim(),
            customInstruction: String(fd.get('customInstruction') || '').trim()
        };

        console.log("[commit-recognize] Inputs received:", {
            title: inputs.title || '(none)',
            text: inputs.text?.substring(0, 50) || '(none)',
            url: inputs.url || '(none)',
            filesCount: inputs.files?.length || 0,
            files: inputs.files?.map(f => ({ name: f?.name, type: f?.type, size: f?.size }))
        });

        // Load settings
        let settings;
        try {
            settings = await getRuntimeSettings();
        } catch {
            settings = await loadSettings();
        }

        const customInstruction: string = inputs.customInstruction || (await getActiveCustomInstruction(settings)) || "";
        console.log("[commit-recognize] Custom instruction:", customInstruction ? `"${customInstruction.substring(0, 50)}..."` : "(none)");

        // Endpoint mode shortcut
        const backendResponse = await callBackendIfAvailable<{ ok?: boolean; results?: any[] }>("/core/ai/recognize", {
            title: inputs.title,
            text: inputs.text,
            url: inputs.url,
            targetDir: inputs.targetDir,
            customInstruction
        });

        if (backendResponse?.ok && Array.isArray(backendResponse.results)) {
            await pushToIDBQueue(backendResponse.results)?.catch?.(console.warn.bind(console));
            tryToTimeout(() => {
                try { controlChannel.postMessage({ type: 'commit-to-clipboard', results: backendResponse.results as any[] }) } catch (e) { console.warn(e); }
            }, 100);
            return backendResponse.results;
        }

        // Build list of sources to process
        const sources: Array<{ source: File | string; isImage: boolean; fileName?: string }> = [];

        // Add files first (higher priority for images)
        if (inputs.files?.length > 0) {
            for (const file of inputs.files) {
                if (file instanceof File && file.size > 0) {
                    sources.push({
                        source: file,
                        isImage: isProcessableImage(file),
                        fileName: file.name
                    });
                }
            }
        }

        // Add text/url as fallback if no files
        if (sources.length === 0) {
            const textOrUrl = inputs.text || inputs.url;
            if (textOrUrl) {
                sources.push({
                    source: textOrUrl,
                    isImage: false
                });
            }
        }

        if (sources.length === 0) {
            console.log("[commit-recognize] No sources to process");
            return [];
        }

        const results: any[] = [];
        const directory = inputs.targetDir;

        for (const { source, isImage, fileName } of sources) {
            const subId = Date.now();

            try {
                let dataToProcess: string | File | Blob;
                let text = '';

                if (source instanceof File || source instanceof Blob) {
                    if (isImage) {
                        // For images, convert to data URL for GPT vision API
                        console.log("[commit-recognize] Processing image:", fileName);
                        dataToProcess = await fileToDataUrl(source);
                        console.log("[commit-recognize] Image converted to data URL, length:", (dataToProcess as string).length);
                    } else {
                        // For non-image files, extract text content
                        text = await source.text?.()?.catch?.(() => "") || "";
                        dataToProcess = text;
                    }
                } else if (typeof source === 'string') {
                    // Check if it's a data URL (image)
                    if (isImageDataUrl(source)) {
                        dataToProcess = source;
                    } else if (URL.canParse(source, globalThis?.location?.origin || undefined)) {
                        // It's a URL - fetch content
                        text = await fetch(source).then(res => res.text()).catch(() => "");
                        dataToProcess = text || source;
                    } else {
                        text = source;
                        dataToProcess = source;
                    }
                } else {
                    continue;
                }

                // Detect input type for non-image content
                const detection = isImage
                    ? { type: 'image' as DetectedDataType, confidence: 0.99, needsAI: true, hints: ['image file'] }
                    : detectInputType(text || null, source instanceof File ? source : null);

                console.log("[commit-recognize] Detection result:", {
                    type: detection.type,
                    confidence: detection.confidence,
                    needsAI: detection.needsAI,
                    isImage
                });

                // High confidence non-AI processing for structured data
                if (!detection.needsAI && detection.confidence >= 0.7 && !isImage) {
                    const ext = getExtensionForType(detection.type);
                    const name = `pasted-${subId}${ext}`;
                    const path = `${directory}${name}`;

                    let processedData = text;
                    if (detection.type === "json") {
                        try {
                            processedData = JSON.stringify(JSON.parse(text), null, 2);
                        } catch { /* keep original */ }
                    }

                    results.push({
                        status: 'queued',
                        data: processedData,
                        path,
                        name,
                        subId,
                        directory,
                        dataType: detection.type,
                        detection: {
                            confidence: detection.confidence,
                            hints: detection.hints
                        }
                    });
                    continue;
                }

                // AI processing required (images, low confidence, complex types)
                console.log("[commit-recognize] Sending to AI for direct processing...");

                // Convert to usable format for recognizeByInstructions
                const usableData = await getUsableData({ dataSource: dataToProcess });
                const input = [{
                    type: "message",
                    role: "user",
                    content: [usableData]
                }];

                const $recognizedData = await recognizeByInstructions(input, "", undefined, undefined, {
                    customInstruction: customInstruction,
                    useActiveInstruction: false
                });

                console.log("[commit-recognize] AI response:", {
                    ok: $recognizedData?.ok,
                    hasData: !!$recognizedData?.data,
                    dataPreview: $recognizedData?.data?.substring?.(0, 100)
                });

                // Determine output format
                const finalType: DetectedDataType = $recognizedData?.ok
                    ? (isImage ? 'markdown' : (detection.type !== 'unknown' ? detection.type : 'markdown'))
                    : detection.type;

                const ext = getExtensionForType(finalType);
                const name = fileName
                    ? `${fileName.replace(/\.[^.]+$/, '')}-${subId}${ext}`
                    : `pasted-${subId}${ext}`;
                const path = `${directory}${name}`;

                results.push({
                    status: $recognizedData?.ok ? 'queued' : 'error',
                    error: $recognizedData?.error,
                    directory,
                    data: $recognizedData?.data,
                    path,
                    name,
                    subId,
                    dataType: finalType,
                    detection: {
                        originalType: detection.type,
                        confidence: detection.confidence,
                        hints: detection.hints,
                        aiProcessed: true,
                        isImage
                    }
                });
            } catch (err) {
                console.error("[commit-recognize] Processing error:", err);
                results.push({
                    status: 'error',
                    error: String(err),
                    subId,
                    fileName
                });
            }
        }

        // Persist and broadcast results
        await pushToIDBQueue(results)?.catch?.(console.warn.bind(console));

        // Also broadcast the first result directly for clipboard copy
        const firstResult = results.find(r => r?.status === 'queued' && r?.data);
        if (firstResult?.data) {
            // Store for persistent delivery
            storeClipboardOperation({
                id: `router-recognize-${Date.now()}`,
                data: firstResult.data,
                type: 'ai-result',
                timestamp: Date.now()
            }).catch(console.warn);

            tryToTimeout(() => {
                try {
                    // Broadcast via share-target channel for frontend clipboard handling
                    const shareChannel = new BroadcastChannel('rs-share-target');
                    shareChannel.postMessage({
                        type: 'ai-result',
                        data: { success: true, data: firstResult.data }
                    });
                    shareChannel.close();
                } catch (e) { console.warn(e); }
            }, 50);
        }

        tryToTimeout(() => {
            try {
                controlChannel.postMessage({ type: 'commit-to-clipboard', results });
            } catch (e) { console.warn(e); }
        }, 100);

        return results;
    })?.catch?.((error) => {
        console.error("[commit-recognize] Fatal error:", error);
        return [];
    });
}

//
export const makeCommitRecognize = () => {
    return registerRoute(({ url }) => url?.pathname == "/commit-recognize", async (e: any) => {
        return new Response(JSON.stringify(await commitRecognize?.(e)?.then?.(rs=>{ console.log('recognize results', rs); return rs; })?.catch?.(console.warn.bind(console))), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, "POST")
}
