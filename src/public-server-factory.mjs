import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { registerBrowserReaderTools } from "./browser-reader-tools.mjs";
import { registerCommandTools } from "./command-tools.mjs";
import { registerConstructionTools } from "./construction-tools.mjs";
import { registerPublicContextTools } from "./public-context-tools.mjs";
import { createProjectScopeGuardedServer, createProjectToolScopeGuard } from "./project-tool-scope-guard.mjs";
import { registerRepoTools } from "./repo-tools.mjs";
import { registerRescueTools } from "./rescue-tools.mjs";
import { summarizeRedactedArgv } from "./secret-boundaries.mjs";
import { registerThreadHistoryTools } from "./thread-history-tools.mjs";
import { typedToolResponse } from "./tool-errors.mjs";
import { registerWorkspaceTools } from "./workspace-tools.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "./surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();
const rescueRefSchema = z.string().regex(/^rescue_[0-9a-f-]{36}$/i).optional();

export function createPublicServerFactory({ executor, authorityExecutor, publicContext, browserReader, continuityState, rescueManager, rescueAutopilot = null, commandManager, stateStore, maxConcurrent = 1 }) {
  if (!executor) throw new Error("Rootbound public server requires an authority executor");
  if (!authorityExecutor) throw new Error("Rootbound public server requires authorityExecutor");
  if (!publicContext) throw new Error("Rootbound public server requires publicContext");
  if (!browserReader) throw new Error("Rootbound public server requires browserReader");
  if (!continuityState) throw new Error("Rootbound public server requires continuityState");
  if (!rescueManager) throw new Error("Rootbound public server requires rescueManager");
  if (!commandManager) throw new Error("Rootbound public server requires commandManager");
  if (!stateStore) throw new Error("Rootbound public server requires stateStore");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new Error("maxConcurrent must be an integer between 1 and 4");

  const commandSchema = z.object({
    command: z.array(z.string().max(32_768)).min(1).max(128).describe("argv vector passed to official Codex command/exec under the locally resolved Codex permission profile"),
    cwd: z.string().min(1).max(32_768).optional().describe("Optional local working-directory context. cwd does not let the caller select or widen a permission profile."),
    access: z.enum(["inherit", "readOnly"]).default("readOnly").describe("readOnly is the safe compatibility default. inherit uses the locally authorized/resolved Codex permission profile."),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    rescueRef: rescueRefSchema.describe("Optional Rootbound rescue session returned by codex.continuity_resume. ChatGPT should propagate this opaque ref silently when transport-scoped implicit rescue state is unavailable."),
    bindingRef: bindingRefSchema.describe("Optional opaque continuity binding. When supplied, Rootbound scopes execution to the bound project and journals redacted command metadata for the next continuity checkpoint."),
  }).strict();

  return function createServer(requestContext = {}) {
    let inFlight = 0;
    const connectionFallbackKey = requestContext?.requestInfo ? null : `mcp-connection:${randomUUID()}`;
    const getSessionKey = (ctx) => requestContext?.requestInfo
      ? null
      : typeof ctx?.sessionId === "string" && ctx.sessionId.trim()
        ? `mcp:${ctx.sessionId}`
        : connectionFallbackKey;
    const server = new McpServer(
      { name: "rootbound", title: "Rootbound Local", version: PUBLIC_SERVER_VERSION, description: "ChatGPT-only local coding bridge built on verified model-free Codex App Server primitives." },
      { instructions: "Rootbound Local is a ChatGPT-only, model-free coding surface. ChatGPT itself must reason, plan, inspect, edit, run tests, interpret failures, and decide next steps. This server exposes no Codex model, model catalog, agent delegation, Task Card, or turn/start tool. Rootbound may expose multiple local project workspaces through one runtime. When the intended project is not already explicit from a cwd, bindingRef, rescueRef, or prior workspace result, call codex.workspace_list first and choose only from the returned connection-scoped workspaces. Open the intended project with codex.workspace_open and silently propagate its canonical cwd/project scope on subsequent project operations. Never treat the runtime anchor, most recently used project, or a display name as implicit authority; if Rootbound reports PROJECT_SCOPE_REQUIRED, resolve the intended workspace rather than retrying unscoped. When the user says continue, resume, pick up where Codex stopped, or mentions Codex quota/interruption, call codex.continuity_resume first; do not ask for a thread id unless Rootbound reports genuine ambiguity. continuity_resume may reattach an existing durable rescue from another ChatGPT conversation or consume a pre-armed quota rescue candidate after revalidating the current worktree. Keep the rescueRef returned by continuity_resume in tool state and silently pass it to supported project tools and continuity_handoff/rollback/search whenever present. Never ask the user to copy a rescueRef or bindingRef. A local stdio MCP connection may additionally provide implicit rescue scoping; remote HTTP does not assume that a transport session equals one ChatGPT conversation. Use codex.continuity_handoff to return verified work plus a hashed Rootbound continuity manifest to the original Codex thread, codex.continuity_rollback for guarded rescue-only rollback, codex.continuity_search for cold-memory lookup, and codex.quota_status for advisory quota state. Prefer repo_search/read_many/git_status/git_diff for inspection, apply_patch or precise_edit for edits, command_exec for short buffered tests/builds, and command_start plus command_poll for long-running work. Never attempt to launch Codex CLI through command tools; nested Codex launches are refused. No public tool starts a Codex model turn." }
    );
    const guardProjectToolScope = createProjectToolScopeGuard({ authorityExecutor });
    const projectScopeGuardedServer = createProjectScopeGuardedServer(server, { guardProjectToolScope });

    server.registerTool(
      "codex.command_exec",
      {
        title: "Run Authorized Project Command",
        description: "Run one buffered argv command through official Codex App Server command/exec without starting a Codex model turn. ChatGPT remains the reasoning model. Nested Codex CLI launches and wrappers carrying Codex commands are refused. If bindingRef is supplied, execution is scoped to the bound project and only redacted command metadata is journaled for the next continuity checkpoint.",
        inputSchema: commandSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ command, cwd, access, timeoutMs, rescueRef, bindingRef }, ctx) => typedToolResponse(async () => {
        if (inFlight >= maxConcurrent) {
          const error = new Error(`bridge concurrency limit reached (${maxConcurrent})`);
          error.code = "BRIDGE_CONCURRENCY_LIMIT";
          error.category = "transient";
          error.retryable = true;
          error.nextActions = ["Retry after the active command finishes or use command_start for long-running work."];
          throw error;
        }
        inFlight += 1;
        try {
          await guardProjectToolScope("codex.command_exec", { cwd, bindingRef, rescueRef });
          const resolved = rescueManager.resolveBinding({ sessionKey: getSessionKey(ctx), cwd, explicitBindingRef: bindingRef, rescueRef });
          const effectiveBindingRef = resolved.bindingRef;
          if (resolved.rescue && access === "inherit") await rescueManager.assertNoDrift(resolved.rescue);
          const scoped = effectiveBindingRef ? continuityState.assertCwd(effectiveBindingRef, cwd) : null;
          const result = await executor.exec({ command, cwd: scoped?.targetCwd ?? cwd, access, timeoutMs });
          if (effectiveBindingRef) continuityState.record(effectiveBindingRef, { kind: "command", label: summarizeRedactedArgv(command), cwd: result.effectiveCwd, status: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode });
          let updatedRescue = resolved.rescue;
          if (resolved.rescue && access === "inherit") {
            updatedRescue = await rescueManager.refreshExpected(resolved.rescue, { rollbackSafe: false, reason: "command_exec_write_capable" });
          }
          const payload = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, access, surfaceVersion: PUBLIC_SURFACE_VERSION, modelTurnStarted: false };
          if (typeof result.stdoutTruncated === "boolean") payload.stdoutTruncated = result.stdoutTruncated;
          if (typeof result.stderrTruncated === "boolean") payload.stderrTruncated = result.stderrTruncated;
          if (typeof result.permissionCeiling === "string") payload.permissionCeiling = result.permissionCeiling;
          if (typeof result.permissionProfile === "string") payload.permissionProfile = result.permissionProfile;
          if (typeof result.effectiveCwd === "string") payload.cwd = result.effectiveCwd;
          if (typeof result.authoritySource === "string") payload.authoritySource = result.authoritySource;
          if (typeof result.trustedAncestor === "string") payload.trustedAncestor = result.trustedAncestor;
          if (effectiveBindingRef) payload.continuityJournaled = true;
          if (resolved.implicit) payload.rescueSession = rescueManager.publicSession(updatedRescue ?? resolved.rescue);
          return payload;
        } finally { inFlight -= 1; }
      }, { operation: "command_exec", isError: (payload) => payload?.exitCode !== 0 })
    );

    registerWorkspaceTools(server, { store: stateStore, authorityExecutor, publicContext });
    registerCommandTools(projectScopeGuardedServer, { commandManager, continuityState, rescueManager, getSessionKey });
    registerPublicContextTools(server, publicContext);
    registerThreadHistoryTools(server, { context: publicContext, authorityExecutor, continuityState, stateStore });
    registerRescueTools(server, { context: publicContext, authorityExecutor, continuityState, stateStore, rescueManager, rescueAutopilot, getSessionKey });
    registerConstructionTools(projectScopeGuardedServer, { authorityExecutor, continuityState, stateStore, rescueManager, getSessionKey });
    registerRepoTools(projectScopeGuardedServer, { authorityExecutor, continuityState, rescueManager, getSessionKey });
    registerBrowserReaderTools(server, browserReader);
    return server;
  };
}
