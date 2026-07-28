import { crxFrontend } from "shells/boot";
import { loadSettings } from "com/config/Settings";

const mount = document.getElementById("app") as HTMLElement | null;

const renderDisabled = () => {
    const root = document.createElement("div");
    root.style.cssText =
        "width:100%;height:100%;display:grid;place-items:center;background:#0b0b0c;color:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;box-sizing:border-box;";
    const card = document.createElement("div");
    card.style.cssText =
        "max-width:680px;width:100%;border:1px solid rgba(255,255,255,0.14);border-radius:16px;padding:18px;background:rgba(255,255,255,0.04);display:grid;gap:10px;";
    const h = document.createElement("div");
    h.textContent = "New Tab Page is disabled";
    h.style.cssText = "font-size:18px;font-weight:700;";
    const p = document.createElement("div");
    p.textContent = "Enable it in Extension Settings → \"Enable New Tab Page (offline Basic)\".";
    p.style.cssText = "opacity:0.9;line-height:1.4;";
    const btn = document.createElement("button");
    btn.textContent = "Open Extension Settings";
    btn.style.cssText =
        "justify-self:start;border:1px solid rgba(255,255,255,0.18);border-radius:12px;background:rgba(255,255,255,0.06);color:#f5f5f5;padding:10px 12px;cursor:pointer;";
    btn.addEventListener("click", () => {
        try {
            chrome.runtime.openOptionsPage();
        } catch {
            // ignore
        }
    });

    card.append(h, p, btn);
    root.append(card);
    mount?.replaceChildren(root);
};

void loadSettings()
    .then((s) => {
        if (!mount) return;
        if (!s?.core?.ntpEnabled) {
            renderDisabled();
            return;
        }
        // Chromeless immersive shell — no toolbar, just the viewer
        crxFrontend(mount, { shell: "immersive", initialView: "viewer" });
    })
    .catch(() => renderDisabled());
