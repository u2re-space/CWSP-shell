//
export const dataSourceCacheBinary = new WeakMap<File | Blob | ArrayBuffer, string>();
export const dataSourceCacheString = new Map<string, string>();

//
export const hasInDataSourceCache = (dataSource: string | Blob | File | any) => {
    if (dataSource instanceof File || dataSource instanceof Blob || dataSource instanceof ArrayBuffer) {
        return dataSourceCacheBinary?.has(dataSource) && dataSourceCacheBinary?.get?.(dataSource);
    } else {
        return dataSourceCacheString?.has(dataSource) && dataSourceCacheString?.get?.(dataSource);
    }
}

//
export const getFromDataSourceCache = (dataSource: string | Blob | File | any) => {
    if (dataSource instanceof File || dataSource instanceof Blob || dataSource instanceof ArrayBuffer) {
        return dataSourceCacheBinary?.get?.(dataSource);
    } else {
        return dataSourceCacheString?.get?.(dataSource);
    }
}

//
export const setToDataSourceCache = (dataSource: string | Blob | File | any, responseId: string) => {
    if (dataSource instanceof File || dataSource instanceof Blob || dataSource instanceof ArrayBuffer) {
        dataSourceCacheBinary?.set?.(dataSource, responseId);
    } else {
        dataSourceCacheString?.set?.(dataSource, responseId);
    }
}

//
export const getOrDefaultComputedOfDataSourceCache = (dataSource: string | Blob | File | any, defaultValueCb: (dataSource: string | Blob | File | any) => string | null | Promise<string | null> = () => null) => {
    if (hasInDataSourceCache(dataSource)) {
        return getFromDataSourceCache(dataSource);
    } else {
        const value = defaultValueCb?.(dataSource);
        if (value instanceof Promise) {
            value?.then?.((v) => setToDataSourceCache(dataSource, v || ""));
        } else {
            setToDataSourceCache(dataSource, value || "");
        }
        return value;
    }
}
