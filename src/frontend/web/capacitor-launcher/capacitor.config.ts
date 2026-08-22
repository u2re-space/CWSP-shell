/*
 * Filename: capacitor.config.ts
 * FullPath: apps/CWSP-shell/src/frontend/web/capacitor-launcher/capacitor.config.ts
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher Capacitor — webDir + platforms/android path.
 */

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "space.u2re.cw",
    appName: "CW-i1",
    webDir: "../../../build/capacitor/web",
    android: {
        path: "platforms/android"
    },
    plugins: {
        Keyboard: {
            resize: "none",
            resizeOnFullScreen: false
        },
        // WHY: Capacitor 8 SystemBars pads a slab on API 35+; Java hides the 3-button nav.
        SystemBars: {
            style: "DARK",
            insetsHandling: "disable"
        }
    },
    server: {
        androidScheme: process.env.CWSP_ANDROID_SCHEME || "https",
        cleartext: process.env.CWSP_ALLOW_CLEARTEXT === "1"
    }
};

export default config;
