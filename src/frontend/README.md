# CrossWord Frontend Architecture

## Overview

The CrossWord frontend uses a **Shell + View** architecture that separates UI layout (shells) from content components (views). This enables:

- **Flexible layouts**: Users can choose between different UI shells (basic, faint, raw)
- **Reusable views**: Content components work in any shell
- **Clean separation**: Layout concerns are isolated from business logic
- **Unified boot**: Single entry point for application initialization

## Directory Structure

```
frontend/
├── index.ts                 # Main entry point - exports all modules
│
├── main/                    # 🚀 Boot & Routing (unified)
│   └── index.ts            # Boot loader, routing, app initialization
│
├── shells/                  # 🖼️ UI Layout Shells
│   ├── types.ts            # Shell/View interfaces
│   ├── registry.ts         # Shell/View registries
│   ├── base-shell.ts       # Base shell implementation
│   ├── basic/              # Basic shell (toolbar nav)
│   ├── faint/              # Faint shell (tabbed sidebar)
│   └── raw/                # Raw shell (minimal)
│
├── views/                   # 📝 Content Components
│   ├── types.ts            # View base types
│   ├── index.ts            # View exports
│   ├── ../shared/channel-mixin.ts # Service channel mixin
│   ├── workcenter/         # AI processing view
│   ├── settings/           # Configuration view
│   ├── viewer/             # Document viewer
│   ├── editor/             # Document editor
│   ├── explorer/           # File browser
│   ├── history/            # History viewer
│   ├── home/               # Dashboard view
│   ├── print/              # Print-optimized view
│   └── airpad/             # Remote trackpad view
│
├── styles/                  # 🎨 Style Systems
│   ├── index.ts            # Style loader & config
│   ├── shared/             # Shared utilities
│   │   ├── normalize.scss  # CSS reset
│   │   └── utilities.scss  # Utility classes
│   └── basic/              # Basic style system
│       └── index.scss      # Basic styles
│
├── shared/                  # 🛠️ Shared Utilities
│   ├── index.ts            # Combined exports (utils + shared)
│   ├── markdown-renderer.ts
│   ├── file-utils.ts
│   └── storage.ts
│
├── core/                    # ⚙️ Core Services
│   └── index.ts            # API, storage, channels
│
├── pwa/                     # 📱 PWA Features
│   └── index.ts            # Service worker, install, etc.
│
└── [legacy]                 # 📦 Original code (being migrated)
    ├── basic/              # Legacy basic implementation
    ├── faint/              # Legacy faint implementation
    ├── airpad/             # Legacy airpad (migrated to views/)
    ├── print/              # Legacy print (migrated to views/)
    ├── boot/               # Legacy boot (migrated to main/)
    ├── routing/            # Legacy routing (migrated to main/)
    ├── utils/              # Legacy utils (merged into shared/)
    └── scss/               # Legacy scss (migrated to styles/)
```

## Module Overview

### 📁 `main/` - Boot & Routing

Unified entry point for application initialization:

```typescript
import { initializeApp, bootLoader, quickInit } from "./main";

// Full initialization with auto-config
const shell = await initializeApp(container);

// Or quick initialization
const shell = await quickInit(container, "basic", "viewer");

// Or manual boot
const shell = await bootLoader.boot(container, {
    styleSystem: "veela",
    shell: "faint",
    defaultView: "workcenter",
    rememberChoice: true
});
```

### 📁 `shells/` - UI Layout Shells

Shells are **UI layout systems** that provide:
- Navigation structure (toolbar, sidebar, tabs)
- View container management
- Theme/styling application
- Status messages

| Shell | Description | Style System |
|-------|-------------|--------------|
| `basic` | Classic toolbar navigation | basic (recommended) |
| `faint` | Tabbed sidebar interface | veela (recommended) |
| `raw` | Minimal, no chrome | basic/raw |

### 📁 `views/` - Content Components

Views are **shell-agnostic content components**:

| View | Description | Route |
|------|-------------|-------|
| `workcenter` | AI processing hub | `/workcenter` |
| `settings` | App configuration | `/settings` |
| `viewer` | Document viewer | `/viewer` |
| `editor` | Document editor | `/editor` |
| `explorer` | File browser | `/explorer` |
| `history` | Operation history | `/history` |
| `home` | Dashboard | `/` |
| `print` | Print-optimized | `/print` |
| `airpad` | Remote trackpad | `/airpad` |

### 📁 `styles/` - Style Systems

Style systems provide theming and visual consistency:

| Style | Description | Shells |
|-------|-------------|--------|
| `veela` | Full CSS framework with design tokens | faint |
| `basic` | Minimal functional styling | basic, raw |
| `raw` | No framework, browser defaults | raw |

```typescript
import { loadStyleSystem, STYLE_CONFIGS } from "./styles";

// Load a style system
await loadStyleSystem("veela");

// Get style configuration
const config = STYLE_CONFIGS["basic"];
```

### 📁 `shared/` - Utilities

Consolidated utilities from former `utils/` and `shared/`:

```typescript
import { 
    debounce, 
    throttle, 
    deepClone,
    getItem, 
    setItem,
    StorageKeys
} from "./shared";

// Storage helpers
const theme = getItem(StorageKeys.THEME, "auto");
setItem(StorageKeys.THEME, "dark");

// Utilities
const debouncedSave = debounce(save, 300);
```

### 📁 `core/` - Services

Core frontend services:

