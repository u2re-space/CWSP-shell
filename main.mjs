import app from "./src/index.ts";


/* App Loader */
export default async function loadApp(mountElement) {
    app?.(mountElement);
}

//
/*if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./src/pwa/sw.ts', { type: 'module', scope: '/' })?.catch?.(console.warn.bind(console)); } catch(e) { console.warn(e); }
}*/

//
loadApp(document.getElementById("app"));
