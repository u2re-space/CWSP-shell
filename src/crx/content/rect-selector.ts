/**
 * Rectangle-selection overlay used by the CRX snipping flow.
 *
 * It installs a full-page overlay inside the content script, captures a drag
 * rectangle, and resolves that selection back to the caller via a small
 * promise-based API.
 */
export class RectSelector {
    private overlay: HTMLElement | null = null;
    private selectionBox: HTMLElement | null = null;
    private startX = 0;
    private startY = 0;
    private isSelecting = false;
    private onSelect: ((rect: { x: number; y: number; width: number; height: number }) => void) | null = null;
    private onCancel: (() => void) | null = null;

    constructor() {
        this.createOverlay();
    }

    /** Create the transient overlay DOM used while the user is selecting a region. */
    private createOverlay(): void {
        // Create main overlay
        this.overlay = document.createElement('div');
        Object.assign(this.overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.1)',
            cursor: 'crosshair',
            zIndex: '999999',
            userSelect: 'none'
        });

        // Create selection box
        this.selectionBox = document.createElement('div');
        Object.assign(this.selectionBox.style, {
            position: 'absolute',
            border: '2px solid #007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.1)',
            display: 'none',
            pointerEvents: 'none'
        });

        // Create instruction text
        const instruction = document.createElement('div');
        Object.assign(instruction.style, {
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '10px 20px',
            borderRadius: '5px',
            fontFamily: 'Arial, sans-serif',
            fontSize: '14px',
            zIndex: '1000000',
            pointerEvents: 'none'
        });
        instruction.textContent = 'Click and drag to select area. Press Escape to cancel.';
        Object.assign(instruction.style, { zIndex: '2147483646' });
        Object.assign(this.overlay.style, { zIndex: '2147483645' });

        this.overlay.appendChild(this.selectionBox);
        this.overlay.appendChild(instruction);
        const root = document.body || document.documentElement;
        root.appendChild(this.overlay);

        this.attachEventListeners();
    }

    private attachEventListeners(): void {
        if (!this.overlay) return;

        // Mouse down - start selection
        this.overlay.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.isSelecting = true;
            this.startX = e.clientX;
            this.startY = e.clientY;

            if (this.selectionBox) {
                Object.assign(this.selectionBox.style, {
                    left: `${this.startX}px`,
                    top: `${this.startY}px`,
                    width: '0px',
                    height: '0px',
                    display: 'block'
                });
            }
        });

        // Mouse move - update selection
        this.overlay.addEventListener('mousemove', (e) => {
            if (!this.isSelecting || !this.selectionBox) return;

            const currentX = e.clientX;
            const currentY = e.clientY;

            const left = Math.min(this.startX, currentX);
            const top = Math.min(this.startY, currentY);
            const width = Math.abs(currentX - this.startX);
            const height = Math.abs(currentY - this.startY);

            Object.assign(this.selectionBox.style, {
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`
            });
        });

        // Mouse up - complete selection
        this.overlay.addEventListener('mouseup', (e) => {
            if (!this.isSelecting) return;

            const endX = e.clientX;
            const endY = e.clientY;

            const x = Math.min(this.startX, endX);
            const y = Math.min(this.startY, endY);
            const width = Math.abs(endX - this.startX);
            const height = Math.abs(endY - this.startY);

            // Minimum size check
            if (width > 10 && height > 10) {
                const rect = { x, y, width, height };
                this.cleanup();
                this.onSelect?.(rect);
            } else {
                this.cancel();
            }

            this.isSelecting = false;
        });

        // Keyboard - cancel on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.cancel();
            }
        });
    }

    private cancel(): void {
        this.cleanup();
        this.onCancel?.();
    }

    private cleanup(): void {
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.selectionBox = null;
        this.isSelecting = false;
    }

    /** Start a one-shot rectangle selection session and resolve with the chosen area or `null`. */
    selectArea(): Promise<{ x: number; y: number; width: number; height: number } | null> {
        return new Promise((resolve, reject) => {
            this.onSelect = (rect) => resolve(rect);
            this.onCancel = () => resolve(null);
        });
    }

    destroy(): void {
        this.cleanup();
        this.onSelect = null;
        this.onCancel = null;
    }
}

/** Global function injected for other CRX flows that need to trigger snip selection. */
declare global {
    interface Window {
        crxSnipSelectRect?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
    }
}

const installGlobalRectSelector = () => {
    globalThis.crxSnipSelectRect = async () => {
        const selector = new RectSelector();
        try {
            return await selector.selectArea();
        } finally {
            selector.destroy();
        }
    };
};

if (typeof document !== "undefined" && (document.body || document.readyState === "complete")) {
    installGlobalRectSelector();
} else if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", installGlobalRectSelector, { once: true });
}