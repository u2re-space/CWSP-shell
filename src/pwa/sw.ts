/// <reference lib="webworker" />
/**
 * CWSP-shell service worker.
 *
 * Responsibilities:
 * - Workbox caching and offline navigation
 * - share-target ingestion and cache staging
 * - background broadcast/notification helpers
 * - lightweight content-association rules that decide how incoming share or
 *   background payloads should be handled before the window app is ready
 *
 * AI-READ: this is the worker-side complement to `frontend/pwa/sw-handling.ts`.
 * Keep worker-safe assumptions here; DOM/window-only logic belongs on the page side.
 */
import "./sw-preamble";
import { registerRoute, setCatchHandler, setDefaultHandler } from 'workbox-routing'
import { CacheFirst, NetworkFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { ExpirationPlugin } from 'workbox-expiration'
import {
    parseFormDataFromRequest,
    buildShareData,
    cacheShareData,
    categorizeFiles,
    getAIProcessingConfig,
    logShareDataSummary,
    hasProcessableContent,
    processShareTargetWithExecutionCore,
    SHARE_FILE_PREFIX,
    SHARE_CACHE_NAME,
    SHARE_FILES_MANIFEST_KEY,
    type ShareData
} from './lib/ShareTargetUtils';
import {
    BROADCAST_CHANNELS,
    MESSAGE_TYPES,
    STORAGE_KEYS,
    ROUTE_HASHES,
    COMPONENTS,
    isViewPostApiPath,
    viewBroadcastChannelName
} from 'com/config/Names';
import { summarizeForLog } from 'com/core/LogSanitizer';
import * as FestCore from "@fest-lib/core";

// ============================================================================
// SERVICE WORKER CONTENT ASSOCIATION SYSTEM
// ============================================================================

/**
 * Content contexts for service worker processing
 */
type SWContentContext =
    | 'share-target'
    | 'launch-queue'
    | 'push-message'
    | 'background-sync';

/**
 * Content actions for service worker
 */
type SWContentAction =
    | 'cache'          // Cache content for later delivery
    | 'process'        // Process immediately with AI
    | 'notify'         // Show notification to user
    | 'open-app'       // Open app with content
    | 'queue'          // Queue for later processing
    | 'broadcast';     // Broadcast to active clients

/**
 * Association conditions for service worker
 */
interface SWAssociationCondition {
    type: 'file-count' | 'content-size' | 'mime-type' | 'has-text' | 'has-files';
    value: string | number | boolean;
    match: 'equals' | 'gt' | 'lt' | 'contains' | 'exists';
}

/**
 * Content association rule for service worker
 */
interface SWContentAssociation {
    contentType: string;
    context: SWContentContext;
    action: SWContentAction;
    priority: number;
    conditions?: SWAssociationCondition[];
    immediate?: boolean; // Process immediately vs queue
}

/**
 * Service Worker Content Association Registry
 */
const SW_CONTENT_ASSOCIATIONS: SWContentAssociation[] = [
    // Share Target Associations
    { contentType: 'text', context: 'share-target', action: 'cache', priority: 100, immediate: true },
    { contentType: 'url', context: 'share-target', action: 'cache', priority: 95, immediate: true },
    { contentType: 'files', context: 'share-target', action: 'cache', priority: 90, immediate: true },
    { contentType: 'image', context: 'share-target', action: 'cache', priority: 85, immediate: true },

    // Launch Queue Associations
    { contentType: 'files', context: 'launch-queue', action: 'open-app', priority: 100, immediate: true },
    { contentType: 'text', context: 'launch-queue', action: 'open-app', priority: 95, immediate: true },

    // Push Message Associations
    { contentType: 'text', context: 'push-message', action: 'notify', priority: 100, immediate: true },
    { contentType: 'data', context: 'push-message', action: 'cache', priority: 90, immediate: false },

    // Background Sync Associations
    { contentType: 'any', context: 'background-sync', action: 'process', priority: 50, immediate: false }
];

/**
 * Check if association conditions are met
 */
function checkSWAssociationConditions(conditions: SWAssociationCondition[], content: any): boolean {
    return conditions.every(condition => {
        let contentValue: any;

        switch (condition.type) {
            case 'file-count':
                contentValue = content?.files?.length || 0;
                break;
            case 'content-size':
                contentValue = content?.text?.length || content?.size || 0;
                break;
            case 'mime-type':
                contentValue = content?.type || content?.mimeType || '';
                break;
            case 'has-text':
                contentValue = !!(content?.text?.trim());
                break;
            case 'has-files':
                contentValue = !!(content?.files?.length > 0);
                break;
            default:
                return false;
        }

        switch (condition.match) {
            case 'equals':
                return contentValue === condition.value;
            case 'gt':
                return Number(contentValue) > Number(condition.value);
            case 'lt':
                return Number(contentValue) < Number(condition.value);
            case 'contains':
                return String(contentValue).includes(String(condition.value));
            case 'exists':
                return Boolean(contentValue);
            default:
                return false;
        }
    });
}

/**
 * Pick the highest-priority worker action for a piece of incoming content.
 *
 * WHY: share-target, launch-queue, push, and background-sync payloads all
 * enter through different browser events but should be normalized through one
 * decision table before handlers run.
 */
function resolveSWContentAssociation(
    contentType: string,
    context: SWContentContext,
    content: any
): SWContentAssociation | null {

    // Find matching associations
    const matches = SW_CONTENT_ASSOCIATIONS
        .filter(assoc => (assoc.contentType === contentType || assoc.contentType === 'any') &&
                        assoc.context === context)
        .filter(assoc => !assoc.conditions || checkSWAssociationConditions(assoc.conditions, content))
        .sort((a, b) => b.priority - a.priority);

    return matches.length > 0 ? matches[0] : null;
}

/** Execute the worker action resolved by `resolveSWContentAssociation()`. */
async function processContentWithAssociation(
    contentType: string,
    context: SWContentContext,
    content: any,
    event?: any
): Promise<Response> {
    console.log('[SW-Association] Incoming content:', summarizeForLog({
        contentType,
        context,
        eventType: event?.type,
        hasContent: content != null,
        content
    }));
    const association = resolveSWContentAssociation(contentType, context, content);

    if (!association) {
        console.warn(`[SW-Association] No association found for ${contentType} in ${context}`);
        return new Response(null, { status: 302, headers: { Location: '/' } });
    }

    console.log(`[SW-Association] Resolved ${contentType} in ${context} -> ${association.action} (priority: ${association.priority})`);

    try {
        switch (association.action) {
            case 'cache':
                return await handleCacheAction(content, context, event);

            case 'process':
                return await handleProcessAction(content, context, event);

            case 'notify':
                return await handleNotifyAction(content, context, event);

            case 'open-app':
                return await handleOpenAppAction(content, context, event);

            case 'queue':
                return await handleQueueAction(content, context, event);

            case 'broadcast':
                return await handleBroadcastAction(content, context, event);

            default:
                console.warn(`[SW-Association] Unknown action: ${association.action}`);
                return new Response(null, { status: 302, headers: { Location: '/' } });
        }
    } catch (error) {
        console.error(`[SW-Association] Failed to execute ${association.action}:`, error);
        return new Response(null, { status: 302, headers: { Location: '/' } });
    }
}

// Action handlers
async function handleCacheAction(content: any, context: SWContentContext, _event?: any): Promise<Response> {
    try {
        // Cache the content for later retrieval by the main app
        const cacheKey = `sw-content-${context}-${Date.now()}`;
        const cache = await (self as any).caches?.open?.(SW_CONTENT_CACHE_NAME);

        if (cache) {
            await cache.put(toSWContentCacheRequest(cacheKey), new Response(JSON.stringify({
                content,
                context,
                timestamp: Date.now(),
                cacheKey
            }), {
                headers: { 'Content-Type': 'application/json' }
            }));
        }

        // Store cache key for main app to retrieve
        const cacheKeys = await getStoredCacheKeys();
        cacheKeys.push({ key: cacheKey, context, timestamp: Date.now() });
        await storeCacheKeys(cacheKeys.slice(-50)); // Keep last 50

        // Broadcast to active clients
        await broadcastToClients('content-cached', { cacheKey, context, content });

        // Determine redirect location based on context
        let redirectLocation: string;
        if (context === 'share-target') {
            // For share-target, redirect to specific basic app route
            const routeHash = determineShareTargetRoute(content);
            redirectLocation = `/basic${routeHash}?cached=${cacheKey}`;
        } else {
            // Default behavior for other contexts
            redirectLocation = `/?cached=${cacheKey}`;
        }

        console.log('[SW-Cache] Cached pipeline content:', summarizeForLog({
            context,
            cacheKey,
            redirectLocation,
            content
        }));

        return new Response(null, {
            status: 302,
            headers: { Location: redirectLocation }
        });

    } catch (error) {
        console.error('[SW-Cache] Failed to cache content:', error);
        throw error;
    }
}

async function handleProcessAction(content: any, context: SWContentContext, event?: any): Promise<Response> {
    // For now, cache and let main app process
    console.log('[SW-Process] Queuing content for processing:', context);
    return await handleCacheAction(content, context, event);
}

async function handleNotifyAction(content: any, context: SWContentContext, event?: any): Promise<Response> {
    try {
        // Show notification
        const notificationOptions: NotificationOptions = {
            body: content.text?.substring(0, 100) || 'Content received',
            icon: '/icons/icon.png',
            badge: '/icons/icon.png',
            tag: `sw-${context}-${Date.now()}`,
            requireInteraction: false,
            silent: false
        };

        await (self as any).registration?.showNotification?.('CWSP-shell', notificationOptions);

        // Also cache the content
        return await handleCacheAction(content, context, event);

    } catch (error) {
        console.error('[SW-Notify] Failed to show notification:', error);
        throw error;
    }
}

async function handleOpenAppAction(content: any, context: SWContentContext, event?: any): Promise<Response> {
    try {
        // Cache content first
        await handleCacheAction(content, context, event);

        // Try to focus existing window or open new one
        const clients = await (self as any).clients?.matchAll?.({ type: 'window' });

        // Determine the target URL based on context
        let targetUrl: string;
        if (context === 'share-target') {
            const routeHash = determineShareTargetRoute(content);
            targetUrl = `/basic${routeHash}`;
        } else {
            targetUrl = `/?context=${context}`;
        }

        if (clients?.length > 0) {
            // Focus existing window
            await clients[0].focus();
            return new Response(null, {
                status: 302,
                headers: { Location: targetUrl }
            });
        } else {
            // Open new window
            await (self as any).clients?.openWindow?.(targetUrl);
            return new Response(null, { status: 200 });
        }

    } catch (error) {
        console.error('[SW-OpenApp] Failed to open app:', error);
        throw error;
    }
}

async function handleQueueAction(content: any, context: SWContentContext, event?: any): Promise<Response> {
    // Queue for background sync
    console.log('[SW-Queue] Queuing content for background sync:', context);
    return await handleCacheAction(content, context, event);
}

async function handleBroadcastAction(content: any, context: SWContentContext, event?: any): Promise<Response> {
    try {
        await broadcastToClients('content-received', { content, context });
        return await handleCacheAction(content, context, event);
    } catch (error) {
        console.error('[SW-Broadcast] Failed to broadcast:', error);
        throw error;
    }
}

// ============================================================================
// ROUTE DETERMINATION FOR SHARE TARGET
// ============================================================================

/**
 * Determine the appropriate route hash based on share-target content
 */
function determineShareTargetRoute(content: any): string {
    // Determine content type
    let contentType = 'text';
    if (content.files?.length > 0) {
        // Check if files are images
        const hasImages = content.files.some((file: any) => file.type?.startsWith('image/'));
        if (hasImages) {
            contentType = 'image';
        } else {
            contentType = 'file';
        }
    } else if (content.url) {
        contentType = 'url';
    }

    // Map content type to route hash
    let routeHash: string;
    switch (contentType) {
        case 'image':
            routeHash = ROUTE_HASHES.SHARE_TARGET_IMAGE;
            break;
        case 'file':
            routeHash = ROUTE_HASHES.SHARE_TARGET_FILES;
            break;
        case 'url':
            routeHash = ROUTE_HASHES.SHARE_TARGET_URL;
            break;
        case 'text':
        default:
            routeHash = ROUTE_HASHES.SHARE_TARGET_TEXT;
            break;
    }

    console.log('[ShareTarget] Route decision:', {
        contentType,
        routeHash,
        fileCount: content?.files?.length || 0,
        hasUrl: !!content?.url
    });

    return routeHash;
}

// Cache key management
interface CacheKeyEntry {
    key: string;
    context: SWContentContext;
    timestamp: number;
}

const CACHE_KEYS_DB_NAME = 'sw-cache-keys';
const CACHE_KEYS_STORE_NAME = 'keys';
const SW_CONTENT_CACHE_NAME = 'sw-content-cache';
const SW_CONTENT_CACHE_PREFIX = '/__sw-content/';

const toSWContentCacheRequest = (cacheKey: string): string => {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) {
        throw new Error('Invalid SW cache key');
    }

    // Use canonical URL keys for Cache API stability.
    const safeKey = normalizedKey.replace(/^\/+/, '');
    return new URL(`${SW_CONTENT_CACHE_PREFIX}${encodeURIComponent(safeKey)}`, self.location.origin).toString();
};

