<div align="center">

# Rootbound

### Give ChatGPT safe local coding access through Codex.

**Apple Silicon macOS Technical Preview**

Current preview: **0.1.0-preview.3**

Windows support is implemented in parts of the codebase but is **not part of this public preview yet**. Real-machine Windows validation is still pending.

</div>

Rootbound connects ChatGPT to real projects on your Mac while keeping Codex as the local trust, sandbox, permission, and execution authority.

> **ChatGPT reasons. Rootbound performs model-free local actions. Codex keeps control of local trust and permissions.**

Rootbound is useful when you want ChatGPT to inspect, edit, test, commit, and continue work in the same local codebases you already use with Codex — without secretly delegating the reasoning to another Codex model.

---

## What is new in 0.1.0-preview.3?

`0.1.0-preview.3` removes Rootbound's one-active-project limitation without introducing one daemon or tunnel per repository.

### One runtime, several authorized projects

Connect each project once on the active Rootbound connection:

```sh
cd ~/Documents/Dev/project-a
rootbound connect .

cd ~/Documents/Dev/project-b
rootbound connect .
```

The healthy supervised runtime is reused. Each saved connection keeps its own project allowlist, and ChatGPT can discover the allowed projects with `codex.workspace_list`.

The project that bootstraps the runtime becomes its **anchor**, but the anchor is infrastructure state only. It is never a hidden “current project”. If several projects are available and a project-facing request is not safely scoped, Rootbound returns `PROJECT_SCOPE_REQUIRED` instead of guessing.

The public MCP contract is now **33 tools** on `rootbound-public-preview-v6`.

### Security and lifecycle guarantees

- project grants are isolated per saved connection;
- canonical path routing rejects cross-project and nested-project allowlist bypasses;
- commands, Git, edits, browser/context reads and continuity share the same central project-scope guard;
- long commands retain their durable `projectRef` / `cwd` identity;
- the detached Windows command worker independently revalidates connection scope before execution;
- connection switching validates the current runtime anchor on the target connection and can roll back transactionally on failure;
- existing one-connection installs can migrate trusted registered projects to that single connection, but no implicit grant migration occurs once multiple saved connections exist.

See [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md) for routing, errors, retries, concurrency and the real-Mac acceptance test.

### Also retained from preview.2

Apple Silicon macOS can capability-probe a newly bundled, unknown Codex build before use instead of failing solely because its exact version string changed. Unknown builds are accepted for the current process only after the model-free App Server/permission probe succeeds; trust is never widened to a wildcard version range.

You can inspect that compatibility contract with:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

See [`docs/multi-connection.md`](docs/multi-connection.md), [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md), and [`docs/continuity-runtime.md`](docs/continuity-runtime.md) for the detailed runtime contracts.

---

# How Rootbound works

```text
ChatGPT
   ↓
Rootbound public MCP surface
   ↓
connection-scoped project routing
   ↓
model-free local primitives
   ↓
Codex App Server permissions / sandbox
   ↓
Your projects, Git repos and local commands
```

You can ask ChatGPT things like:

```text
@Rootbound find where authentication is handled
```

```text
@Rootbound fix the failing tests and run them again
```

```text
@Rootbound show me what changed in Git
```

```text
@Rootbound continue
```

Rootbound does **not** expose a public Codex model/agent lane. ChatGPT remains the reasoning model.

---

# Beginner setup — from zero

You do not need to understand MCP, JSON-RPC, SQLite, tunnel profiles, or Codex App Server internals.

The normal setup has five parts:

```text
1. Install the prerequisites
2. Install Rootbound
3. Connect one or more local projects
4. Add the matching tunnel in ChatGPT
5. Test it
```

## 1. Prerequisites

Rootbound currently requires:

- **Git**
- **Node.js 22.13 or newer**
- **Codex installed locally**
- OpenAI **`tunnel-client`**
- a ChatGPT account/workspace that can use the required custom MCP app/connector actions

Check Git and Node:

```sh
git --version
node --version
```

Rootbound uses your local Codex installation as the trust and sandbox layer. It does not install or replace Codex for you.

## 2. Install Rootbound

```sh
git clone https://github.com/LeoMbm/Rootbound.git
cd Rootbound
sh ./bin/rootbound-install.sh
```

The installer checks Node/Codex, stages the app under your user Library, installs production dependencies, and creates a `rootbound` CLI link under `~/.local/bin`.

