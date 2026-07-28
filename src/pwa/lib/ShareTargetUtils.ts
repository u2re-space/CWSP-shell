/**
 * Share Target Utilities
 * Reusable functions for processing share target data with GPT integration
 */

import { getRuntimeSettings } from 'com/config/RuntimeSettings';
import { loadSettings } from 'com/config/Settings';
import type { AppSettings, CustomInstruction } from 'com/config/SettingsTypes';
import { DEFAULT_SETTINGS } from 'com/config/SettingsTypes';
import { executionCore } from 'com/service/misc/ExecutionCore';
import type { ActionContext, ActionInput } from 'com/service/misc/ActionHistory';
import { normalizeDataAsset, parseDataUrl, isBase64Like } from 'fest/lure';

// ============================================================================
// TYPES
// ============================================================================

export interface ShareData {
    title: string;
    text: string;
    url: string;
    files: File[];
    imageFiles: File[];
    textFiles: File[];
    otherFiles: File[];
    timestamp: number;
}

export interface AIProcessingConfig {
    enabled: boolean;
    mode: 'recognize' | 'analyze';
    customInstruction: string;
    apiKey: string | null;
}

export interface ParsedFormData {
    formData: FormData | null;
    error?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Known field names for file uploads */
const FILE_FIELD_NAMES = ['files', 'mapped_files', 'file', 'image', 'images', 'media'] as const;

/** MIME types considered as text/code */
const TEXT_MIME_TYPES = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript'
] as const;

/** MIME types that can be processed by AI but aren't images or text */
const PROCESSABLE_MIME_TYPES = ['application/pdf'] as const;

// ============================================================================
// FORM DATA PARSING
// ============================================================================

/**
 * Parse FormData from a request with JSON fallback
 */
export const parseFormDataFromRequest = async (request: Request): Promise<ParsedFormData> => {
    // Try FormData first
    try {
        const formData = await request.formData();
        return { formData };
    } catch (formError: any) {
        console.warn('[ShareTarget] FormData parsing failed:', formError?.message);
    }

    // Fallback to JSON
    try {
        const clonedRequest = request.clone();
        const text = await clonedRequest.text();

        if (text?.trim()) {
            const jsonData = safeParseJSON<Record<string, unknown>>(text);
            if (jsonData) {
                const formData = new FormData();
                if (jsonData.title) formData.append('title', String(jsonData.title));
                if (jsonData.text) formData.append('text', String(jsonData.text));
                if (jsonData.url) formData.append('url', String(jsonData.url));
                return { formData };
            }
        }
    } catch (jsonError: any) {
        console.warn('[ShareTarget] JSON fallback failed:', jsonError?.message);
    }

    return { formData: null, error: 'Failed to parse request data' };
};

/**
 * Safe JSON parse with type guard
 */
export const safeParseJSON = <T = unknown>(text: string): T | null => {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
};

// ============================================================================
// FILE COLLECTION
// ============================================================================

/**
 * Generate a unique key for file deduplication
 */
const getFileKey = (file: File): string => `${file.name}-${file.size}-${file.type}`;

/**
 * Check if value is a non-empty File
 */
const isValidFile = (value: unknown): value is File =>
    value instanceof File && value.size > 0;

/**
 * Check if string is a valid base64 data URL
 */
const isBase64DataUrl = (value: string): boolean =>
    !!parseDataUrl(value)?.isBase64;

/**
 * Check if string is a URI component that could be decoded
 */
const isUriComponent = (value: string): boolean => {
    try {
        decodeURIComponent(value);
        return value !== decodeURIComponent(value); // Only if it actually decodes to something different
    } catch {
        return false;
    }
};

const canParseUrl = (value: string): boolean => {
    try {
        if (typeof URL === 'undefined') return false;
        if (typeof (URL as any).canParse === 'function') return (URL as any).canParse(value);
        new URL(value);
        return true;
    } catch {
        return false;
    }
};

const shouldConvertStringToFile = (value: string): boolean => {
    if (isBase64DataUrl(value) || isBase64Like(value) || canParseUrl(value)) return true;
    if (!isUriComponent(value)) return false;
    const decoded = decodeURIComponent(value);
    return isBase64DataUrl(decoded) || isBase64Like(decoded) || canParseUrl(decoded);
};

