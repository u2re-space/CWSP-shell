# AGENTS.md

## Known gotchas

- **No physical device or emulator is available in the Cloud VM.**
  - You can build, lint, and inspect outputs.
  - You cannot install or run the app on-device in this environment.

- The `endpoint` and `airpad` symlinks in the repo root are **broken**.
  - They point to a sibling repo: `../U2RE.space/`
  - That repo is not present in this workspace.
  - These symlinks are **not required for building**.

- The unit test task may report `NO-SOURCE`.
  - This is expected because the project currently has no unit test files.

- Gradle may auto-download missing SDK components during the first build
  (for example `build-tools;35`).
  - This is normal.

- The `audioswitch-stub` module is a stub replacement for a Twilio dependency.
  - It contains no Kotlin sources.

---

## Additional code locations

When the task is relevant, also inspect these paths:

- `/home/u2re-dev/U2RE.space/modules/projects/uniform.ts/src/newer/` — internal
- `/home/u2re-dev/U2RE.space/runtime/cwsp/endpoint/` — network-related

---

## Model selection

- **Analysis / architecture / planning:** Claude Opus 4.6, GPT 5.4 (`high` or `xhigh`), Gemini 3.1 Pro
- **Coding / implementation / refactoring:** GPT-5.4 (`low` or `medium`), Claude 4.6 Sonnet, Gemini 3.1 Pro
- **Edits / fixes / refinements:** `GPT-5.3-codex-spark`, GPT-5.4 (`instant`, `none`, or `minimal` reasoning), Claude 4.5 Haiku, Gemini 3 Flash
- **Documentation / specs:** GPT-5.4 (`low` or `medium`), Claude 4.6 Sonnet, Gemini 3.1 Pro
- **Recognition / scanning / images:** GPT-5.4 (`low`, `instant`, `none`, or `minimal`), Claude 4.6 Sonnet, Gemini 3.1 Pro, or Gemini 3 Flash

---

## SSH access

Available SSH targets include:

- `ssh U2RE@192.168.0.110`
- `ssh U2RE@192.168.0.111`
- `ssh u2re-dev@192.168.0.200`
- `ssh u2re-dev@192.168.0.201`
- External access / VDS example:
  - `ssh u2re-dev@45.147.121.152`
  - `ssh root@45.150.9.153 -p 22 -i ~/.ssh/id_ecdsa`

---

## Android debugging

- ADB usage (`adb` and/or `adb shell`)
- Connect to `192.168.0.196:5555` (defaultly)
- Reading logcat

---

## Network stack:

How &ould works our network.

```
[ Laptop/Ultrabook ] Bi-dir  {[ Server (Endpoint), Have External Entry IP ]}
[ L-192.168.0.110  ] ←←---→→ {[ 192.168.0.200:8434 / 45.147.121.152:8434  ]}
          ↑                         ↑                         ↑
          ┷                         ↑                         ↑ 
          |                         ↓                         ↓ 
          ┗------------------{[ [L-192.168.0.196] |- - -| [L-192.168.0.208] ]}   # Phone device groups (cws-androids, PWA-airpad)
                                [Android Phone 1]         [Android Phone 2]
```

### Topology

**L-192.168.0.110 <---> L-192.168.0.196**
- clipboard (via android application, and cwsp endpoint server)
- `airpad` signals (PWA/WebView application)
  - mouse
  - keyboard
  - clipboard
- tunneling through 192.168.0.200:8434 / 45.147.121.152:8434 if in LTE/NAT mode, using identification client token

**L-192.168.0.110 <---> L-192.168.0.208**
- clipboard (via android application, and cwsp endpoint server)
- `airpad` signals (PWA/WebView application)
  - mouse
  - keyboard
  - clipboard
- tunneling through 192.168.0.200:8434 / 45.147.121.152:8434 if in LTE/NAT mode, using identification client token

**L-192.168.0.196 <---> L-192.168.0.208**
- clipboard (via android application, and cwsp endpoint server)
- tunneling through 192.168.0.200:8434 / 45.147.121.152:8434 if one of in LTE/NAT mode, using identification client token

**L-192.168.0.110 <---> {[ 192.168.0.200:8434 / 45.147.121.152:8434 ]}**
- initiated or initiator exchanger (bridge/tunnel/link)
- `L-192.168.0.110` is AirPad controllable (by PWA apps)
  - Or directly, or through bridge/proxy
- `L-192.168.0.110` is one of `clipboard` (and/or other data) synchronize/exchanger member
  - Devices through bridge/proxy can/may ask or pass `clipboard` (and/or other data) data

**{[ 192.168.0.200:8434 / 45.147.121.152:8434 ]}** 
- is in general a central coordinator (bridge, and/or tunnel/proxy)

---

## Potential routes what needs to support

- Airpad (PWA) or Native from `L-192.168.0.196` to https://192.168.0.110:8434/ (local/private network)
- Airpad (PWA) or Native from `L-192.168.0.196` through `https://192.168.0.200:8434/`  to `L-192.168.0.110` (local/private network)
- Airpad (PWA) or Native from `L-192.168.0.196` through `https://45.147.121.152:8434/` to `L-192.168.0.110` (any network of device)
- Native (app) Clipboard (and/or other data) from `L-192.168.0.196` to https://192.168.0.110:8434/ (local network, directly)
- Native (app) Clipboard (and/or other data) from `L-192.168.0.196` to through `https://192.168.0.200:8434/`  to `L-192.168.0.110` (local network, directly)
- Native (app) Clipboard (and/or other data) from `L-192.168.0.196` to through `https://45.147.121.152:8434/` to `L-192.168.0.110` (any network of device)
- CWSP/`endpoint` Clipboard (and/or other data) from `L-192.168.0.110` to https://192.168.0.196:8434/ (rare case, local network, directly)
- CWSP/`endpoint` Clipboard (and/or other data) from `L-192.168.0.110` to through `https://192.168.0.200:8434/`  to `L-192.168.0.196` (local network, directly)
- CWSP/`endpoint` Clipboard (and/or other data) from `L-192.168.0.110` to through `https://45.147.121.152:8434/` to `L-192.168.0.196` (any network of device)

### `L-192.168.0.196` may/can be:

- Simulator/debug client from `45.150.9.153` (VDS), with client token `n3v3rm1nd` instead of IP
- PWA or Native application from NAT (unknown IP, but with client token `n3v3rm1nd` instead of IP)
- PWA or Native application from private/local network with IP `192.168.0.196`.