Verify:

```sh
rootbound version
```

### Windows

Windows support is not part of this public Technical Preview yet. Windows-specific implementation remains in the repository for ongoing validation.

## 3. Connect the projects you want ChatGPT to work on

```sh
cd ~/Documents/Dev/my-app
rootbound connect .
```

This is the **Normal setup: one command**. The **guided one-command** flow handles tunnel setup, exact-root Codex trust, Rootbound's runtime-only permission contract, project registration, validation, connection-scoped project access, and runtime startup.

Connect additional projects the same way:

```sh
cd ~/Documents/Dev/another-app
rootbound connect .
```

On the same Rootbound connection, the existing healthy runtime is reused. The second project is granted to that connection; Rootbound does not stop the first runtime just to switch repositories.

You may see Node's `SQLite is an experimental feature` warning. That warning by itself does not mean Rootbound failed.

### Rootbound local permissions

Normal Codex `:workspace` protects Git metadata such as `.git/index.lock`. Rootbound therefore uses a **runtime-only named Codex profile** called `rootbound` for complete Git workflows.

The profile extends `:workspace`, grants `.git` write access inside the authorized workspace, enables outbound network access, and keeps local binding disabled.

The profile is injected only into Codex App Server processes launched by Rootbound and is **never written into `~/.codex/config.toml`**.

A successful first approval includes output similar to:

```text
Permissions: approved runtime-only rootbound
```

Remote callers can request only the public Rootbound `readOnly` / `inherit` behavior; they cannot select an arbitrary stronger Codex profile.

### Exact-root trust

Rootbound asks for explicit Codex trust for each exact project root. A backup of the Codex config is created before trust mutation.

Successful setup looks similar to:

```text
Rootbound workspace ready.
Project: /Users/you/Documents/Dev/my-app
Trust: added exact-root trust
Permissions: approved runtime-only rootbound
Tunnel: configured
Connection access: 1 workspace(s)
Runtime: running
```

## 4. Add Rootbound to ChatGPT

Open ChatGPT settings and create a custom MCP app/connector using **Connection: Tunnel**. Select the same tunnel ID Rootbound is currently using.

Inspect the active connection with:

```sh
rootbound connection current
```

Rootbound can validate its local side, but it cannot reliably inspect which tunnel the ChatGPT UI currently selected.

After a public surface change, reconnect/refresh the custom MCP app so ChatGPT does not keep an older cached tool snapshot.

## 5. Test it

From ChatGPT:

```text
@Rootbound list my workspaces, open the one I ask for, and show me its Git status
```

Local health checks:

```sh
rootbound status
rootbound self-test .
rootbound doctor "$PWD"
```

Doctor and self-test do not intentionally start a Codex model turn.

---

# Daily use

## Work across several projects

Register/grant each project once on the active connection:

```sh
cd ~/Documents/Dev/project-a
rootbound connect .

cd ~/Documents/Dev/project-b
rootbound connect .
```

Rootbound keeps **one supervised runtime per active connection** and exposes multiple allowed workspaces through it. The first project used to start that runtime becomes the **runtime anchor** for bootstrap/restart purposes only. It is not an implicit project choice for later tool calls.

In ChatGPT, `codex.workspace_list` discovers the projects allowed on the current connection. Project-facing operations are then scoped by `projectRef`, `cwd`, a continuity binding/rescue, or the only available project.

If several projects are available and an operation has no safe scope, Rootbound returns `PROJECT_SCOPE_REQUIRED` instead of guessing or falling back to the anchor.

```sh
rootbound start /path/to/project
rootbound status
rootbound stop
```

See [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md) for routing, migration, retry, concurrency and smoke-test details.

## Multiple tunnel connections

```sh
rootbound connection list
rootbound connection current
rootbound connection add work
rootbound connection switch work
rootbound connection repair work
rootbound connection remove work
```

Each scoped connection keeps its tunnel configuration, runtime key, and project allowlist isolated. A running connection switch is transactional: Rootbound validates the target, restarts the current runtime anchor on that connection only if the anchor is allowed there, requires `/readyz`, and restores the previous runtime if the target cannot become ready.

Rootbound calls these **connections**, not ChatGPT accounts. It does not store ChatGPT emails, ChatGPT OAuth tokens, or Codex OAuth credentials in the connection registry.

## Runtime logs

```sh
rootbound logs
rootbound logs --follow
rootbound logs --follow --new-only
```

