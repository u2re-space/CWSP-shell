# CrossWord Shells Spec

## Scope

Shells own navigation, layout, and view mounting. They are not a second messaging protocol.

## Responsibilities

- mount canonical views by canonical view id
- bind view receive channels once per loaded view
- react to canonical destination ids when deciding which view to show
- keep compatibility aliases only at the boundary where older routes or hash names still exist

## Messaging Rule

Shell code may mirror through `BroadcastChannel` for compatibility, but canonical delivery still flows through unified messaging and the shared view receive binding.

## Navigation Rule

- destination id decides the target consumer
- route path or hash is a shell concern
- shell navigation must not rewrite the logical destination semantics

## Compatibility Guardrail

If a shell still exposes legacy hash names such as `#markdown-viewer`, it must map them back to canonical ids before dispatching or binding handlers.

# CrossWord Views Spec

## Scope

Views are canonical consumers of routed app messages.

Examples:

- `viewer`
- `workcenter`
- `explorer`
- `settings`
- `history`
- `editor`
- `print`

## Receive Contract

Views receive normalized `UnifiedMessage` deliveries through `bindViewReceiveChannel(...)`.

That binding must handle:

- direct unified message delivery
- queued pending messages
- `rs-view-*` transport fan-out for `view-transfer`
- `view-post` payloads forwarded through the same receive lifecycle

## Naming Rule

View ids are canonical (`viewer`, `explorer`, `workcenter`, ...). Legacy ids such as `markdown-viewer` and `file-explorer` remain compatibility aliases only.

## Routing Rule

Views should not directly depend on transport names. They react to:

- canonical destination id
- normalized message type
- message data and metadata

## Ingress Rule

Share target and launch queue must reach views through `ViewTransferRouting.ts`, not through view-specific one-off cache polling or ad-hoc `BroadcastChannel` names.