const convertStringToFile = async (value: string, fieldName: string): Promise<File | null> => {
    try {
        if (!shouldConvertStringToFile(value)) return null;
        const asset = await normalizeDataAsset(value, {
            namePrefix: `${fieldName || 'shared'}-asset`,
            uriComponent: true
        });
        return asset.file;
    } catch (error) {
        console.warn('[ShareTarget] Failed to convert string data to file:', error);
        return null;
    }
};

/**
 * Collect and deduplicate files from FormData (including base64 and URI component support)
 */
export const collectFilesFromFormData = async (formData: FormData): Promise<File[]> => {
    const seenFiles = new Set<string>();
    const files: File[] = [];

    const addFile = (file: File): void => {
        const key = getFileKey(file);
        if (!seenFiles.has(key)) {
            seenFiles.add(key);
            files.push(file);
        }
    };

    // Check known field names for files
    for (const fieldName of FILE_FIELD_NAMES) {
        for (const value of formData.getAll(fieldName)) {
            if (isValidFile(value)) {
                addFile(value);
            } else if (typeof value === 'string') {
                const convertedFile = await convertStringToFile(value, fieldName);

                if (convertedFile) {
                    console.log('[ShareTarget] Converted string data to file:', fieldName, convertedFile.name);
                    addFile(convertedFile);
                }
            }
        }
    }

    // Check all entries for files and convertible strings in unknown fields
    const entries = Array.from((formData as any).entries?.() || []) as [string, FormDataEntryValue][];
    for (const [fieldName, value] of entries) {
        if (isValidFile(value)) {
            addFile(value);
        } else if (typeof value === 'string') {
            const convertedFile = await convertStringToFile(value, fieldName);

            if (convertedFile) {
                console.log('[ShareTarget] Converted string data to file from field:', fieldName, convertedFile.name);
                addFile(convertedFile);
            }
        }
    }

    return files;
};

// ============================================================================
// FILE CATEGORIZATION
// ============================================================================

/**
 * Check if MIME type is a text/code type
 */
const isTextMimeType = (mimeType: string): boolean =>
    TEXT_MIME_TYPES.some(prefix => mimeType.startsWith(prefix));

/**
 * Check if MIME type is processable by AI (non-image, non-text)
 */
export const isProcessableMimeType = (mimeType: string): boolean =>
    PROCESSABLE_MIME_TYPES.some(type => mimeType === type);

/**
 * Categorize files by MIME type
 */
export const categorizeFiles = (files: File[]): {
    imageFiles: File[];
    textFiles: File[];
    otherFiles: File[];
} => {
    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of files) {
        const mimeType = file.type?.toLowerCase() || '';

        if (mimeType.startsWith('image/')) {
            imageFiles.push(file);
        } else if (isTextMimeType(mimeType)) {
            textFiles.push(file);
        } else {
            otherFiles.push(file);
        }
    }

    return { imageFiles, textFiles, otherFiles };
};

// ============================================================================
// TEXT EXTRACTION
// ============================================================================

/**
 * Extract text content from a file
 */
export const extractTextFromFile = async (file: File): Promise<string | null> => {
    try {
        const text = await file.text();
        return text?.trim() || null;
    } catch (error: any) {
        console.warn('[ShareTarget] Failed to read text file:', file.name, error?.message);
        return null;
    }
};

/**
 * Extract text content from FormData and text files
 */
export const extractTextContent = async (
    formData: FormData,
    textFiles: File[]
): Promise<{ title: string; text: string; url: string }> => {
    const title = String(formData.get('title') || '').trim();
    let text = String(formData.get('text') || '').trim();
    const url = String(formData.get('url') || '').trim();

    // Try to extract text from files if not provided
    if (!text && textFiles.length > 0) {
        for (const file of textFiles) {
            const fileText = await extractTextFromFile(file);
            if (fileText) {
                text = fileText;
                console.log('[ShareTarget] Extracted text from file:', file.name);
                break;
            }
        }
    }

    return { title, text, url };
};

