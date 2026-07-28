/**
 * CRX-only re-exports for the extension service worker + `service/api.ts`.
 * Import **statically** from `sw.ts` / `api.ts` (avoid `import()` — Vite emits `__vitePreload`
 * into `com/app.js`, which pulls DOM/lure/icon into the MV3 service worker).
 */
export {
    recognizeImageData,
    getGPTInstance,
    processDataWithInstruction,
    recognizeByInstructions,
    solveAndAnswer,
    writeCode,
    extractCSS,
} from "com/service/service/RecognizeData";
export { getCustomInstructions } from "com/service/instructions/CustomInstructions";
export { executionCore } from "com/service/misc/ExecutionCore";
