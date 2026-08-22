import assert from "node:assert/strict";
import path from "node:path";
import { createConnectionScopedAuthorityExecutor, createConnectionScopedBrowserReader, createConnectionScopedPublicContext, resolveScopedCwd } from "../src/connection-scoped-runtime.mjs";

const a = { projectRef: "project_aaaaaaaaaaaaaaaaaaaa", root: path.resolve("/tmp/rootbound-scope-a"), name: "a", trusted: true };
const b = { projectRef: "project_bbbbbbbbbbbbbbbbbbbb", root: path.resolve("/tmp/rootbound-scope-b"), name: "b", trusted: true };
const store = { listProjects() { return [a, b]; } };
let refs = [a.projectRef, b.projectRef];
const provider = async () => ({ enforced: true, connectionId: "connection_test", projectRefs: refs });

await assert.rejects(() => resolveScopedCwd({ store, projectAccessProvider: provider }), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
assert.equal(await resolveScopedCwd({ cwd: path.join(a.root, "src"), store, projectAccessProvider: provider }), path.join(a.root, "src"));
await assert.rejects(() => resolveScopedCwd({ cwd: b.root, store, projectAccessProvider: async () => ({ enforced: true, projectRefs: [a.projectRef] }) }), (error) => error.code === "PROJECT_NOT_ALLOWED_FOR_CONNECTION");
assert.equal(await resolveScopedCwd({ cwd: null, store, projectAccessProvider: async () => ({ enforced: false, projectRefs: [] }) }), null);

const authorityCalls = [];
const authorityBase = {
  codexVersion: "test",
  defaultCwd: a.root,
  profileOverride: "rootbound",
  async validate() { return { ok: true }; },
  async resolveAuthority(input) { authorityCalls.push(["resolve", input.cwd]); return { effectiveCwd: input.cwd }; },
  async exec(input) { authorityCalls.push(["exec", input.cwd]); return { effectiveCwd: input.cwd, exitCode: 0 }; },
};
const authority = createConnectionScopedAuthorityExecutor({ base: authorityBase, store, projectAccessProvider: provider });
assert.throws(() => authority.defaultCwd, (error) => error.code === "PROJECT_SCOPE_REQUIRED");
await assert.rejects(() => authority.exec({ command: ["true"] }), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
refs = [a.projectRef];
assert.equal((await authority.resolveAuthority({ access: "readOnly" })).effectiveCwd, a.root);
refs = [a.projectRef, b.projectRef];
assert.equal((await authority.exec({ command: ["true"], cwd: b.root })).effectiveCwd, b.root);
assert.deepEqual(authorityCalls.map((row) => row[1]), [a.root, b.root]);

const authorityOneStore = { listProjects() { return [a]; } };
const oneAuthority = createConnectionScopedAuthorityExecutor({ base: authorityBase, store: authorityOneStore, projectAccessProvider: async () => ({ enforced: true, projectRefs: [a.projectRef] }) });
assert.equal(oneAuthority.defaultCwd, a.root);

const contextCalls = [];
const contextBase = {
  generation: 3,
  running: true,
  async projectContext(input) { contextCalls.push(["project", input.cwd]); return input; },
  async skillList(input) { contextCalls.push(["skills", input.cwd]); return input; },
  async skillRead(input) { contextCalls.push(["skill", input.cwd]); return input; },
  async threadList(input) { contextCalls.push(["threads", input.cwd ?? null, input.omitCwd === true]); return input; },
  async threadMetadata(input) { return input; }, async threadRead(input) { return input; }, async threadItems(input) { return input; }, async threadSearchOccurrences(input) { return input; },
  async quotaSnapshot() { return { status: "ok" }; }, async injectContinuity(input) { return input; },
  async browserPrerequisites(input) { contextCalls.push(["browser", input.cwd]); return input; },
  async nodeReplCall(input) { contextCalls.push(["repl", input.cwd]); return input; },
};
const context = createConnectionScopedPublicContext({ base: contextBase, store, projectAccessProvider: provider });
await assert.rejects(() => context.projectContext(), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
await context.projectContext({ cwd: a.root });
await context.threadList({ omitCwd: true, limit: 10 });
assert.deepEqual(contextCalls.slice(-2), [["project", a.root], ["threads", null, true]]);

const browserCalls = [];
const browser = createConnectionScopedBrowserReader({
  base: {
    async status(input) { browserCalls.push(input.cwd); return input; },
    async listTabs(input) { browserCalls.push(input.cwd); return input; },
    async readTab(input) { browserCalls.push(input.cwd); return input; },
  },
  store,
  projectAccessProvider: provider,
});
await assert.rejects(() => browser.status(), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
await browser.readTab({ tabRef: "x", cwd: b.root });
assert.deepEqual(browserCalls, [b.root]);

console.log("connection-scoped-runtime-v5: ok");