const toCacheRequestInfo = (requestLike: RequestInfo | URL | null | undefined): RequestInfo | undefined => {
    if (!requestLike) return undefined;
    return requestLike instanceof URL ? requestLike.toString() : requestLike;
};

const safeCacheMatch = async (
    cache: Cache | null | undefined,
    requestLike: RequestInfo | URL | null | undefined
): Promise<Response | undefined> => {
    const request = toCacheRequestInfo(requestLike);
    if (!cache || !request) return undefined;
    /** Cache#match rejects non-Request / non-string (minified callers may pass plain objects). */
    const key =
        typeof request === 'string'
            ? request
            : request instanceof Request
              ? request
              : undefined;
    if (!key) return undefined;
    try {
        return await cache?.match?.(key);
    } catch (error) {
        console.warn('[SW] Cache.match failed:', request, error);
        return undefined;
    }
};

const safeCachesMatch = async (requestLike: RequestInfo | URL | null | undefined): Promise<Response | undefined> => {
    const request = toCacheRequestInfo(requestLike);
    if (!request) return undefined;
    try {
        return await caches?.match?.(request);
    } catch (error) {
        console.warn('[SW] caches.match failed:', request, error);
        return undefined;
    }
};

const safeIsUserScopePath = (pathname: string): boolean => {
    try {
        const fn = (FestCore as any)?.isUserScopePath;
        if (typeof fn === "function") return fn(pathname);
    } catch {}
    return pathname === "/user" || pathname.startsWith("/user/");
};

const safeToUserRelativePath = (pathname: string): string => {
    try {
        const fn = (FestCore as any)?.toUserRelativePath;
        if (typeof fn === "function") return fn(pathname);
    } catch {}
    const normalized = String(pathname || "").trim().replace(/\/+/g, "/");
    if (normalized === "/user") return "";
    if (normalized.startsWith("/user/")) return normalized.slice("/user/".length);
    return normalized.replace(/^\/+/, "");
};

const toUserOpfsPath = (pathname: string): string => {
    try {
        return decodeURIComponent(safeToUserRelativePath(pathname));
    } catch {
        return safeToUserRelativePath(pathname);
    }
};

const USER_OPFS_RESPONSE_HEADERS = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Source": "opfs-user"
};

const isOpfsNotFoundError = (error: any): boolean => {
    return error?.name === "NotFoundError" || /not found/i.test(String(error?.message || ""));
};

const jsonUserOpfsResponse = (payload: any, status = 200): Response => {
    return new Response(JSON.stringify(payload), {
        status,
        headers: USER_OPFS_RESPONSE_HEADERS
    });
};

const userOpfsNotFoundResponse = (pathname: string, method = "GET"): Response => {
    return jsonUserOpfsResponse({
        ok: false,
        error: "OPFS_NOT_FOUND",
        status: 404,
        method,
        path: pathname
    }, 404);
};

const readUserOpfsFile = async (pathname: string): Promise<File | null> => {
    try {
        const relPath = toUserOpfsPath(pathname);
        if (!relPath || relPath.endsWith("/")) return null;
        const parts = relPath.split("/").filter(Boolean);
        const filename = parts.pop();
        if (!filename) return null;

        let dir = await navigator.storage.getDirectory();
        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, { create: false });
        }
        const handle = await dir.getFileHandle(filename, { create: false });
        return await handle.getFile();
    } catch {
        return null;
    }
};

const listUserOpfsEntries = async (pathname: string): Promise<Array<{ name: string; kind: "file" | "directory" }>> => {
    try {
        const relPath = toUserOpfsPath(pathname);
        let dir = await navigator.storage.getDirectory();
        for (const part of relPath.split("/").filter(Boolean)) {
            dir = await dir.getDirectoryHandle(part, { create: false });
        }

        const entries: Array<{ name: string; kind: "file" | "directory" }> = [];
        for await (const [name, entry] of dir.entries()) {
            entries.push({ name, kind: entry.kind as "file" | "directory" });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return entries;
    } catch {
        return [];
    }
};

const writeUserOpfsFile = async (pathname: string, request: Request): Promise<{ path: string; size: number; type: string; }> => {
    const relPath = toUserOpfsPath(pathname);
    const parts = relPath.split("/").filter(Boolean);
    const explicitName = new URL(request.url).searchParams.get("name")?.trim()
        || request.headers.get("X-File-Name")?.trim()
        || request.headers.get("X-Filename")?.trim();

    const isDirectoryTarget = pathname.endsWith("/") || !parts.length;
    const fileName = isDirectoryTarget ? explicitName : parts.pop();
    if (!fileName) throw new Error("Missing filename. Provide it in path or ?name=.");

    let dir = await navigator.storage.getDirectory();
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
    }

    const blob = await request.blob();
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return {
        path: `${pathname.replace(/\/+$/, "")}/${fileName}`.replace(/\/+/g, "/"),
        size: blob.size,
        type: blob.type || "application/octet-stream"
    };
};

const deleteUserOpfsEntry = async (pathname: string, recursive = true): Promise<void> => {
    const relPath = toUserOpfsPath(pathname).replace(/\/+$/g, "");
    const parts = relPath.split("/").filter(Boolean);
    if (!parts.length) throw new Error("Refusing to delete /user root.");
    const entryName = parts.pop() as string;

    let dir = await navigator.storage.getDirectory();
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: false });
    }
    await dir.removeEntry(entryName, { recursive });
};

async function getStoredCacheKeys(): Promise<CacheKeyEntry[]> {
    try {
        const db = await openCacheKeysDB();
        return new Promise((resolve) => {
            const transaction = db.transaction([CACHE_KEYS_STORE_NAME], 'readonly');
            const store = transaction.objectStore(CACHE_KEYS_STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
        });
    } catch (error) {
        console.warn('[SW-CacheKeys] Failed to get stored keys:', error);
        return [];
    }
}

async function storeCacheKeys(keys: CacheKeyEntry[]): Promise<void> {
    try {
        const db = await openCacheKeysDB();
        const transaction = db.transaction([CACHE_KEYS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(CACHE_KEYS_STORE_NAME);

        // Clear existing
        await new Promise((resolve) => {
            const clearRequest = store.clear();
            clearRequest.onsuccess = resolve;
            clearRequest.onerror = resolve;
        });

        // Add new keys
        for (const key of keys) {
            store.add(key);
        }
    } catch (error) {
        console.warn('[SW-CacheKeys] Failed to store keys:', error);
    }
}

function openCacheKeysDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CACHE_KEYS_DB_NAME, 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as any).result;
            if (!db.objectStoreNames.contains(CACHE_KEYS_STORE_NAME)) {
                db.createObjectStore(CACHE_KEYS_STORE_NAME, { keyPath: 'key' });
            }
        };
    });
}