```typescript
import { 
    api,
    IDBStorage,
    serviceChannels,
    BROADCAST_CHANNELS
} from "./core";

// API client
const result = await api.process({
    content: "Hello world",
    contentType: "text"
});

// IndexedDB storage
const storage = new IDBStorage("my-db", "my-store");
await storage.set("key", { data: "value" });
```

### 📁 `pwa/` - PWA Features

Progressive Web App functionality:

```typescript
import { initPWA, registerServiceWorker } from "./pwa";

await initPWA();
```

## Shell/Style Matrix

```
| Shells/Styles: | Faint | Basic | Raw |
|----------------|-------|-------|-----|
| Veela          |  [r]  |  [o]  | [o] |
| Basic          |  [o]  |  [r]  | [r] |

[r] - recommended, [o] - optional
```

## Service Channels

Views can communicate with the service worker via channels:

```typescript
// In a view, use the channel mixin from shared
class MyView extends withViewChannel(BaseView, "workcenter") {
    async doProcessing() {
        const channel = this.getServiceChannel("workcenter");
        const result = await channel.processContent(data);
    }
}
```

| Channel | View | Route |
|---------|------|-------|
| `sw-workcenter` | WorkCenter | `/workcenter` |
| `sw-settings` | Settings | `/settings` |
| `sw-viewer` | Viewer | `/viewer` |
| `sw-explorer` | Explorer | `/explorer` |
| `sw-airpad` | Airpad | `/airpad` |
| `sw-print` | Print | `/print` |

## Quick Start

```typescript
// 1. Import from frontend
import { initializeApp, isPWA, getExecutionContext } from "./frontend";

// 2. Check execution context
console.log("Context:", getExecutionContext()); // "web" | "pwa" | "extension"

// 3. Initialize the app
const container = document.getElementById("app")!;
const shell = await initializeApp(container);

// 4. Navigate programmatically
await shell.navigate("workcenter");
```

## Creating New Components

### Creating a New Shell

```typescript
// shells/myshell/index.ts
import { BaseShell } from "../base-shell";

export class MyShell extends BaseShell {
    id = "myshell" as const;
    name = "My Shell";
    
    layout = {
        hasSidebar: false,
        hasToolbar: true,
        hasTabs: false,
        supportsMultiView: false,
        supportsWindowing: false
    };
    
    protected createLayout(): HTMLElement {
        // Return shell DOM structure
    }
}

export default () => new MyShell();
```

### Creating a New View

```typescript
// views/myview/index.ts
import type { View, ShellContext } from "../../shells/types";
import { withViewChannel } from "../shared/channel-mixin";

class MyViewBase implements View {
    id = "myview" as const;
    title = "My View";
    
    async render(context: ShellContext): Promise<HTMLElement> {
        // Return view DOM
    }
}

export class MyView extends withViewChannel(MyViewBase, "workcenter") {}

export const createMyView = () => new MyView();
export default createMyView;
```

## Migration Notes

Legacy directories are being deprecated:

| Legacy | New Location | Status |
|--------|--------------|--------|
| `basic/` | `shells/basic/` | In progress |
| `faint/` | `shells/faint/` | In progress |
| `airpad/` | `views/airpad/` | Migrated |
| `print/` | `views/print/` | Migrated |
| `boot/` | `main/` | Migrated |
| `routing/` | `main/` | Migrated |
| `utils/` | `shared/` | Merged |
| `scss/` | `styles/` | Migrated |

Use imports from the new locations:

```typescript
// ❌ Old
import { loadSubApp } from "./routing/routing";
import { REMOVE_IF_HAS } from "./utils/Utils";

// ✅ New
import { loadSubApp } from "./main";
import { REMOVE_IF_HAS } from "./shared";
```

# Shells system preview

Core/System:
- `boot` is choice screen or what shell will be to boot (in CRX is `content`, silently).

UI-wrappers (for content):
- `base` is shell practially without toolbars or anything (can/may contain padding/margin only).

Minor (virtual, with content, containement):
- `minimal`: Minimal UI/UX, focused by single process.
- `tabbed` : variant of `window` with multiple task tabs.
- `window` : is tabbed/toolbar based UI environment, with single focused task. 
  - has at least only two or three elements: toolbar panel, content, and (sometimes) probably sidebar

Major (multiple-tasked, managed):
- `minimal`: Minimal UI/UX, focused by single process.
- `environment`:
  - in underlying generally used wallpapers or canvas.
  - contains/uses multiple layers (underlying, items, content, overlays).
  - shell with status bar, speed dial (home view), taskbar, etc.
  - looks more like a desktop or webtop.
- `content` for CRX/extensions only (chrome extensions content scripts).
  - has layers: content of website, and overlays (include toasts, and snipping).

---

Needs to make much better system of shells (compatibility, nesting)...
- `base`
  - <overlays>
    - <toasts>
    - <modals>
- `minimal`
  - `base`
  - <overlays>
    - <modals>
    - <toasts>
- `content` (CRX/chrome only)
  - <overlays>
    - <sniping>
    - <tools>
    - <toasts>
- `environment`
  - <underlying>
    - <background>
    - <wallpaper>
    - <canvas>
  - <content>
  - `tabbed`
    - `base`
    - <overlays>
    - <modals>
    - <toasts>
  - `window`
    - `base`
    - <overlays>
    - <modals>
    - <toasts>
  - <overlays>
    - <taskbar>
    - <statusbar>
    - <modals>
    - <toasts>

From `window` shell remove those/such statusbar and taskbars...