`--new-only` separates historical log tail from entries generated after follow mode begins.

---

# Continue after Codex is interrupted

The primary rescue entry point is:

```text
@Rootbound continue
```

The flow is:

```text
Codex work is interrupted / quota is exhausted
        ↓
Rootbound resolves an authorized project scope
        ↓
project + repo + thread + worktree are revalidated
        ↓
existing durable rescue is reattached, or a new rescue starts
        ↓
ChatGPT receives bounded recent context + real local state
        ↓
ChatGPT continues the work
        ↓
Rootbound creates a verified handoff manifest
        ↓
verified checkpoint is injected back into the original Codex thread
```

A later ChatGPT conversation can reattach to the same rescue if the saved rescue, original thread, and current worktree still agree.

Rootbound refuses ambiguous project/thread selection, conflicting drift, unsafe rollback, and tampered manifests. With multiple registered projects, the runtime anchor is not used as a hidden continuity fallback.

For supported Rootbound mutations, `codex.continuity_rollback` restores only safely snapshotted Rootbound-owned rescue mutations. Rootbound does not implement rescue rollback with `git reset`.

---

# Everyday CLI reference

```sh
rootbound connect .
rootbound start /path/to/project
rootbound status
rootbound stop

rootbound project list
rootbound project remove /path/to/project
rootbound project remove /path/to/project --remove-trust
rootbound trust remove /path/to/project

rootbound connection list
rootbound connection current
rootbound connection add work
rootbound connection switch work
rootbound connection repair work
rootbound connection remove work

rootbound logs
rootbound logs --follow
rootbound logs --follow --new-only

rootbound self-test .
rootbound diagnostic
```

Upgrade from another release directory:

```sh
rootbound upgrade --from /path/to/rootbound-release
```

Rootbound keeps persistent state outside the installed app tree, so a staged upgrade does not replace project/continuity state.

---

# Public tool surface

The current surface exposes **33 public tools**.

Current surface identifier: `rootbound-public-preview-v6`.

### Workspace and context

- `codex.workspace_list`
- `codex.workspace_open`
- `codex.project_context`
- `codex.skill_list`
- `codex.skill_read`

`workspace_list` returns only workspaces allowed for the current saved connection. `workspace_open` accepts `projectRef` or `cwd`, rechecks exact-root authority, and fails closed when scope is ambiguous.

### Repository inspection

- `codex.repo_search`
- `codex.read_many`
- `codex.git_status`
- `codex.git_diff`

### Editing

- `codex.apply_patch`
- `codex.precise_edit`
- `codex.edit_undo`
- `codex.edit_redo`

### Commands

- `codex.command_exec`
- `codex.command_start`
- `codex.command_poll`
- `codex.command_write`
- `codex.command_terminate`

Nested Codex CLI/model launches are refused on the model-free command lane.

### Codex history and durable continuity

- `codex.thread_list`
- `codex.thread_read`
- `codex.thread_items`
- `codex.continuity_bind`
- `codex.continuity_status`
- `codex.continuity_checkpoint`
- `codex.continuity_unbind`

### Rescue / continuation

- `codex.continuity_resume`
- `codex.continuity_search`
- `codex.continuity_rollback`
- `codex.continuity_handoff`
- `codex.quota_status`

`codex.continuity_resume` is the preferred entry point for interruption/quota rescue. `codex.continuity_handoff` persists and injects the bounded verified handoff without starting a model turn. `codex.continuity_rollback` fails closed unless rollback coverage is provably safe.

### Browser Reader

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

Browser Reader is intentionally read-only in the public surface.

---

# Safety model

Rootbound is intentionally fail-closed.

- exact-root trust is explicit;
- each saved connection has an independent project allowlist;
- project-facing calls are centrally scoped and ambiguous multi-project calls fail with `PROJECT_SCOPE_REQUIRED` rather than guessing;
- nested registered projects cannot bypass a connection allowlist by being treated as files under an allowed parent;
- the runtime anchor is bootstrap state, never a hidden project selector;
- public callers cannot widen the local permission ceiling;
- the Rootbound permission profile is process-local;
- connection runtime keys stay outside registry metadata, normal logs, diagnostics, and public status output;
- new scoped tunnel connections require `/readyz` before becoming active;
- connection switches, repair, removal, start/stop, and tunnel mutation are serialized to avoid runtime races;
- common secret-bearing files are excluded from ordinary read/search flows unless explicitly requested;
- diagnostics redact credentials, home paths, and sensitive thread information;
- drift and rollback conflicts stop instead of guessing;
- continuity manifests are integrity checked;
- unknown Apple Silicon macOS Codex builds must pass the model-free capability probe before current-process use;
- no public Rootbound tool silently starts a Codex model turn.