// Broadcast to active clients
async function broadcastToClients(type: string, data: any): Promise<void> {
    try {
        const clients = await (self as any).clients?.matchAll?.();
        if (clients) {
            for (const client of clients) {
                client.postMessage({ type, data });
            }
        }
    } catch (error) {
        console.warn('[SW-Broadcast] Failed to broadcast to clients:', error);
    }
}

// (Share target AI processing uses executionCore; no direct image conversion needed here.)

//
/** When true, this is the Vite dev worker (`/dev-sw.js`): precache + SWR would freeze HMR and the speed-dial shell. */
const isViteDevServiceWorker = import.meta.env.DEV;

// @ts-ignore
const manifest = self.__WB_MANIFEST;
cleanupOutdatedCaches();
if (manifest && !isViteDevServiceWorker) {
    const filteredManifest = manifest.filter((entry: any) => {
        const url = typeof entry === "string" ? entry : String(entry?.url || "");
        // icon.ico is non-critical and intermittently 408s in some deploys;
        // keep SW install resilient by excluding it from hard precache.
        return !/\/pwa\/icons\/icon\.ico(?:$|\?)/i.test(url);
    });
    precacheAndRoute(filteredManifest);
}

// Broadcast channel names (using centralized naming system)
const CHANNELS = {
    SHARE_TARGET: BROADCAST_CHANNELS.SHARE_TARGET,
    TOAST: BROADCAST_CHANNELS.TOAST,
    CLIPBOARD: BROADCAST_CHANNELS.CLIPBOARD
} as const;

// Clipboard queue storage for persistent delivery using IDB
interface ClipboardOperation {
    id: string;
    data: unknown;
    options?: any;
    timestamp: number;
    type: 'ai-result' | 'direct-copy';
}

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

// Broadcast helpers for cross-context communication
// These send messages to the frontend via BroadcastChannel
const toCanonicalSwBroadcastEnvelope = (channel: string, message: unknown): unknown => {
    const canonicalProtocol = "worker";
    const legacyTransport = "service-worker:http";
    if (!message || typeof message !== 'object') {
        const id = crypto.randomUUID();
        return {
            id,
            uuid: id,
            source: 'service-worker',
            sender: 'service-worker',
            destination: channel,
            destinations: [channel],
            protocol: canonicalProtocol,
            transport: legacyTransport,
            op: 'notify',
            what: 'sw:broadcast',
            type: 'sw:broadcast',
            payload: message,
            data: message,
            timestamp: Date.now(),
            ids: { byId: 'service-worker', from: 'service-worker', sender: 'service-worker', destinations: [channel] },
            flags: { canonicalV2: true },
        };
    }
    const base = message as Record<string, unknown>;
    const id = typeof base.id === 'string' && base.id.trim() ? base.id.trim() : crypto.randomUUID();
    const sender = typeof base.sender === 'string' && base.sender.trim()
        ? base.sender.trim()
        : (typeof base.source === 'string' && base.source.trim() ? base.source.trim() : 'service-worker');
    const op = typeof base.op === 'string' && base.op.trim()
        ? base.op.trim()
        : (typeof base.type === 'string' && String(base.type).startsWith('request:')
            ? 'request'
            : typeof base.type === 'string' && String(base.type).startsWith('response:')
              ? 'response'
              : 'notify');
    return {
        ...base,
        id,
        uuid: typeof base.uuid === 'string' && base.uuid.trim() ? base.uuid.trim() : id,
        source: typeof base.source === 'string' && base.source.trim() ? base.source.trim() : sender,
        sender,
        destination: typeof base.destination === 'string' && base.destination.trim() ? base.destination.trim() : channel,
        destinations: Array.isArray(base.destinations) && base.destinations.length ? base.destinations : [channel],
        protocol: typeof base.protocol === 'string' && base.protocol.trim() ? base.protocol.trim() : canonicalProtocol,
        transport: typeof base.transport === 'string' && base.transport.trim() ? base.transport.trim() : legacyTransport,
        op,
        what: typeof base.what === 'string' && base.what.trim() ? base.what.trim() : String(base.type || 'sw:broadcast'),
        type: typeof base.type === 'string' && base.type.trim() ? base.type.trim() : String(base.what || 'sw:broadcast'),
        payload: base.payload ?? base.data ?? base,
        data: base.data ?? base.payload ?? base,
        timestamp: Number(base.timestamp || 0) > 0 ? Number(base.timestamp) : Date.now(),
        ids: (base.ids && typeof base.ids === 'object')
            ? base.ids
            : { byId: sender, from: sender, sender, destinations: Array.isArray(base.destinations) ? base.destinations : [channel] },
        flags: (base.flags && typeof base.flags === 'object') ? base.flags : { canonicalV2: true },
    };
};

const broadcast = (channel: string, message: unknown): void => {
    try {
        const bc = new BroadcastChannel(channel);
        bc.postMessage(toCanonicalSwBroadcastEnvelope(channel, message));
        bc.close();
    } catch (e) { console.warn(`[SW] Broadcast to ${channel} failed:`, e); }
};

/**
 * Send toast notification to frontend for display
 * Frontend must have initToastReceiver() active to receive
 */
const sendToast = (message: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info', duration = 3000): void => {
    broadcast(CHANNELS.TOAST, { type: 'show-toast', options: { message, kind, duration } });
};


/**
 * Notify frontend about received share target data
 */
const notifyShareReceived = (data: unknown): void => {
    broadcast(CHANNELS.SHARE_TARGET, { type: 'share-received', data });
};

/**
 * Notify frontend about AI processing result
 */
const notifyAIResult = (result: { success: boolean; data?: unknown; error?: string }): void => {
    broadcast(CHANNELS.SHARE_TARGET, { type: 'ai-result', data: result });
};

/**
 * Store clipboard operation for persistent delivery using IDB
 */