// ============================================================================
// SHARE DATA BUILDING
// ============================================================================

/**
 * Build complete share data object
 */
export const buildShareData = async (formData: FormData): Promise<ShareData> => {
    const files = await collectFilesFromFormData(formData);
    const { imageFiles, textFiles, otherFiles } = categorizeFiles(files);
    const { title, text, url } = await extractTextContent(formData, textFiles);

    return {
        title,
        text,
        url,
        files,
        imageFiles,
        textFiles,
        otherFiles,
        timestamp: Date.now()
    };
};

// ============================================================================
// CACHE OPERATIONS
// ============================================================================

export const SHARE_CACHE_NAME = 'share-target-data';
const SHARE_CACHE_KEY = '/share-target-data';
export const SHARE_FILES_MANIFEST_KEY = '/share-target-files';
export const SHARE_FILE_PREFIX = '/share-target-file/';

type CachedShareFileMeta = {
    key: string;
    name: string;
    type: string;
    size: number;
    lastModified?: number;
};

/**
 * Cache share data metadata for client retrieval
 */
export const cacheShareData = async (shareData: ShareData): Promise<boolean> => {
    try {
        const cache = await caches.open(SHARE_CACHE_NAME);
        const metadata = {
            title: shareData.title,
            text: shareData.text,
            url: shareData.url,
            timestamp: shareData.timestamp,
            fileCount: shareData.files.length,
            imageCount: shareData.imageFiles.length
        };

        await cache.put(
            SHARE_CACHE_KEY,
            new Response(JSON.stringify(metadata), {
                headers: { 'Content-Type': 'application/json' }
            })
        );

        // Also cache actual files (so the UI can attach them to WorkCenter / open markdown)
        // We store each file as a Response in Cache Storage + a manifest describing them.
        const fileManifest: CachedShareFileMeta[] = [];
        if (shareData.files?.length) {
            for (let i = 0; i < shareData.files.length; i++) {
                const file = shareData.files[i];
                const safeTs = Number.isFinite(shareData.timestamp) ? shareData.timestamp : Date.now();
                const key = `${SHARE_FILE_PREFIX}${safeTs}-${i}`;

                // Cache the raw bytes with metadata headers.
                const headers = new Headers();
                headers.set('Content-Type', file.type || 'application/octet-stream');
                headers.set('X-File-Name', encodeURIComponent(file.name || `file-${i}`));
                headers.set('X-File-Size', String(file.size || 0));
                headers.set('X-File-LastModified', String((file as any).lastModified ?? 0));

                await cache.put(
                    key,
                    new Response(file, { headers })
                );

                fileManifest.push({
                    key,
                    name: file.name || `file-${i}`,
                    type: file.type || 'application/octet-stream',
                    size: file.size || 0,
                    lastModified: (file as any).lastModified ?? undefined
                });
            }
        }

        await cache.put(
            SHARE_FILES_MANIFEST_KEY,
            new Response(JSON.stringify({ files: fileManifest, timestamp: shareData.timestamp }), {
                headers: { 'Content-Type': 'application/json' }
            })
        );

        return true;
    } catch (error: any) {
        console.warn('[ShareTarget] Cache storage failed:', error?.message);
        return false;
    }
};

// ============================================================================
// AI CONFIGURATION
// ============================================================================

/**
 * Get AI processing configuration from settings
 */
export const getAIProcessingConfig = async (): Promise<AIProcessingConfig> => {
    try {
        const settings = ((await getRuntimeSettings().catch(() => null)) as AppSettings | null) || (await loadSettings().catch(() => DEFAULT_SETTINGS)) || DEFAULT_SETTINGS;

        if (!settings?.ai?.apiKey) {
            return {
                enabled: false,
                mode: 'recognize',
                customInstruction: '',
                apiKey: null
            };
        }

        // Allow user to disable auto-processing for share target / file open flows.
        const autoEnabled = (settings?.ai?.autoProcessShared ?? true) !== false;

        // Get active custom instruction
        let customInstruction = '';
        const instructions: CustomInstruction[] = settings.ai.customInstructions || [];
        const activeId = settings.ai.activeInstructionId;

        if (activeId) {
            const active = instructions.find(i => i.id === activeId);
            customInstruction = active?.instruction?.trim() || '';
        }

        return {
            enabled: autoEnabled,
            mode: (settings.ai.shareTargetMode as 'recognize' | 'analyze') || 'recognize',
            customInstruction,
            apiKey: settings.ai.apiKey
        };
    } catch (error: any) {
        console.warn('[ShareTarget] Failed to load AI config:', error?.message);
        return {
            enabled: false,
            mode: 'recognize',
            customInstruction: '',
            apiKey: null
        };
    }
};

