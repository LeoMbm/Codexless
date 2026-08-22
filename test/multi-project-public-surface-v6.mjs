import assert from "node:assert/strict";
import path from "node:path";
import { createProjectScopeGuardedServer, createProjectToolScopeGuard, hasStrongProjectScope, requiresImplicitProjectScopeGuard } from "../src/project-tool-scope-guard.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";
import { listWorkspaces, registerWorkspaceTools } from "../src/workspace-tools.mjs";

assert.equal(PUBLIC_SERVER_VERSION, "0.1.0-preview.10");
assert.equal(PUBLIC_SURFACE_VERSION, "rootbound-public-preview-v6");
assert.equal(PUBLIC_TOOL_NAMES.length, 33);
assert.equal(new Set(PUBLIC_TOOL_NAMES).size, 33);
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.workspace_list"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.workspace_open"));
assert.equal(PUBLIC_TOOL_NAMES.some((name) => name.startsWith("codex.agent_")), false);

const a = { projectRef: "project_aaaaaaaaaaaaaaaaaaaa", root: path.resolve("/tmp/rootbound-a"), gitRoot: path.resolve("/tmp/rootbound-a"), name: "a", trusted: true };
const b = { projectRef: "project_bbbbbbbbbbbbbbbbbbbb", root: path.resolve("/tmp/rootbound-b"), gitRoot: path.resolve("/tmp/rootbound-b"), name: "b", trusted: true };
const store = {
  listProjects() { return [a, b]; },
  getProject(projectRef) { return [a, b].find((project) => project.projectRef === projectRef) ?? null; },
};
const projectAccessProvider = async () => ({ enforced: true, connectionId: "connection_test", projectRefs: [b.projectRef] });

const listed = await listWorkspaces({ store, projectAccessProvider });
assert.equal(listed.connectionScoped, true);
assert.equal(listed.connectionId, "connection_test");
assert.equal(listed.count, 1);
assert.equal(listed.workspaces[0].projectRef, b.projectRef);
assert.equal(listed.modelTurnStarted, false);

const registrations = new Map();
const server = {
  registerTool(name, definition, handler) { registrations.set(name, { definition, handler }); },
};
registerWorkspaceTools(server, {
  store,
  authorityExecutor: { async resolveAuthority() { throw new Error("not used"); } },
  publicContext: { async projectContext() { throw new Error("not used"); } },
  projectAccessProvider,
});
assert.deepEqual([...registrations.keys()], ["codex.workspace_list", "codex.workspace_open"]);
assert.equal(registrations.get("codex.workspace_list").definition.annotations.readOnlyHint, true);
assert.equal(registrations.get("codex.workspace_list").definition.annotations.idempotentHint, true);
assert.match(registrations.get("codex.workspace_list").definition.description, /current Rootbound connection/i);
assert.match(registrations.get("codex.workspace_open").definition.description, /fails closed/i);

assert.equal(hasStrongProjectScope({ cwd: b.root }), true);
assert.equal(hasStrongProjectScope({ bindingRef: "binding_00000000-0000-4000-8000-000000000000" }), true);
assert.equal(hasStrongProjectScope({ rescueRef: "rescue_00000000-0000-4000-8000-000000000000" }), true);
assert.equal(hasStrongProjectScope({}), false);
assert.equal(requiresImplicitProjectScopeGuard("codex.git_status", {}), true);
assert.equal(requiresImplicitProjectScopeGuard("codex.command_start", {}), true);
assert.equal(requiresImplicitProjectScopeGuard("codex.precise_edit", {}), true);
assert.equal(requiresImplicitProjectScopeGuard("codex.command_poll", {}), false, "opaque commandId tools must not require a new project selector");
assert.equal(requiresImplicitProjectScopeGuard("codex.git_status", { cwd: b.root }), false);
assert.equal(requiresImplicitProjectScopeGuard("codex.git_status", { rescueRef: "rescue_00000000-0000-4000-8000-000000000000" }), false);

let scopeChecks = 0;
const scopeError = Object.assign(new Error("Multiple Rootbound workspaces are available; an explicit project scope is required."), {
  code: "PROJECT_SCOPE_REQUIRED",
  category: "state",
  retryable: false,
  nextActions: ["Call codex.workspace_list, then retry with projectRef or an absolute cwd."],
  details: { candidates: [a, b].map((project) => ({ projectRef: project.projectRef, name: project.name })) },
});
const guardProjectToolScope = createProjectToolScopeGuard({
  authorityExecutor: {
    async resolveAuthority(input) {
      scopeChecks += 1;
      assert.equal(input.cwd, null);
      assert.equal(input.access, "readOnly");
      throw scopeError;
    },
  },
});
await assert.rejects(() => guardProjectToolScope("codex.git_status", {}), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
assert.equal(scopeChecks, 1);
await guardProjectToolScope("codex.git_status", { cwd: b.root });
await guardProjectToolScope("codex.apply_patch", { rescueRef: "rescue_00000000-0000-4000-8000-000000000000" });
await guardProjectToolScope("codex.command_poll", {});
assert.equal(scopeChecks, 1, "explicit strong scopes and opaque-id tools must bypass the pre-rescue guard");

const guardedRegistrations = new Map();
const guardedServer = createProjectScopeGuardedServer({
  registerTool(name, definition, handler) { guardedRegistrations.set(name, { definition, handler }); },
}, { guardProjectToolScope });
let handlerCalls = 0;
guardedServer.registerTool("codex.git_status", {}, async () => { handlerCalls += 1; return { status: "ok" }; });
const blocked = await guardedRegistrations.get("codex.git_status").handler({}, {});
assert.equal(blocked.isError, true);
assert.equal(blocked.structuredContent?.errorCode, "PROJECT_SCOPE_REQUIRED");
assert.equal(blocked.structuredContent?.operation, "git_status");
assert.equal(blocked.structuredContent?.details?.candidates?.length, 2);
assert.equal(handlerCalls, 0, "project handler must not run before unscoped multi-project requests fail closed");

const singleProjectGuard = createProjectToolScopeGuard({
  authorityExecutor: {
    async resolveAuthority() { return { effectiveCwd: b.root }; },
  },
});
const singleRegistrations = new Map();
const singleServer = createProjectScopeGuardedServer({
  registerTool(name, definition, handler) { singleRegistrations.set(name, { definition, handler }); },
}, { guardProjectToolScope: singleProjectGuard });
let singleHandlerCalls = 0;
singleServer.registerTool("codex.git_status", {}, async () => { singleHandlerCalls += 1; return { status: "ok" }; });
assert.deepEqual(await singleRegistrations.get("codex.git_status").handler({}, {}), { status: "ok" });
assert.equal(singleHandlerCalls, 1, "single-project fallback must preserve existing implicit rescue/tool behavior");

console.log("multi-project-public-surface-v6: ok");
