# AGENTS.md

Follow the repo-root `AGENTS.md` (token budget; no auto-review or full-test loops).

Cloud-VM gotchas (this tree only):

- No physical device/emulator: build and lint only.
- Root `endpoint` / `airpad` symlinks to a sibling repo may be missing; they are not required to build.
- Unit tests may report `NO-SOURCE` if this package has no tests.
- Gradle may download SDK pieces on first build.
- `audioswitch-stub` is a Twilio stub (no Kotlin sources).

CWSP protocol: `.cursor/rules/network.mdc` only when the task is network/clipboard/AirPad.
Do not copy topology, SSH, or credentials into this file.
