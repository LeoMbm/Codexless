import assert from "node:assert/strict";
import path from "node:path";
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

console.log("multi-project-public-surface-v6: ok");