See [`SECURITY.md`](SECURITY.md) and [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md) for the complete boundaries.

---

# Persistence

On macOS, Rootbound keeps application and durable state separate:

```text
~/Library/Application Support/Rootbound/
├── app/
├── state/
│   ├── rootbound.sqlite3
│   ├── connection-registry.json
│   ├── connection-projects-<connection-id>.json   # legacy/default layout
│   └── connections/
│       └── <connection-id>/projects.json          # scoped connection layout
├── runtime/
├── logs/
└── backups/
```

Existing pre-multi-connection tunnel files are preserved as the legacy/default connection rather than destructively migrated.

Multi-project project grants are connection-scoped files and do **not** bump the Rootbound SQLite schema.

---

# Common problems

## `rootbound: command not found`

The CLI normally lives at:

```text
~/.local/bin/rootbound
```

If installation updated your shell profile, open a new Terminal window.

## Connector exists but calls fail

```sh
rootbound status
rootbound connection current
```

Make sure ChatGPT is using the same tunnel ID as the active Rootbound connection.

After changing `rootbound-public-preview-*`, reconnect the ChatGPT connector/app to refresh its cached MCP tool snapshot.

## `PROJECT_SCOPE_REQUIRED`

Several workspaces are available and the request did not identify one safely. Call `codex.workspace_list`, then retry with the intended `projectRef` or an absolute `cwd` inside that project.

Rootbound deliberately does not remember a mutable global “active project” for ChatGPT conversations.

## Project is not available on this connection

Run `rootbound connect .` from that project while the intended Rootbound connection is active. Rootbound does not copy project grants between saved connections automatically.

## Runtime key was revoked

```sh
rootbound connection repair <name>
```

Repair validates the replacement before committing it and restores the previous key/config if validation fails.

## Codex auto-updated

On Apple Silicon macOS, `rootbound connect .` automatically capability-probes an unknown bundled Codex build before use. A compatible build can proceed for the current process without modifying the built-in allowlist.

For an explicit diagnostic:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

If the capability probe fails, Rootbound fails closed. Do not manually add wildcard version ranges to the production policy.

## Project moved or was renamed

Run `rootbound connect .` from the new canonical root. Rootbound intentionally avoids treating stale paths as the same workspace without revalidation.

---

# Advanced / manual tunnel configuration

Most users should use:

```sh
rootbound connect .
```

Manual configuration is an operator/debug escape hatch:

```sh
rootbound tunnel configure --argv-json '["tunnel-client","run","--profile","my-profile"]'
rootbound tunnel show
rootbound tunnel clear
```

`ROOTBOUND_TUNNEL_ARGV_JSON` remains available as an advanced/environment-only override. Explicit saved connections take precedence so a stale global environment override cannot silently redirect a connection switch. Because this mode has no durable saved-connection identity, project allowlisting is intentionally not connection-scoped there.

Persistent manual tunnel configuration rejects detectable literal credentials.

---

# Non-interactive setup

```sh
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
CONTROL_PLANE_API_KEY=... \
rootbound connect . --yes
```

`--yes` records consent for the current Rootbound runtime permission contract. Use it only where that authority has already been intentionally approved.

Register/trust/grant without starting the runtime:

```sh
rootbound connect . --yes --no-start
```

---

# Development and release validation

```sh
npm ci
npm run test:v5
npm test
npm run validate:release
```

For the multi-project release, also run the real-Mac smoke test in [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md) before merge.

Probe the currently installed Codex build explicitly:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

The canonical public tool list lives in [`src/surface-contracts.mjs`](src/surface-contracts.mjs).

The detailed V5 acceptance plan lives in [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md).

---

## License

Apache-2.0.

Rootbound is an independent project. It is not an OpenAI product and does not imply OpenAI endorsement.

## Shoutout

Shoutout to [@liyana31811](https://github.com/liyana31811), creator of [Codexless](https://github.com/liyana31811/Codexless). Their work was an early source of inspiration while Rootbound was taking shape.

> **Keep working in ChatGPT. Use Codex when you explicitly need Codex.**