const storeClipboardOperation = async (operation: ClipboardOperation): Promise<void> => {
    try {
        const db = await openClipboardDB();
        const transaction = db.transaction([CLIPBOARD_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(CLIPBOARD_STORE_NAME);

        // Add new operation
        await new Promise<void>((resolve, reject) => {
            const request = store.put(operation);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        // Keep only last 10 operations to prevent bloat
        const countRequest = store.count();
        const count = await new Promise<number>((resolve, reject) => {
            countRequest.onsuccess = () => resolve(countRequest.result);
            countRequest.onerror = () => reject(countRequest.error);
        });

        if (count > 10) {
            // Get oldest operations and delete them
            const index = store.index('timestamp');
            const cursorRequest = index.openCursor(null, 'next'); // Ascending order (oldest first)

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
        console.log('[SW] Stored clipboard operation:', operation.id);
    } catch (error) {
        console.warn('[SW] Failed to store clipboard operation:', error);
    }
};

/**
 * Get stored clipboard operations from IDB
 */
const getStoredClipboardOperations = async (): Promise<ClipboardOperation[]> => {
    try {
        const db = await openClipboardDB();
        const transaction = db.transaction([CLIPBOARD_STORE_NAME], 'readonly');
        const store = transaction.objectStore(CLIPBOARD_STORE_NAME);

        const operations = await new Promise<ClipboardOperation[]>((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const results = request.result || [];
                // Sort by timestamp (newest first)
                results.sort((a, b) => b.timestamp - a.timestamp);
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });

        db.close();
        return operations;
    } catch (error) {
        console.warn('[SW] Failed to get stored clipboard operations:', error);
        return [];
    }
};

/**
 * Clear stored clipboard operations from IDB
 */
const clearStoredClipboardOperations = async (): Promise<void> => {
    try {
        const db = await openClipboardDB();
        const transaction = db.transaction([CLIPBOARD_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(CLIPBOARD_STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        db.close();
        console.log('[SW] Cleared clipboard operations');
    } catch (error) {
        console.warn('[SW] Failed to clear clipboard operations:', error);
    }
};

/**
 * Remove specific clipboard operation from IDB
 */
const removeClipboardOperation = async (operationId: string): Promise<void> => {
    try {
        const db = await openClipboardDB();
        const transaction = db.transaction([CLIPBOARD_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(CLIPBOARD_STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const request = store.delete(operationId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        db.close();
        console.log('[SW] Removed clipboard operation:', operationId);
    } catch (error) {
        console.warn('[SW] Failed to remove clipboard operation:', error);
    }
};

/**
 * Try to parse JSON and extract recognized content
 * AI returns JSON like {"recognized_data": [...], "verbose_data": "..."}
 * We want to extract just the actual content for clipboard
 */
const tryParseJSON = (data: unknown): unknown => {
    if (typeof data !== 'string') return null;
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
};

export const extractRecognizedContent = (data: unknown): unknown => {
    // If it's already a string that's not JSON, return as-is
    if (typeof data === 'string') {
        const parsed = tryParseJSON(data);
        if (parsed && typeof parsed === 'object') {
            // Extract content from recognized_data field
            const obj = parsed as Record<string, unknown>;

            // Priority: recognized_data > verbose_data > data itself
            if (obj.recognized_data != null) {
                const rd = obj.recognized_data;
                // If it's an array, join the elements
                if (Array.isArray(rd)) {
                    return rd.map(item =>
                        typeof item === 'string' ? item : JSON.stringify(item)
                    ).join('\n');
                }
                return typeof rd === 'string' ? rd : JSON.stringify(rd);
            }

            if (typeof obj.verbose_data === 'string' && obj.verbose_data.trim()) {
                return obj.verbose_data;
            }

            // No recognized_data, return original data
            return data;
        }
        // Not JSON, return as-is
        return data;
    }

    // If it's an object, try to extract recognized_data
    if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        if (obj.recognized_data != null) {
            const rd = obj.recognized_data;
            if (Array.isArray(rd)) {
                return rd.map(item =>
                    typeof item === 'string' ? item : JSON.stringify(item)
                ).join('\n');
            }
            return typeof rd === 'string' ? rd : JSON.stringify(rd);
        }
        if (typeof obj.verbose_data === 'string' && obj.verbose_data.trim()) {
            return obj.verbose_data;
        }
    }

    return data;
};

// ============================================================================
// ASSET CACHE MANAGEMENT
// ============================================================================

// Track asset versions for cache busting
const ASSET_VERSIONS = new Map<string, string>();

/**
 * Enhanced fetch handler with cache busting and version tracking
 */
async function handleAssetRequest(arg: any): Promise<Response> {
    const request: Request = arg?.request ?? arg;
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle critical app assets with special caching logic
    const isCriticalAsset = pathname.endsWith('.js') ||
                           pathname.endsWith('.css') ||
                           pathname.endsWith('.svg') ||
                           pathname.endsWith('.png') ||
                           pathname === '/sw.js';

    if (isCriticalAsset) {
        try {
            // Try to fetch fresh version first
            const response = await fetch(request, {
                cache: 'no-cache',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });

            if (response.ok) {
                // Check if asset has changed
                const etag = response.headers.get('etag');
                const lastModified = response.headers.get('last-modified');
                const versionKey = `${etag || ''}-${lastModified || ''}`;

                const storedVersion = ASSET_VERSIONS.get(pathname);
                if (storedVersion && storedVersion !== versionKey) {
                    console.log(`[SW] Asset updated: ${pathname}`);

                    // Notify clients about asset update
                    notifyClients('asset-updated', {
                        url: pathname,
                        oldVersion: storedVersion,
                        newVersion: versionKey
                    });
                }

                ASSET_VERSIONS.set(pathname, versionKey);

                // Cache the fresh response
                const cache = await caches.open('crossword-assets-v1');
                cache.put(request, response.clone());

                return response;
            }
        } catch (error) {
            console.warn(`[SW] Failed to fetch fresh asset: ${pathname}`, error);
        }

        // Fallback to cache
        const cache = await caches.open('crossword-assets-v1');
        const cachedResponse = await safeCacheMatch(cache, request);
        if (cachedResponse) {
            console.log(`[SW] Serving cached asset: ${pathname}`);
            return cachedResponse;
        }
    }

    // Default handling for other requests
    return fetch(request);
}

// ============================================================================
// SHARE TARGET PROCESSING
// ============================================================================

/**
 * Process share data with AI directly (bypass FormData wrapping)
 */
const processShareWithAI = async (
    shareData: ShareData,
    config: { mode: 'recognize' | 'analyze'; customInstruction: string }
): Promise<{ success: boolean; results?: any[]; error?: string }> => {
    console.log('[ShareTarget] Processing with direct GPT calls, mode:', config.mode);

    try {
        // Use execution core for unified processing.
        // Mode and instruction are resolved from settings/context; SW still passes mode for logging and errors.
        const processingResult = await processShareTargetWithExecutionCore(shareData);

        if (processingResult.success && processingResult.result) {
            // Broadcast the result for immediate clipboard copy (frontend receiver handles actual clipboard)
            notifyAIResult({
                success: true,
                data: processingResult.result.content
            });

            // Store for persistent delivery if frontend wasn't ready
            await storeClipboardOperation({
                id: `${config.mode}-${Date.now()}`,
                data: processingResult.result.content,
                type: 'ai-result',
                timestamp: Date.now()
            });

            return { success: true, results: [processingResult.result] };
        }

        const errMsg = processingResult.error || `${config.mode} failed`;
        notifyAIResult({ success: false, error: errMsg });
        return { success: false, results: [], error: errMsg };

    } catch (error: any) {
        console.error('[ShareTarget] Direct AI processing error:', error);
        throw error;
    }
};

/**
 * Match share target URLs (handles both hyphen and underscore variants)
 */
const isShareTargetUrl = (pathname: string): boolean =>
    pathname === '/share-target' || pathname === '/share_target';

/**
 * POST /{view} — in-app API: body is broadcast on `rs-view-{view}` for the target web component / shell.
 * GET /{view} remains the SPA shell document route (handled by precache / network).
 */
registerRoute(
    ({ url, request }) => request?.method === 'POST' && !!isViewPostApiPath(url?.pathname || ''),
    async (workboxEvent: any) => {
        const request: Request = workboxEvent?.request ?? workboxEvent;
        const pathname = new URL(request.url).pathname;
        const viewId = isViewPostApiPath(pathname);
        if (!viewId) {
            return fetch(request);
        }
        try {
            const bodyText = await request.text();
            const contentType = request.headers.get('content-type') || '';
            const payload = {
                type: 'view-post',
                viewId,
                bodyText,
                contentType
            };
            broadcast(viewBroadcastChannelName(viewId), payload);
            return new Response(JSON.stringify({ ok: true, viewId }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                }
            });
        } catch (err: any) {
            return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
    },
    'POST'
);

/**
 * Share target handler with optional AI processing
 * Note: Share targets only work when PWA is installed and service worker is active
 */
registerRoute(({ url, request }) => isShareTargetUrl(url?.pathname) && request?.method === 'POST', async (e: any) => {
    const request = e?.request ?? e?.event?.request ?? e;

    console.log('[ShareTarget] Handler called for:', request?.url);
    console.log('[ShareTarget] Content-Type:', request?.headers?.get?.('content-type') ?? 'none');

    try {
        // Step 1: Parse request data
        const { formData, error } = await parseFormDataFromRequest(request);
        console.log('[ShareTarget] FormData:', summarizeForLog(formData));
        console.log('[ShareTarget] Error:', summarizeForLog(error));

        if (!formData) {
            console.warn('[ShareTarget] No valid data received:', error);
            return new Response(null, { status: 302, headers: { Location: '/' } });
        }

        // Step 2: Build share data from form
        const shareData = await buildShareData(formData);
        console.log('[ShareTarget] Share data:', summarizeForLog(shareData));
        logShareDataSummary(shareData);

        // Step 3: Cache for client retrieval
        await cacheShareData(shareData);
        console.log('[ShareTarget] Cache share data:', summarizeForLog(shareData));

        const aiConfig = await getAIProcessingConfig();
        console.log('[ShareTarget] AI processing config:', aiConfig);

        // Step 4: Broadcast to clients (include text content for frontend fallback)
        notifyShareReceived?.({
            title: shareData.title,
            text: shareData.text,
            url: shareData.url,
            timestamp: shareData.timestamp,
            fileCount: shareData.files.length,
            imageCount: shareData.imageFiles.length,
            // Mark whether AI will process this
            aiEnabled: aiConfig.enabled
        });

        // Step 5: AI Processing (async, non-blocking)
        console.log('[ShareTarget] AI processing config:', aiConfig);
        console.log('[ShareTarget] Share data:', summarizeForLog(shareData));
        console.log('[ShareTarget] Has processable content:', hasProcessableContent(shareData));

        if (aiConfig.enabled && hasProcessableContent(shareData)) {
            console.log('[ShareTarget] Starting async AI processing, mode:', aiConfig.mode);

            // Set up timeout for long-running AI requests in service worker
            const aiTimeout = setTimeout(() => {
                console.warn('[ShareTarget] AI processing timeout - service worker may terminate connection');
                // Don't cancel the request, just log the warning
                // The request will continue in the background if possible
            }, 4 * 60 * 1000); // 4 minutes warning

            // Start AI processing asynchronously without blocking the response
            processShareWithAI(shareData, {
                mode: aiConfig.mode,
                customInstruction: aiConfig.customInstruction
            }).then((result) => {
                clearTimeout(aiTimeout);
                console.log('[ShareTarget] Async AI processing completed:', summarizeForLog(result));

                if (result.success && result.results?.length) {
                    // Extract the actual data from results
                    const firstResult = result.results[0];
                    const extractedData = firstResult?.data?.data || firstResult?.data || firstResult;
                    console.log('[ShareTarget] Async AI processing extracted data:', summarizeForLog(extractedData));

                    // Broadcast success to frontend
                    notifyAIResult({
                        success: true,
                        data: extractedData
                    });

                    // Show success toast
                    const message = aiConfig.mode === 'analyze'
                        ? 'Content analyzed and processed'
                        : 'Content recognized and copied';
                    sendToast(message, 'success');
                } else {
                    // Broadcast failure to frontend
                    const errorMsg = result.error || 'No results returned';
                    notifyAIResult({ success: false, error: errorMsg });
                    console.log('[ShareTarget] Async AI processing failed:', errorMsg);
                }
            }).catch((aiError: any) => {
                const errorMsg = aiError?.message || 'Unknown error';
                console.error('[ShareTarget] Async AI processing error:', aiError);

                // Broadcast error to frontend
                notifyAIResult({ success: false, error: errorMsg });

                // Show error toast
                sendToast(`${aiConfig.mode === 'analyze' ? 'Analysis' : 'Recognition'} failed: ${errorMsg}`, 'error');
            });

            // Show initial processing toast immediately
            sendToast('Processing shared content...', 'info');
        } else {
            // No AI processing configured or no processable content
            const hasApiKey = aiConfig.apiKey !== null;
            const message = hasApiKey
                ? 'Content received'
                : 'Content received (configure AI for auto-processing)';
            sendToast(message, 'info');
        }

        // Step 7: Redirect to app
        return new Response(null, {
            status: 302,
            // Prefer share-target entry path (SPA), then app decides how to handle.
            headers: { Location: '/share-target?shared=1' }
        });
    } catch (err: any) {
        console.error('[ShareTarget] Handler error:', err);
        sendToast('Share handling failed', 'error');
        return new Response(null, { status: 302, headers: { Location: '/' } });
    }
}, "POST")

// ============================================================================
// DEV/VITE MODULE BYPASS
// ============================================================================

// Avoid Workbox caching/intercepting Vite dev ESM modules and internal endpoints.
// This prevents "Failed to fetch dynamically imported module" on lazy imports like WorkCenter.ts.
registerRoute(
    ({ url }) => {
        const p = url?.pathname || "";
        return (
            p.startsWith("/src/") ||
            p.startsWith("/@") ||
            p.startsWith("/node_modules/") ||
            p.startsWith("/__vite") ||
            p.startsWith("/vite") ||
            p.startsWith("/@fs/")
        );
    },
    new NetworkOnly({
        fetchOptions: {
            credentials: 'same-origin',
            cache: 'no-store',
        }
    })
);

// Never cache/proxy local-network control channels.
// WHY: connection bugs here often look like "socket transport failed" even when
// the real issue is the service worker intercepting probe/control traffic.
registerRoute(
    ({ url }) => {
        const host = url?.hostname || '';
        const pathname = url?.pathname || '';
        const isPrivateIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && (
            host.startsWith('10.') ||
            host.startsWith('192.168.') ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
            host.startsWith('127.') ||
            /** CGNAT / Tailscale-style 100.64.0.0/10 — same bypass as LAN for AirPad */
            /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
        );
        const isLocalHost = host === 'localhost' || host.endsWith('.local');
        const isSocketIoPath = pathname === '/socket.io' || pathname.startsWith('/socket.io/');
        const isControlPath =
            pathname.startsWith('/api/') ||
            pathname === '/lna-probe' ||
            isSocketIoPath;

        // Socket.IO transport must bypass SW caching/proxy on all hosts (LAN + WAN),
        // otherwise polling/ws handshakes can fail with synthetic SW network errors.
        if (isSocketIoPath) return true;

        // LNA / PNA probe — same as socket.io: never let Workbox/cache touch it (any host).
        if (pathname === '/lna-probe') return true;

        // Avoid swallowing app/view and /user/* requests on private-host deployments.
        return isControlPath && (isPrivateIp || isLocalHost);
    },
    new NetworkOnly({
        fetchOptions: {
            cache: 'no-store',
            credentials: 'same-origin',
        }
    })
);

//
if (isViteDevServiceWorker) {
    setDefaultHandler(
        new NetworkOnly({
            fetchOptions: {
                credentials: "same-origin",
                cache: "no-store",
            },
        })
    );
} else {
    setDefaultHandler(
        new StaleWhileRevalidate({
            cacheName: "default-cache",
            fetchOptions: {
                // Never force credentials=include for cross-origin requests (breaks many CDNs with ACAO="*").
                // same-origin keeps cookies for same-origin only.
                credentials: "same-origin",
                priority: "auto",
                cache: "force-cache",
            },
            plugins: [
                new ExpirationPlugin({
                    maxEntries: 120,
                    maxAgeSeconds: 1800,
                }),
            ],
        })
    );
}

// Assets (JS/CSS) — skip in dev so requests are not handled by NetworkFirst + workbox cache before the default handler.
registerRoute(
    ({ url, request }) =>
        !isViteDevServiceWorker &&
        !safeIsUserScopePath(url?.pathname || "") &&
        (request?.destination === "script" ||
            request?.destination === "style" ||
            request?.destination === "worker" ||
            request?.url?.trim?.().toLowerCase?.()?.match?.(/(\.m?js|\.css)$/)),
    new NetworkFirst({
        cacheName: "assets-cache",
        fetchOptions: {
            credentials: "same-origin",
            priority: "high",
            cache: "default",
        },
        plugins: [
            new ExpirationPlugin({
                maxEntries: 120,
                maxAgeSeconds: 1800,
            }),
        ],
    })
);

// ============================================================================
// UI ICONS (Phosphor CDN + same-origin /assets/icons) — complements OPFS in the app
// ============================================================================
// fetch() from the page (fest/icon Loader) is intercepted here. CacheFirst on
// versioned npm URLs yields the fastest repeat loads; same-origin uses SWR so
// deploys can refresh without a month-long stale window. credentials: omit on
// CDN matches the Loader and avoids ACAO=* + credentials issues.

const isPhosphorCdnSvgUrl = (url: URL): boolean => {
    const p = (url.pathname || "").toLowerCase();
    if (!p.endsWith(".svg")) return false;
    const h = url.hostname || "";
    if (h === "cdn.jsdelivr.net" && p.includes("@phosphor-icons")) return true;
    if (h === "unpkg.com" && p.includes("@phosphor-icons")) return true;
    return false;
};

const isSameOriginAppIconSvgUrl = (url: URL): boolean => {
    try {
        if (url.origin !== self.location.origin) return false;
    } catch {
        return false;
    }
    const p = url.pathname || "";
    if (!/\.svg$/i.test(p)) return false;
    return /^\/assets\/icons\//i.test(p) || /^\/assets\/phosphor\//i.test(p);
};

registerRoute(
    ({ url, request }) => request?.method === "GET" && isPhosphorCdnSvgUrl(url),
    new CacheFirst({
        cacheName: "ui-icons-cdn-v1",
        fetchOptions: {
            credentials: "omit",
            mode: "cors",
            priority: "low",
            cache: "default",
        },
        plugins: [
            new ExpirationPlugin({
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
            }),
        ],
    })
);

registerRoute(
    ({ url, request }) =>
        request?.method === "GET" &&
        isSameOriginAppIconSvgUrl(url) &&
        !safeIsUserScopePath(url?.pathname || ""),
    new StaleWhileRevalidate({
        cacheName: "ui-icons-origin-v1",
        fetchOptions: {
            credentials: "same-origin",
            mode: "cors",
            priority: "high",
            cache: "default",
        },
        plugins: [
            new ExpirationPlugin({
                maxEntries: 150,
                maxAgeSeconds: 60 * 60 * 24 * 7,
                purgeOnQuotaError: true,
            }),
        ],
    })
);

// Images
registerRoute(
    ({ url, request }) => (
        !safeIsUserScopePath(url?.pathname || "") &&
        (
            request?.destination === 'image' ||
            request?.url?.trim?.().toLowerCase?.()?.match?.(/(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg)$/i)
        )
    ),
    new StaleWhileRevalidate({
        cacheName: 'image-cache',
        fetchOptions: {
            credentials: 'same-origin',
            priority: 'auto',
            cache: 'force-cache'
        },
        plugins: [
            new ExpirationPlugin({
                maxEntries: 100,
                maxAgeSeconds: 24 * 60 * 60 // 1 day
            })
        ]
    })
);

// Test route to verify service worker API routing
registerRoute(
    ({ url, request }) => url?.pathname === '/api/test' && request?.method === 'GET',
    async () => {
        console.log('[SW] Test API route hit');
        return new Response(JSON.stringify({
            success: true,
            message: 'Service Worker API routing is working',
            timestamp: new Date().toISOString(),
            source: 'service-worker'
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
);

// Unified Processing API (for PWA processing support)
registerRoute(
    ({ url, request }) => url?.pathname === '/api/processing' && request?.method === 'POST',
    async ({ request }) => {
        try {
            console.log('[SW] Processing API request received');

            // Try to proxy to backend first
            try {
                const backendUrl = new URL(request.url);
                // Use same origin but ensure it's the backend
                backendUrl.protocol = location.protocol;
                backendUrl.host = location.host;

                console.log('[SW] Proxying processing request to backend:', backendUrl.href);

                const response = await fetch(backendUrl.href, {
                    method: 'POST',
                    headers: request.headers,
                    body: request.body,
                    // Add timeout for processing requests
                    signal: AbortSignal.timeout(30000) // 30 second timeout
                });

                if (response.ok) {
                    // Cache successful processing results for offline use
                    const cache = await caches.open('processing-cache');
                    cache.put(request, response.clone());

                    console.log('[SW] Processing completed via backend, cached result');
                    return response;
                } else {
                    console.warn('[SW] Backend processing failed:', response.status);
                }
            } catch (backendError) {
                console.warn('[SW] Backend processing unavailable:', backendError);
            }

            // Backend unavailable - try cached responses for similar requests
            const cache = await caches.open('processing-cache');

            // Try to find a cached response with similar content
            const cacheKeys = await cache.keys();
            for (const cacheRequest of cacheKeys) {
                try {
                    // Check if the request body is similar (basic heuristic)
                    const cachedResponse = await safeCacheMatch(cache, cacheRequest);
                    if (cachedResponse) {
                        console.log('[SW] Serving cached processing result');
                        return cachedResponse;
                    }
                } catch (cacheError) {
                    console.warn('[SW] Cache lookup failed:', cacheError);
                }
            }

            // No cached response available - return offline response
            console.log('[SW] Processing unavailable offline');
            return new Response(JSON.stringify({
                success: false,
                error: 'Processing unavailable offline',
                message: 'AI processing requires internet connection',
                code: 'OFFLINE_UNAVAILABLE',
                offline: true,
                timestamp: new Date().toISOString()
            }), {
                status: 503,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Offline': 'true'
                }
            });

        } catch (error) {
            console.error('[SW] Processing API error:', error);
            const msg = error instanceof Error ? error.message : String(error);
            return new Response(JSON.stringify({
                success: false,
                error: 'Processing failed',
                message: msg,
                code: 'PROCESSING_ERROR',
                timestamp: new Date().toISOString()
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
);

// Analysis API (lighter processing for quick analysis)
registerRoute(
    ({ url, request }) => url?.pathname === '/api/analyze' && request?.method === 'POST',
    async ({ request }) => {
        try {
            console.log('[SW] Analysis API request received');

            // Try backend first
            try {
                const backendUrl = new URL(request.url);
                backendUrl.protocol = location.protocol;
                backendUrl.host = location.host;

                const response = await fetch(backendUrl.href, {
                    method: 'POST',
                    headers: request.headers,
                    body: request.body,
                    signal: AbortSignal.timeout(10000) // 10 second timeout for analysis
                });

                if (response.ok) {
                    console.log('[SW] Analysis completed via backend');
                    return response;
                }
            } catch (backendError) {
                console.warn('[SW] Backend analysis unavailable:', backendError);
            }

            // Fallback: Basic content type detection
            try {
                const requestData = await request.json();
                const content = requestData.content || '';
                const contentType = requestData.contentType || 'text';

                let analysis = '';

                if (contentType === 'text' || contentType === 'markdown') {
                    // Basic text analysis
                    const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;
                    const charCount = content.length;
                    const lineCount = content.split('\n').length;

                    analysis = `Text content: ${wordCount} words, ${charCount} characters, ${lineCount} lines`;

                    if (content.includes('# ')) {
                        analysis += ' (appears to be markdown with headings)';
                    }
                } else if (contentType === 'file') {
                    analysis = 'File content detected - full analysis requires backend';
                } else {
                    analysis = `${contentType} content detected - detailed analysis requires backend`;
                }

                console.log('[SW] Basic offline analysis provided');
                return new Response(JSON.stringify({
                    success: true,
                    analysis,
                    contentType,
                    basicAnalysis: true,
                    offline: true,
                    timestamp: new Date().toISOString()
                }), {
                    headers: { 'Content-Type': 'application/json' }
                });

            } catch (parseError) {
                console.warn('[SW] Failed to parse request for basic analysis:', parseError);
            }

            return new Response(JSON.stringify({
                success: false,
                error: 'Analysis unavailable offline',
                message: 'Content analysis requires internet connection',
                code: 'OFFLINE_UNAVAILABLE',
                offline: true,
                timestamp: new Date().toISOString()
            }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            console.error('[SW] Analysis API error:', error);
            const msg = error instanceof Error ? error.message : String(error);
            return new Response(JSON.stringify({
                success: false,
                error: 'Analysis failed',
                message: msg,
                code: 'ANALYSIS_ERROR',
                timestamp: new Date().toISOString()
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
);

// Serve /user/* from OPFS in service worker context (GET/POST/PUT/DELETE).
const isUserOpfsRoute = ({ url }: any): boolean => safeIsUserScopePath(url?.pathname || "");

const handleUserOpfsGet = async ({ url }: any): Promise<Response> => {
    const pathname = url?.pathname || "";
    try {
        if (pathname.endsWith("/") || pathname === "/user") {
            const entries = await listUserOpfsEntries(pathname);
            return jsonUserOpfsResponse({ ok: true, method: "GET", path: pathname, entries });
        }

        const file = await readUserOpfsFile(pathname);
        if (!file) return userOpfsNotFoundResponse(pathname, "GET");

        return new Response(file, {
            headers: {
                "Content-Type": file.type || "application/octet-stream",
                "Content-Length": String(file.size),
                "X-Source": "opfs-user",
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        });
    } catch (error: any) {
        if (isOpfsNotFoundError(error)) return userOpfsNotFoundResponse(pathname, "GET");
        return jsonUserOpfsResponse({
            ok: false,
            error: "OPFS_GET_FAILED",
            status: 500,
            method: "GET",
            path: pathname,
            message: String(error?.message || error)
        }, 500);
    }
};

const handleUserOpfsWrite = async ({ url, request }: any, method: "POST" | "PUT"): Promise<Response> => {
    const pathname = url?.pathname || "";
    try {
        const saved = await writeUserOpfsFile(pathname, request);
        return jsonUserOpfsResponse({
            ok: true,
            method,
            path: pathname,
            saved
        }, method === "POST" ? 201 : 200);
    } catch (error: any) {
        const status = /missing filename/i.test(String(error?.message || "")) ? 400 : 500;
        return jsonUserOpfsResponse({
            ok: false,
            error: status === 400 ? "OPFS_BAD_REQUEST" : "OPFS_WRITE_FAILED",
            status,
            method,
            path: pathname,
            message: String(error?.message || error)
        }, status);
    }
};

const handleUserOpfsDelete = async ({ url, request }: any): Promise<Response> => {
    const pathname = url?.pathname || "";
    try {
        const recursive = new URL(request.url).searchParams.get("recursive") !== "false";
        await deleteUserOpfsEntry(pathname, recursive);
        return jsonUserOpfsResponse({ ok: true, method: "DELETE", path: pathname, deleted: true });
    } catch (error: any) {
        if (isOpfsNotFoundError(error)) return userOpfsNotFoundResponse(pathname, "DELETE");
        const status = /refusing to delete \/user root/i.test(String(error?.message || "")) ? 400 : 500;
        return jsonUserOpfsResponse({
            ok: false,
            error: status === 400 ? "OPFS_BAD_REQUEST" : "OPFS_DELETE_FAILED",
            status,
            method: "DELETE",
            path: pathname,
            message: String(error?.message || error)
        }, status);
    }
};

registerRoute(isUserOpfsRoute, handleUserOpfsGet, "GET");
registerRoute(isUserOpfsRoute, (args: any) => handleUserOpfsWrite(args, "POST"), "POST");
registerRoute(isUserOpfsRoute, (args: any) => handleUserOpfsWrite(args, "PUT"), "PUT");
registerRoute(isUserOpfsRoute, (args: any) => handleUserOpfsWrite(args, "PUT"), "PATCH");
registerRoute(isUserOpfsRoute, handleUserOpfsDelete, "DELETE");

// Phosphor Icons Proxy (for PWA offline support)
const PHOSPHOR_ICON_STYLES = new Set(['thin', 'light', 'regular', 'bold', 'fill', 'duotone']);

const normalizeIconName = (value: string): string =>
    value.replace(/\.svg$/i, '').trim().toLowerCase();

const parsePhosphorAliasPath = (pathname: string): { style: string; icon: string } | null => {
    const p = pathname || '';
    if (!p.startsWith('/assets/icons/')) return null;

    const parts = p.split('/').filter(Boolean);
    // "/assets/icons/..."
    if (parts.length < 3) return null;

    // /assets/icons/phosphor/:style/:icon
    if (parts[2] === 'phosphor') {
        if (parts.length < 5) return null;
        const style = parts[3]?.toLowerCase?.();
        const icon = normalizeIconName(parts.slice(4).join('/'));
        if (!PHOSPHOR_ICON_STYLES.has(style) || !/^[a-z0-9-]+$/i.test(icon)) return null;
        return { style, icon };
    }

    // /assets/icons/duotone/:icon
    if (parts[2] === 'duotone') {
        if (parts.length < 4) return null;
        const icon = normalizeIconName(parts.slice(3).join('/'));
        if (!/^[a-z0-9-]+$/i.test(icon)) return null;
        return { style: 'duotone', icon };
    }

    // /assets/icons/:style/:icon
    if (parts.length >= 4) {
        const style = parts[2]?.toLowerCase?.();
        const icon = normalizeIconName(parts.slice(3).join('/'));
        if (!PHOSPHOR_ICON_STYLES.has(style) || !/^[a-z0-9-]+$/i.test(icon)) return null;
        return { style, icon };
    }

    // /assets/icons/:icon -> default to duotone
    const icon = normalizeIconName(parts[2] || '');
    if (!/^[a-z0-9-]+$/i.test(icon)) return null;
    return { style: 'duotone', icon };
};

const phosphorAssetFileName = (style: string, icon: string): string => {
    if (style === 'duotone') return `${icon}-duotone.svg`;
    if (style === 'regular') return `${icon}.svg`;
    return `${icon}-${style}.svg`;
};

registerRoute(
    ({ url }) => !!parsePhosphorAliasPath(url?.pathname || ''),
    async ({ url, request }) => {
        try {
            const parsed = parsePhosphorAliasPath(url.pathname);
            if (!parsed) {
                return fetch(request);
            }

            const iconStyle = parsed.style;
            const iconFile = phosphorAssetFileName(iconStyle, parsed.icon);

            // Build the actual CDN URL
            const cdnUrl = `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/${iconStyle}/${iconFile}`;

            console.log('[SW] Proxying Phosphor icon:', url.pathname, '->', cdnUrl, `(fixed: ${iconFile})`);

            // Fetch from CDN with appropriate caching
            const forwardedHeaders: Record<string, string> = {};
            request?.headers?.forEach?.((value, key) => {
                forwardedHeaders[key] = value;
            });
            const response = await fetch(cdnUrl, {
                ...request,
                headers: {
                    ...forwardedHeaders,
                    'Accept': 'image/svg+xml, image/*',
                }
            });

            if (response.ok) {
                // Cache the response for offline use
                const cache = await caches.open('phosphor-icons-cache');
                await cache.put(request, response.clone());

                return response;
            } else {
                console.warn('[SW] Failed to fetch Phosphor icon:', cdnUrl, response.status);
                // Try to serve from cache if available
                const cache = await caches.open('phosphor-icons-cache');
                const cachedResponse = await safeCacheMatch(cache, request);
                if (cachedResponse) {
                    console.log('[SW] Serving cached Phosphor icon:', url.pathname);
                    return cachedResponse;
                }
                return response;
            }
        } catch (error) {
            console.error('[SW] Error proxying Phosphor icon:', error);
            // Try to serve from cache if available
            try {
                const cache = await caches.open('phosphor-icons-cache');
                const cachedResponse = await safeCacheMatch(cache, request);
                if (cachedResponse) {
                    console.log('[SW] Serving cached Phosphor icon (fallback):', url.pathname);
                    return cachedResponse;
                }
            } catch (cacheError) {
                console.error('[SW] Cache fallback failed:', cacheError);
            }
            return new Response('Icon not available', { status: 503 });
        }
    }
);

const OFFLINE_DOC_CANDIDATES = ["/", "/index.html", "/viewer", "/workcenter", "/explorer", "/settings"];
const OFFLINE_WARMUP_PATHS = ["/", "/viewer", "/workcenter", "/explorer", "/settings"];

const createOfflineDocumentResponse = (pathname = "/"): Response => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Offline</title>
  <style>
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: #0f1115; color: #d8deea; display: grid; min-height: 100vh; place-items: center; }
    .box { max-width: 640px; padding: 20px; border: 1px solid #2a3040; border-radius: 10px; background: #141925; }
    code { color: #b7d4ff; }
  </style>
</head>
<body>
  <div class="box">
    <h3>Offline fallback</h3>
    <p>Service worker is active, but this route is not available in cache.</p>
    <p>Path: <code>${pathname}</code></p>
    <p>Reconnect once to warm cache for this view.</p>
  </div>
</body>
</html>`;
    return new Response(html, {
        status: 200,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Source": "sw-offline-fallback"
        }
    });
};

const resolveOfflineNavigationResponse = async (pathname = "/"): Promise<Response> => {
    for (const candidate of OFFLINE_DOC_CANDIDATES) {
        const hit = await safeCachesMatch(candidate);
        if (hit) return hit;
    }
    return createOfflineDocumentResponse(pathname);
};

const warmupOfflineNavigationCache = async (reason: "install" | "activate"): Promise<void> => {
    try {
        const cache = await caches.open("default-cache");
        const origin = self.location.origin;
        await Promise.all(
            OFFLINE_WARMUP_PATHS.map(async (path) => {
                try {
                    const request = new Request(new URL(path, origin).toString(), {
                        method: "GET",
                        credentials: "same-origin",
                        cache: "no-store",
                    });
                    const response = await fetch(request);
                    if (!response?.ok) {
                        console.warn(`[SW] Warmup skipped (non-ok): ${path} status=${response?.status}`);
                        return;
                    }
                    await cache.put(request, response.clone());
                } catch (entryError) {
                    console.warn(`[SW] Warmup failed for ${path}:`, entryError);
                }
            })
        );
        console.log(`[SW] Offline navigation warmup completed (${reason})`);
    } catch (error) {
        console.warn(`[SW] Offline navigation warmup failed (${reason}):`, error);
    }
};

// fallback to app-shell for document requests
setCatchHandler(({ event }: any): Promise<Response> => {
    if (event?.request?.destination === 'document') {
        const pathname = (() => {
            try { return new URL(event?.request?.url || "").pathname || "/"; } catch { return "/"; }
        })();
        if (safeIsUserScopePath(pathname)) {
            const url = (() => {
                try { return new URL(event?.request?.url || ""); } catch { return new URL(self.location.origin); }
            })();
            return handleUserOpfsGet({ url, request: event?.request, event })
                .catch(() => userOpfsNotFoundResponse(pathname, "GET"));
        }
        return resolveOfflineNavigationResponse(pathname);
    }
    return Promise.resolve(Response.error());
});

// Notifications
self.addEventListener?.('notificationclick', (event: any) => {
    event?.notification?.close?.();
    event?.waitUntil?.(
        (self as any).clients?.matchAll?.({ type: 'window', includeUncontrolled: true })?.then?.((clientList: any) => {
            // If a window is already open, focus it
            for (const client of clientList) {
                if (client.url && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open a new window
            if ((self as any).clients?.openWindow) {
                return (self as any).clients?.openWindow?.('/');
            }
        })
    );
});

// @ts-ignore // lifecycle - enable navigation preload for faster loads
// ============================================================================
// SERVICE WORKER UPDATE MANAGEMENT
// ============================================================================

// Handle service worker lifecycle events
self.addEventListener?.('install', (e: any) => {
    console.log('[SW] Installing new service worker...');
    // Only skipWaiting must block install; offline HTML warmup does network fetches and was
    // serializing 5+ document requests here — that delayed activation and first paint for minutes
    // on slow links while Workbox precache also ran in parallel.
    const sw = (self as any)?.skipWaiting?.();
    e?.waitUntil?.(sw && typeof sw.then === "function" ? sw : Promise.resolve());
    void warmupOfflineNavigationCache("install");
});

self.addEventListener?.('activate', (e: any) => {
    console.log('[SW] Activating service worker...');
    e?.waitUntil?.(
        Promise.all([
            (self as any).clients?.claim?.(),
            (self as any).registration?.navigationPreload?.enable?.() ?? Promise.resolve(),
        ])
            .then(() => notifyClients("sw-activated"))
            .catch(() => notifyClients("sw-activated"))
    );
    void warmupOfflineNavigationCache("activate");
});

// Handle messages from clients
self.addEventListener?.('message', (e: any) => {
    const { type } = e.data || {};

    switch (type) {
        case 'SKIP_WAITING':
            console.log('[SW] Received skip waiting command');
            (self as any).skipWaiting?.();
            break;

        case 'CHECK_FOR_UPDATES':
            console.log('[SW] Checking for updates...');
            e.waitUntil?.(checkForUpdates());
            break;

        case 'GET_CACHE_STATUS':
            e.waitUntil?.(sendCacheStatus(e.source));
            break;

        default:
            console.log('[SW] Unknown message type:', type);
    }
});

// Notify all clients about events
async function notifyClients(type: string, data?: any): Promise<void> {
    const clients = await (self as any).clients?.matchAll?.() || [];
    clients.forEach((client: any) => {
        client.postMessage({ type, data });
    });
}

// Check for service worker updates
async function checkForUpdates(): Promise<void> {
    try {
        const registration = (self as any).registration;
        if (registration) {
            await registration.update();
            console.log('[SW] Update check completed');
        }
    } catch (error) {
        console.error('[SW] Update check failed:', error);
    }
}

// Send cache status to a specific client
async function sendCacheStatus(client: any): Promise<void> {
    try {
        const cacheNames = await caches.keys();
        const cacheStatus: any = {};

        for (const cacheName of cacheNames) {
            const cache = await caches.open(cacheName);
            const keys = await cache.keys();
            cacheStatus[cacheName] = {
                name: cacheName,
                size: keys.length,
                urls: keys.map(request => request.url)
            };
        }

        client.postMessage({
            type: 'cache-status',
            data: cacheStatus
        });
    } catch (error) {
        console.error('[SW] Failed to get cache status:', error);
    }
}

// Share target GET handler (for testing/debugging)
registerRoute(
    ({ url, request }) => isShareTargetUrl(url?.pathname) && request?.method === 'GET',
    async ({ event }) => {
        const navEvent = event as any;
        // Navigation preload can be started by the browser for this navigation.
        // Ensure it settles to avoid cancellation warnings in console.
        const preloadPromise = navEvent?.preloadResponse
            ? Promise.resolve(navEvent.preloadResponse).catch(() => undefined)
            : null;
        if (preloadPromise) {
            navEvent.waitUntil(preloadPromise.then(() => undefined));
            await preloadPromise;
        }

        console.log('[ShareTarget] GET request received - redirecting to app');
        return new Response(null, {
            status: 302,
            // Keep real share flow marker instead of test marker.
            headers: { Location: '/workcenter?shared=1' }
        });
    },
    'GET'
);

// Fallback: Manual fetch event handler for share target (in case workbox routing fails)
self.addEventListener?.('fetch', (event: any) => {
    const request = event?.request ?? event?.event?.request ?? event;
    if (!request?.url) return;
    const requestUrl = new URL(request.url);

    // Hard fallback for /user/* so requests never escape to backend
    // when Workbox routing order/matching is affected.
    if (safeIsUserScopePath(requestUrl.pathname)) {
        const method = String(request.method || "GET").toUpperCase();
        if (method === "GET") {
            event?.respondWith?.(handleUserOpfsGet({ url: requestUrl, request, event }));
            return;
        }
        if (method === "POST") {
            event?.respondWith?.(handleUserOpfsWrite({ url: requestUrl, request, event }, "POST"));
            return;
        }
        if (method === "PUT" || method === "PATCH") {
            event?.respondWith?.(handleUserOpfsWrite({ url: requestUrl, request, event }, "PUT"));
            return;
        }
        if (method === "DELETE") {
            event?.respondWith?.(handleUserOpfsDelete({ url: requestUrl, request, event }));
            return;
        }
        if (method === "OPTIONS") {
            event?.respondWith?.(new Response(null, {
                status: 204,
                headers: {
                    "Cache-Control": "no-store",
                    "Pragma": "no-cache",
                    "Expires": "0",
                    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-File-Name, X-Filename",
                    "X-Source": "opfs-user"
                }
            }));
            return;
        }
        event?.respondWith?.(jsonUserOpfsResponse({
            ok: false,
            error: "OPFS_METHOD_NOT_ALLOWED",
            status: 405,
            method,
            path: requestUrl.pathname
        }, 405));
        return;
    }

    if (isShareTargetUrl(requestUrl.pathname) && request?.method === 'POST') {
        console.log('[ShareTarget] Manual fetch handler triggered');
        event?.respondWith?.(handleShareTargetRequest(request));
    }
});

// Share target request handler function
async function handleShareTargetRequest(event: any): Promise<Response> {
    const request = event?.request ?? event?.event?.request ?? event;
    const headers = request?.headers ?? event?.event?.request?.headers ?? event?.headers ?? {};
    const contentType = headers?.get?.('content-type') ?? '';

    console.log('[ShareTarget] Manual handler called for:', request.url);
    console.log('[ShareTarget] Service worker controlling clients:', !!(self as any).clients);

    try {
        // Clone request before reading - body can only be consumed once
        const fd = await request?.formData?.().catch?.((error: any) => {
            console.error('[ShareTarget] Failed to parse FormData:', error);
            return null;
        });

        if (!fd) {
            console.warn('[ShareTarget] No FormData received');
            return new Response(null, { status: 302, headers: { Location: '/' } });
        }

        console.log('[ShareTarget] FormData received, content-type:', contentType);
        console.log('[ShareTarget] FormData keys:', Array.from(fd?.keys?.() || []));

        // Extract share data
        const shareData = {
            title: fd?.get?.('title') || '',
            text: fd?.get?.('text') || '',
            url: fd?.get?.('url') || '',
            files: fd?.getAll?.('files') || [],
            timestamp: Date.now()
        };

        console.log('[ShareTarget] Processed data:', {
            title: shareData?.title,
            text: shareData?.text?.substring(0, 50),
            url: shareData?.url,
            filesCount: shareData?.files?.length || 0
        });

        // Determine content type for association system
        let primaryContentType = 'text';
        if (shareData.files?.length > 0) {
            primaryContentType = 'files';
        } else if (shareData.url) {
            primaryContentType = 'url';
        }

        // Process through content association system
        return await processContentWithAssociation(primaryContentType, 'share-target', shareData, event);

    } catch (err) {
        console.warn('[ShareTarget] Manual handler error:', err);
        return new Response(null, { status: 302, headers: { Location: '/' } });
    }
}

// Handle requests for pending clipboard operations
registerRoute(
    ({ url }) => {
        const matches = url?.pathname === '/clipboard/pending';
        if (matches) {
            console.log('[SW] Clipboard route matched for:', url?.pathname);
        }
        return matches;
    },
    async ({ url }) => {
        try {
            console.log('[SW] Handling request for pending clipboard operations:', url?.pathname);
            const operations = await getStoredClipboardOperations();
            console.log('[SW] Returning', operations.length, 'clipboard operations');
            return new Response(JSON.stringify({ operations }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('[SW] Error in clipboard pending route:', error);
            return new Response(JSON.stringify({ error: 'Internal server error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    },
    'GET'
);

// Handle requests for available cached content keys (specific route first)
registerRoute(
    ({ url }) => url?.pathname === '/sw-content/available',
    async () => {
        console.log('[SW] Received request for available cached content');
        const cacheKeys = await getStoredCacheKeys();
        return new Response(JSON.stringify({ cacheKeys }), {
            headers: { 'Content-Type': 'application/json' }
        });
    },
    'GET'
);

// Handle requests for cached content from SW association system (general route after specific ones)
registerRoute(
    ({ url }) => url?.pathname?.startsWith('/sw-content/'),
    async ({ url }) => {
        const cacheKey = url.pathname.replace('/sw-content/', '');
        console.log('[SW] Received request for cached content:', cacheKey);

        if (!cacheKey) {
            return new Response(JSON.stringify({ error: 'Missing cache key' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            const cache = await (self as any).caches?.open?.(SW_CONTENT_CACHE_NAME);
            if (cache) {
                const cacheRequest = toSWContentCacheRequest(cacheKey);
                const response = await safeCacheMatch(cache, cacheRequest);
                if (response) {
                    // Delete from cache after retrieval (one-time use)
                    await cache.delete(cacheRequest);
                    return response;
                }
            }
        } catch (error) {
            console.warn('[SW] Failed to retrieve cached content:', error);
        }

        return new Response(JSON.stringify({ error: 'Content not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
        });
    },
    'GET'
);

// Handle requests for share target file manifest
registerRoute(
    ({ url }) => url?.pathname === '/share-target-files',
    async ({ url }) => {
        const cacheKey = url.searchParams.get('cacheKey') || 'latest';
        console.log('[SW] Received request for share target files, cacheKey:', cacheKey);

        try {
            const cache = await (self as any).caches?.open?.(SHARE_CACHE_NAME);
            if (cache) {
                const manifestResponse = await safeCacheMatch(cache, SHARE_FILES_MANIFEST_KEY);
                if (manifestResponse) {
                    const manifest = await manifestResponse.json();
                    return new Response(JSON.stringify(manifest), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
        } catch (error) {
            console.warn('[SW] Failed to retrieve share target file manifest:', error);
        }

        return new Response(JSON.stringify({ files: [] }), {
            headers: { 'Content-Type': 'application/json' }
        });
    },
    'GET'
);

// Handle requests for individual share target files
registerRoute(
    ({ url }) => url?.pathname?.startsWith(SHARE_FILE_PREFIX),
    async ({ url }) => {
        const fileKey = url.pathname.replace(SHARE_FILE_PREFIX, '');
        console.log('[SW] Received request for share target file:', fileKey);

        if (!fileKey) {
            return new Response(JSON.stringify({ error: 'Missing file key' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            const cache = await (self as any).caches?.open?.(SHARE_CACHE_NAME);
            if (cache) {
                const response = await safeCacheMatch(cache, SHARE_FILE_PREFIX + fileKey);
                if (response) {
                    // Return the file but don't delete from cache (work center may need it multiple times)
                    return response;
                }
            }
        } catch (error) {
            console.warn('[SW] Failed to retrieve share target file:', error);
        }

        return new Response(JSON.stringify({ error: 'File not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
        });
    },
    'GET'
);

// ============================================================================
// LAUNCH QUEUE SUPPORT
// ============================================================================

// Handle launch queue events (when app is launched with files)
self.addEventListener?.('launchqueue', async (event: any) => {
    console.log('[LaunchQueue] Launch queue event received');

    try {
        const launchQueue = event?.launchQueue;
        if (!launchQueue) {
            console.warn('[LaunchQueue] No launch queue available');
            return;
        }

        console.log('[LaunchQueue] Launch queue payload summary:', summarizeForLog({
            fileCount: launchQueue?.files?.length,
            hasFilesIterator: typeof launchQueue?.files?.[Symbol.asyncIterator] === 'function'
        }));

        const files: File[] = [];
        for await (const fileHandle of launchQueue.files) {
            try {
                console.log('[LaunchQueue] Processing file:', fileHandle.name);

                // Get file from handle
                const file = await fileHandle.getFile();
                console.log('[LaunchQueue] File loaded from handle:', summarizeForLog({
                    name: file?.name,
                    type: file?.type,
                    size: file?.size
                }));
                files.push(file);

            } catch (error) {
                console.error('[LaunchQueue] Failed to process file:', error);
            }
        }

        if (files.length <= 0) return;

        const categorized = categorizeFiles(files);
        const shareData: ShareData = {
            title: '',
            text: '',
            url: '',
            files,
            imageFiles: categorized.imageFiles,
            textFiles: categorized.textFiles,
            otherFiles: categorized.otherFiles,
            timestamp: Date.now()
        };

        await cacheShareData(shareData);
        notifyShareReceived?.({
            timestamp: shareData.timestamp,
            fileCount: shareData.files.length,
            imageCount: shareData.imageFiles.length,
            source: 'launch-queue',
            route: 'launch-queue'
        });
        sendToast(`Received ${shareData.files.length} launched file(s)`, 'info');

        const targetUrl = '/share-target?shared=1';
        const clientsList = await (self as any).clients?.matchAll?.({ type: 'window', includeUncontrolled: true }) || [];
        if (clientsList.length > 0) {
            await clientsList[0].focus?.();
        } else {
            await (self as any).clients?.openWindow?.(targetUrl);
        }

    } catch (error) {
        console.error('[LaunchQueue] Failed to handle launch queue:', error);
    }
});

// ============================================================================
// PUSH MESSAGE SUPPORT
// ============================================================================

// Handle push messages with association system
self.addEventListener?.('push', async (event: any) => {
    console.log('[Push] Push message received');

    try {
        const data = event?.data?.json?.() || {};

        // Process push data through association system
        await processContentWithAssociation('text', 'push-message', {
            text: data.message || data.body || '',
            title: data.title || '',
            timestamp: Date.now(),
            source: 'push'
        }, event);

    } catch (error) {
        console.error('[Push] Failed to handle push message:', error);
    }
});

// ============================================================================
// BACKGROUND SYNC SUPPORT
// ============================================================================

// Handle background sync with association system
self.addEventListener?.('sync', async (event: any) => {
    console.log('[BackgroundSync] Background sync event:', event.tag);

    if (event.tag === 'content-processing') {
        try {
            // Get any cached content that needs processing
            const cacheKeys = await getStoredCacheKeys();
            const processingKeys = cacheKeys.filter(k => k.context === 'background-sync');

            for (const cacheKey of processingKeys) {
                try {
                    const cache = await (self as any).caches?.open?.(SW_CONTENT_CACHE_NAME);
                    if (cache) {
                        const cacheRequest = toSWContentCacheRequest(cacheKey.key);
                        const response = await safeCacheMatch(cache, cacheRequest);
                        if (response) {
                            const content = await response.json();

                            // Process through association system
                            await processContentWithAssociation('any', 'background-sync', content, event);

                            // Remove from cache after processing
                            await cache.delete(cacheRequest);
                        }
                    }
                } catch (error) {
                    console.error('[BackgroundSync] Failed to process cached content:', error);
                }
            }

            // Update cache keys (remove processed ones)
            const remainingKeys = cacheKeys.filter(k => k.context !== 'background-sync');
            await storeCacheKeys(remainingKeys);

        } catch (error) {
            console.error('[BackgroundSync] Failed to handle background sync:', error);
        }
    }
});

// Clear clipboard operations queue
registerRoute(
    ({ url }) => url?.pathname === '/clipboard/clear',
    async () => {
        console.log('[SW] Clearing clipboard operations queue');
        await clearStoredClipboardOperations();
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    },
    'POST'
);

// Remove specific clipboard operation
registerRoute(
    ({ url }) => url?.pathname.startsWith('/clipboard/remove/'),
    async ({ url }) => {
        const operationId = url?.pathname.split('/clipboard/remove/')[1];
        if (!operationId) {
            return new Response(JSON.stringify({ error: 'Missing operation ID' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log('[SW] Removing clipboard operation:', operationId);
        await removeClipboardOperation(operationId);
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    },
    'DELETE'
);

// Enhanced asset caching for critical resources
registerRoute(
    ({ url }) => {
        const pathname = url?.pathname;
        return pathname && !safeIsUserScopePath(pathname) && (
            pathname.endsWith('.js') ||
            pathname.endsWith('.css') ||
            pathname.endsWith('.svg') ||
            pathname.endsWith('.png') ||
            pathname === '/sw.js'
        );
    },
    handleAssetRequest
);

// Use preload response for navigation when available
registerRoute(
    ({ url, request }) => request.mode === 'navigate' && !safeIsUserScopePath(url?.pathname || ""),
    async ({ event, request }: any) => {
        try {
            const preloadPromise = event?.preloadResponse
                ? Promise.resolve(event.preloadResponse).catch(() => undefined)
                : null;

            // Keep SW alive until preload settles to avoid cancellation warnings.
            if (preloadPromise) {
                event.waitUntil(preloadPromise.then(() => undefined));
                const preloadResponse = await preloadPromise;
                if (preloadResponse) {
                    return preloadResponse;
                }
            }

            // Otherwise fall back to network
            const networkResponse = await fetch(request);
            return networkResponse;
        } catch (error) {
            console.warn('[SW] Navigation fetch failed:', error);
            const pathname = (() => {
                try { return new URL(request?.url || "").pathname || "/"; } catch { return "/"; }
            })();
            if (safeIsUserScopePath(pathname)) {
                const url = (() => {
                    try { return new URL(request?.url || ""); } catch { return new URL(self.location.origin); }
                })();
                return await handleUserOpfsGet({ url, request, event })
                    .catch(() => userOpfsNotFoundResponse(pathname, "GET"));
            }
            return await resolveOfflineNavigationResponse(pathname);
        }
    }
);
