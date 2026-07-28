# CrossWord CRX Spec

## Scope

Chrome extension code covers:

- CRX service worker
- popup pages
- content scripts
- runtime/tab/port message bridges
- snip/capture and result delivery

## Contract

CRX packets must normalize through the same shared interop adapter as the PWA and main app:

- `protocol: "chrome"`
- transport hint such as `chrome-runtime`, `chrome-tabs`, or `chrome-port`
- canonical destination ids when handing data to app views

## Snip / Capture Pipeline

CRX capture results are treated as ingress payloads.

Required shape:

- envelope/message id
- source context
- capture mode
- data payload
- optional routing hint or processing metadata

## Result Delivery

- service worker may coordinate processing
- content scripts may initiate capture or bridge `/user` filesystem access
- final app-facing delivery should still use canonical destination ids and the shared adapter

## OPFS Boundary

CRX content scripts may bridge to an active app tab for `/user` filesystem access, but this is compatibility behavior. The ownership model for CrossWord user files belongs to the app/PWA storage boundary, not to whichever CRX page happens to be open.