// ============================================================================
// AI FORM DATA BUILDING
// ============================================================================

/**
 * Build FormData for AI processing
 */
export const buildAIFormData = (
    shareData: ShareData,
    customInstruction: string
): FormData => {
    const formData = new FormData();

    // Add text fields
    formData.append('title', shareData.title);
    formData.append('text', shareData.text);
    formData.append('url', shareData.url);

    if (customInstruction) {
        formData.append('customInstruction', customInstruction);
    }

    // Add image files for GPT vision processing
    for (const file of shareData.imageFiles) {
        console.log('[ShareTarget] Adding image for AI:', formatFileInfo(file));
        formData.append('files', file);
    }

    // Add processable non-text files (PDFs, etc.)
    for (const file of shareData.otherFiles) {
        if (isProcessableMimeType(file.type)) {
            console.log('[ShareTarget] Adding processable file:', file.name);
            formData.append('files', file);
        }
    }

    // Add text files only if text wasn't already extracted
    if (!shareData.text) {
        for (const file of shareData.textFiles) {
            formData.append('files', file);
        }
    }

    return formData;
};

/**
 * Create synthetic event for commit routes
 */
export const createSyntheticEvent = (formData: FormData): { request: { formData: () => Promise<FormData> } } => ({
    request: {
        formData: () => Promise.resolve(formData)
    }
});

// ============================================================================
// LOGGING HELPERS
// ============================================================================

/**
 * Format file info for logging
 */
export const formatFileInfo = (file: File): { name: string; type: string; size: number } => ({
    name: file.name,
    type: file.type,
    size: file.size
});

/**
 * Log share data summary
 */
export const logShareDataSummary = (shareData: ShareData): void => {
    console.log('[ShareTarget] Processed share data:', {
        title: shareData.title || '(none)',
        text: shareData.text
            ? shareData.text.substring(0, 100) + (shareData.text.length > 100 ? '...' : '')
            : '(none)',
        url: shareData.url || '(none)',
        totalFiles: shareData.files.length,
        imageCount: shareData.imageFiles.length,
        textCount: shareData.textFiles.length,
        otherCount: shareData.otherFiles.length
    });
};

/**
 * Check if share data has processable content
 */
export const hasProcessableContent = (shareData: ShareData): boolean =>
    !!(shareData.text || shareData.url || shareData.files.length > 0 || shareData.imageFiles.length > 0 || shareData.textFiles.length > 0 || shareData.otherFiles.length > 0 || shareData.title);

/**
 * Process share target data using the execution core
 */
export const processShareTargetWithExecutionCore = async (
    shareData: ShareData,
    sessionId?: string
): Promise<{ success: boolean; result?: any; error?: string }> => {
    try {
        // Convert share data to action input
        const actionInput: ActionInput = {
            type: shareData.files.length > 0 ? 'files' : shareData.text ? 'text' : 'url',
            files: shareData.files.length > 0 ? shareData.files : undefined,
            text: shareData.text || undefined,
            url: shareData.url || undefined,
            metadata: {
                title: shareData.title,
                timestamp: shareData.timestamp
            }
        };

        // Create execution context
        const context: ActionContext = {
            source: 'share-target',
            sessionId: sessionId || `share_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        // Execute through execution core
        const result = await executionCore.execute(actionInput, context);

        return {
            success: result.type !== 'error',
            result: result
        };

    } catch (error) {
        console.error('[ShareTarget] Execution core processing failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
};
