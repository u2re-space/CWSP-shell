/**
 * Minimal `toText` for CRX service worker — avoids importing `core/modules/Clipboard`,
 * which pulls lure controllers and lands in `com/app.js` with DOM/icon code.
 */
export const toText = (data: unknown): string => {
	if (data == null) return "";
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data, null, 2);
	} catch {
		return String(data);
	}
};
