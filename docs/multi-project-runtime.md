# Multi-project runtime

Rootbound uses one supervised runtime per active tunnel connection and can expose multiple explicitly authorized project workspaces through that runtime.

## Runtime model

```text
ChatGPT
  -> one Rootbound MCP/tunnel runtime
      -> connection-scoped project allowlist
          -> project A
          -> project B
          -> project C
```

The project used to start the supervisor is the **runtime anchor**. The anchor is an infrastructure bootstrap identity, not an implicit selection for later tool calls.

Connecting another trusted project on the same connection grants that project to the connection and reuses the existing runtime. It does not stop the current supervisor or replace the anchor.

## Project selection

Project-facing operations are resolved from an explicit `cwd`, a durable project/binding/rescue scope, or the only available project on the connection.

When more than one project is available and no safe scope is present, Rootbound fails closed with `PROJECT_SCOPE_REQUIRED`. It never chooses the most recently used project or silently falls back to the runtime anchor.

`codex.workspace_list` returns only projects visible to the current connection. `codex.workspace_open` accepts either `projectRef` or `cwd` and revalidates exact-root Codex authority before returning project context.

Names are display metadata only. Durable routing uses `projectRef` and canonical paths, so duplicate project names are valid.

## Connection isolation

Saved Rootbound connections have independent project allowlists. Granting a project to one connection does not expose it to another connection.

`rootbound connect .` on the active connection is the explicit grant operation. Grants are idempotent and persisted atomically under connection-scoped private state.

For upgrades from the original single-connection runtime, Rootbound can seed the only existing connection from already trusted registered projects. Once multiple saved connections exist, no implicit cross-connection migration is performed.

The advanced `ROOTBOUND_TUNNEL_ARGV_JSON` environment-only mode remains intentionally unscoped because it has no durable saved-connection identity.

## Runtime lifecycle

- `rootbound connect <project>` validates tunnel, exact-root trust and Doctor as before.
- the project is registered and granted to the active connection;
- if the matching connection runtime is already healthy, it is reused;
- if no runtime exists, the requested project becomes the runtime anchor;
- a running runtime on a different connection is never silently reused;
- supervisor restart validates that its anchor is still allowed on the target connection before launching the tunnel.

Connection switching remains transactional. If the target connection cannot legally host the current runtime anchor, startup fails and the existing connection-switch rollback path can restore the previous runtime.

## Fail-closed errors

Project routing uses typed, non-retryable state/configuration errors for deterministic caller mistakes:

- `PROJECT_SCOPE_REQUIRED`
- `PROJECT_SCOPE_UNAVAILABLE`
- `PROJECT_NOT_FOUND`
- `PROJECT_NOT_ALLOWED_FOR_CONNECTION`
- `PROJECT_PATH_UNAVAILABLE`
- `PROJECT_SCOPE_MISMATCH`

Transport/transient retries do not turn these errors into guesses.

## Paths and containment

Rootbound canonicalizes paths where possible and resolves the most specific registered project containing an absolute `cwd`. A registered nested project that is not allowed cannot be bypassed by treating its files as part of an allowed parent project.

Relative cwd is accepted only when Rootbound has a single unambiguous project scope. Attempts to escape that project fail closed.

## Commands and mutations

The connection scope wraps the central Codex authority executor, so command execution, Git, edits, long-running commands, rescue operations and project history all inherit the same project boundary.

Long commands retain their existing durable `projectRef` and `cwd`. Poll/write/terminate operate by command identity and do not re-route a running command to another project.

Write-capable operations are not automatically replayed after ambiguous transport failure. Existing hash/idempotency protections continue to apply.

The detached buffered command worker used by the Windows implementation independently revalidates the persisted command cwd against the current connection allowlist before execution.

## Continuity

Bindings and rescue sessions already carry `projectRef`, so they remain authoritative project scopes. When multiple registered projects exist, the runtime anchor is not exposed as an implicit continuity default.

A continuation with genuinely ambiguous project/thread evidence must return an ambiguity/state error instead of selecting whichever project started the supervisor.

## Concurrency

Multi-project support does not create one daemon per project. Existing command concurrency controls remain in place. Long-running commands can coexist by command id; Rootbound does not introduce cross-repository transactions or automatic rollback across projects.

## Manual release smoke test

Before merging a multi-project release on a real Mac:

1. connect project A and capture runtime id / supervisor pid;
2. connect project B and verify the same runtime id / pid is reused;
3. call `codex.workspace_list` and verify A and B are returned;
4. open/read Git status in A, then B, without reconnecting;
5. perform a guarded edit in A and verify B is untouched;
6. perform a guarded edit in B and verify A is untouched;
7. start long commands in both projects and poll both command ids;
8. issue an unscoped project operation with A+B available and verify `PROJECT_SCOPE_REQUIRED`;
9. restart Rootbound and verify both workspaces remain available;
10. if multiple saved connections exist, verify each connection exposes only its own granted projects and that an unauthorized anchor causes connection switch rollback rather than cross-connection access.

After changing the public surface, reconnect/refresh the ChatGPT custom MCP app so ChatGPT does not keep an older cached tool snapshot.
