/**
 * MV3 CRX build: `misc/*` modules that use `observe`/`iterated`/`safe` must resolve here
 * instead of `fest/object`, or the bundler merges reactivity with `com-app` and
 * `com/service.js` statically imports `./app.js` (DOM/customElements in the SW).
 *
 * Identity stubs are enough for SW + timeline helpers.
 */
export const observe = <T extends object>(value: T): T => value;

export const iterated = (_wrapped: unknown, _fn: (item: unknown, index: number) => void): void => {
    /* no-op: IDB-backed arrays do not need iteration side effects in SW */
};

export const safe = <T>(value: T): T => value;
