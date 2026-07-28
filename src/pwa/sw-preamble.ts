/// <reference lib="webworker" />
/** Must stay the first import of `sw.ts` so it runs before Workbox's logger module initializes. */
(globalThis as unknown as { __WB_DISABLE_DEV_LOGS?: boolean }).__WB_DISABLE_DEV_LOGS = true;

// Workbox `ExpirationPlugin` can race IndexedDB (`CacheTimestampsModel`) with SW update/teardown:
// "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."
self.addEventListener("unhandledrejection", (event) => {
    const r = event.reason as DOMException | Error | undefined;
    const name = r && typeof r === "object" && "name" in r ? String((r as { name?: string }).name) : "";
    const msg =
        r && typeof r === "object" && "message" in r && typeof (r as { message?: string }).message === "string"
            ? (r as { message: string }).message
            : String(r ?? "");
    if (
        name === "InvalidStateError" &&
        /database connection is closing|IDBDatabase/i.test(msg)
    ) {
        event.preventDefault();
    }
});
