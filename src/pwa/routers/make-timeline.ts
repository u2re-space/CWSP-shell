import { registerRoute } from "workbox-routing";
import { controlChannel, tryToTimeout } from "./shared";
import { createTimelineGenerator, requestNewTimeline } from "com/service/service/MakeTimeline";
import { queueEntityForWriting, pushToIDBQueue } from "com/service/service/ServiceHelper";
import type { GPTResponses } from "com/service/model/GPT-Responses";

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
export const generateTimeline = (e: any) => {
    return Promise.try(async () => {
        const fd = await e.request.formData()?.catch?.(console.warn.bind(console));
        const source = fd?.get?.('source') as string || null;

        //
        const speechPrompt = fd?.get?.('text')?.toString?.()?.trim?.() || null;
        const gptResponses = await createTimelineGenerator(source, speechPrompt) as unknown as GPTResponses | null;
        const timelineResults = await requestNewTimeline(gptResponses as GPTResponses) as any[] || [];

        //
        if (timelineResults?.length > 0) {
            // Queue each timeline task for writing to OPFS
            const queuedResults = timelineResults?.map?.((task) => {
                return queueEntityForWriting(task, task?.type || "task", "json");
            })?.filter?.(Boolean) || [];

            // Push to IDB queue for persistence
            await pushToIDBQueue(queuedResults)?.catch?.(console.warn.bind(console));

            // Store for persistent delivery
            storeClipboardOperation({
                id: `router-timeline-${Date.now()}`,
                data: JSON.stringify(timelineResults, null, 2),
                type: 'ai-result',
                timestamp: Date.now()
            }).catch(console.warn);

            // Also broadcast the timeline results for clipboard copy
            tryToTimeout(() => {
                try {
                    // Broadcast via share-target channel for frontend clipboard handling
                    const shareChannel = new BroadcastChannel('rs-share-target');
                    shareChannel.postMessage({
                        type: 'ai-result',
                        data: { success: true, data: JSON.stringify(timelineResults, null, 2) }
                    });
                    shareChannel.close();
                } catch (e) { console.warn(e); }
            }, 50);
        }

        // Notify to trigger flush
        tryToTimeout(() => {
            try { controlChannel.postMessage({ type: 'commit-result', results: timelineResults }) } catch (e) { console.warn(e); }
        }, 100);

        //
        return timelineResults;
    })?.catch?.(console.warn.bind(console));
}

//
export const makeTimeline = () => {
    return registerRoute(({ url }) => url?.pathname == "/make-timeline",
        async (e: any) => new Response(JSON.stringify(await generateTimeline?.(e)?.then?.(rs => { console.log('timeline results', rs); return rs; })?.catch?.(console.warn.bind(console))), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        "POST")
}
