import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeProjectAccessProvider, listWorkspaces, openWorkspace } from "../src/workspace-tools.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-workspace-multi-"));
const aRoot = path.join(temp, "a");
const bRoot = path.join(temp, "b");
await mkdir(aRoot);
await mkdir(bRoot);
const aCanonical = await realpath(aRoot);
const bCanonical = await realpath(bRoot);
const a = { projectRef: "project_aaaaaaaaaaaaaaaaaaaa", root: aCanonical, gitRoot: aCanonical, name: "same", trusted: true };
const b = { projectRef: "project_bbbbbbbbbbbbbbbbbbbb", root: bCanonical, gitRoot: bCanonical, name: "same", trusted: true };
const rows = new Map([[a.projectRef, a], [b.projectRef, b]]);
const byRoot = new Map([[aCanonical, a], [bCanonical, b]]);
const events = [];
const store = {
  listProjects() { return [...rows.values()]; },
  getProject(projectRef) { return rows.get(projectRef) ?? null; },
  getProjectByRoot(root) { return byRoot.get(path.resolve(root)) ?? null; },
  upsertProject(project) { rows.set(project.projectRef, project); byRoot.set(path.resolve(project.root), project); return project; },
  recordEvent(event) { events.push(event); return event; },
};
const accessBoth = async () => ({ enforced: true, connectionId: "connection_test", projectRefs: [a.projectRef, b.projectRef] });
const listed = await listWorkspaces({ store, projectAccessProvider: accessBoth });
assert.equal(listed.count, 2);
assert.equal(listed.connectionScoped, true);
assert.equal(listed.workspaces.every((workspace) => workspace.available), true);
assert.equal(listed.workspaces[0].name, listed.workspaces[1].name, "duplicate display names must remain valid");

await assert.rejects(
  () => openWorkspace({ store, authorityExecutor: {}, publicContext: {}, projectAccessProvider: accessBoth }),
  (error) => error.code === "PROJECT_SCOPE_REQUIRED"
);

let authorityCwd = null;
const opened = await openWorkspace({
  projectRef: b.projectRef,
  store,
  projectAccessProvider: accessBoth,
  authorityExecutor: {
    async resolveAuthority({ cwd }) {
      authorityCwd = cwd;
      return { permissionProfile: ":read-only", permissionCeiling: ":workspace", authoritySource: "test", trustedAncestor: cwd };
    },
  },
  publicContext: { async projectContext({ cwd }) { return { cwd }; } },
});
assert.equal(opened.status, "ready");
assert.equal(opened.project.projectRef, b.projectRef);
assert.equal(authorityCwd, bCanonical);
assert.equal(events.length, 1);
assert.equal(events[0].projectRef, b.projectRef);
assert.equal(events[0].kind, "project.connected");

const onlyA = async () => ({ enforced: true, connectionId: "connection_test", projectRefs: [a.projectRef] });
await assert.rejects(
  () => openWorkspace({ projectRef: b.projectRef, store, authorityExecutor: {}, publicContext: {}, projectAccessProvider: onlyA }),
  (error) => error.code === "PROJECT_NOT_ALLOWED_FOR_CONNECTION"
);

const environmentProvider = createRuntimeProjectAccessProvider({
  store,
  env: { ROOTBOUND_CONNECTION_ID: "connection_environment" },
  paths: {},
});
const environmentAccess = await environmentProvider();
assert.equal(environmentAccess.enforced, false);
assert.equal(environmentAccess.connectionId, "connection_environment");
assert.deepEqual(environmentAccess.projectRefs.sort(), [a.projectRef, b.projectRef].sort());

console.log("workspace-multiproject-v5: ok");
