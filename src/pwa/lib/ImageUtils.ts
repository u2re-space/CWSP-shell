/**
 * Image Processing Utilities for GPT Vision API
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** MIME types supported by GPT vision API */
export const SUPPORTED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp'
] as const;

export type SupportedImageType = typeof SUPPORTED_IMAGE_TYPES[number];

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Check if a file is an image that can be processed by GPT vision
 */
export const isProcessableImage = (file: File | Blob): boolean => {
    const mimeType = file.type?.toLowerCase() || '';
    return SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType);
};

/**
 * Check if a string is a base64 image data URL
 */
export const isImageDataUrl = (str: string): boolean =>
    str.startsWith('data:image/');

// ============================================================================
// CONVERSION
// ============================================================================

/**
 * Convert Uint8Array to base64 string
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return typeof btoa === 'function' ? btoa(binary) : '';
};

/**
 * Convert File/Blob to base64 data URL for GPT vision API
 */
export const fileToDataUrl = async (file: File | Blob): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const base64 = bytesToBase64(bytes);
    const mimeType = file.type || 'application/octet-stream';
    return `data:${mimeType};base64,${base64}`;
};

/**
 * Extract base64 content from data URL
 */
export const extractBase64FromDataUrl = (dataUrl: string): string | null => {
    const match = dataUrl?.match?.(/^data:[^;]+;base64,(.+)$/);
    return match ? match[1] : null;
};

/**
 * Get MIME type from data URL
 */
export const getMimeTypeFromDataUrl = (dataUrl: string): string | null => {
    const match = dataUrl?.match?.(/^data:([^;]+);/);
    return match ? match[1] : null;
};

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate image file size (default max 20MB for GPT)
 */
export const validateImageSize = (file: File | Blob, maxSizeBytes = 20 * 1024 * 1024): boolean =>
    file.size <= maxSizeBytes;

/**
 * Get image dimensions from data URL (browser only)
 */
export const getImageDimensions = async (dataUrl: string): Promise<{ width: number; height: number } | null> => {
    if (typeof Image === 'undefined') return null;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
};
