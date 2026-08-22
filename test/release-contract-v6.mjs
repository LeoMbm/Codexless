import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const shrinkwrap = JSON.parse(await readFile(path.join(root, "npm-shrinkwrap.json"), "utf8"));
const readme = await readFile(path.join(root, "README.md"), "utf8");
const readmeZh = await readFile(path.join(root, "README.zh-CN.md"), "utf8");
const security = await readFile(path.join(root, "SECURITY.md"), "utf8");
const multiProjectDoc = await readFile(path.join(root, "docs", "multi-project-runtime.md"), "utf8");
const workspaceTools = await readFile(path.join(root, "src", "workspace-tools.mjs"), "utf8");
const scopedRuntime = await readFile(path.join(root, "src", "connection-scoped-runtime.mjs"), "utf8");
const runtimeLifecycle = await readFile(path.join(root, "src", "runtime-project-lifecycle.mjs"), "utf8");
const publicServerFactory = await readFile(path.join(root, "src", "public-server-factory.mjs"), "utf8");
const rescueTools = await readFile(path.join(root, "src", "rescue-tools.mjs"), "utf8");
const controlPlane = await readFile(path.join(root, "bin", "rootbound.mjs"), "utf8");
const supervisor = await readFile(path.join(root, "scripts", "supervisor.mjs"), "utf8");
const commandWorker = await readFile(path.join(root, "scripts", "command-worker.mjs"), "utf8");

assert.equal(packageJson.version, "0.1.0-preview.3");
assert.equal(shrinkwrap.version, packageJson.version);
assert.equal(shrinkwrap.packages?.[""]?.version, packageJson.version);
assert.equal(PUBLIC_SERVER_VERSION, "0.1.0-preview.10");
assert.equal(PUBLIC_SURFACE_VERSION, "rootbound-public-preview-v6");
assert.equal(PUBLIC_TOOL_NAMES.length, 33);
assert.equal(new Set(PUBLIC_TOOL_NAMES).size, 33);
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.workspace_list"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.workspace_open"));
assert.equal(PUBLIC_TOOL_NAMES.some((name) => name.startsWith("codex.agent_")), false);

for (const relative of [
  "src/project-scope.mjs",
  "src/connection-project-access.mjs",
  "src/runtime-project-lifecycle.mjs",
  "src/connection-scoped-runtime.mjs",
  "docs/multi-project-runtime.md",
  "test/project-scope-v5.mjs",
  "test/connection-project-access-v5.mjs",
  "test/workspace-multiproject-v5.mjs",
  "test/runtime-project-lifecycle-v5.mjs",
  "test/connection-scoped-runtime-v5.mjs",
  "test/multi-project-public-surface-v6.mjs",
]) await access(path.join(root, relative));

for (const testName of [
  "project-scope-v5.mjs",
  "connection-project-access-v5.mjs",
  "workspace-multiproject-v5.mjs",
  "runtime-project-lifecycle-v5.mjs",
  "connection-scoped-runtime-v5.mjs",
  "multi-project-public-surface-v6.mjs",
  "release-contract-v6.mjs",
]) {
  assert.match(packageJson.scripts?.["test:v5"] ?? "", new RegExp(testName.replaceAll(".", "\\.")), `test:v5 must include ${testName}`);
  assert.match(packageJson.scripts?.test ?? "", new RegExp(testName.replaceAll(".", "\\.")), `npm test must include ${testName}`);
}
assert.doesNotMatch(packageJson.scripts?.["test:v5"] ?? "", /release-contract-v5\.mjs/);
assert.doesNotMatch(packageJson.scripts?.test ?? "", /release-contract-v5\.mjs/);
assert.ok(packageJson.files?.includes("docs/multi-project-runtime.md"));

assert.match(workspaceTools, /codex\.workspace_list/);
assert.match(workspaceTools, /PROJECT_SCOPE_REQUIRED|resolveProjectScope/);
assert.match(scopedRuntime, /resolveScopedCwd/);
assert.match(scopedRuntime, /PROJECT_SCOPE_REQUIRED|resolveProjectScope/);
assert.match(runtimeLifecycle, /revokeProjectFromSavedConnections/);
assert.match(controlPlane, /revokeProjectFromSavedConnections/);
assert.match(controlPlane, /projectAccessCleanup/);
assert.match(supervisor, /assertRuntimeProjectAllowed/);
assert.match(supervisor, /anchorProjectRef/);
assert.match(commandWorker, /createRuntimeProjectAccessProvider/);
assert.match(commandWorker, /resolveScopedCwd/);

assert.match(publicServerFactory, /codex\.workspace_list first/);
assert.match(publicServerFactory, /Never treat the runtime anchor/);
assert.match(publicServerFactory, /PROJECT_SCOPE_REQUIRED/);
assert.match(rescueTools, /authorityExecutor\.resolveAuthority\(\{ cwd: cwd \?\? null/);
assert.doesNotMatch(rescueTools, /cwd \?\? authorityExecutor\.defaultCwd/);
assert.match(rescueTools, /authority\.effectiveCwd/);

assert.match(readme, /Current preview: \*\*0\.1\.0-preview\.3\*\*/);
assert.match(readme, /rootbound-public-preview-v6/);
assert.match(readme, /33 public tools/);
assert.match(readme, /codex\.workspace_list/);
assert.match(readme, /PROJECT_SCOPE_REQUIRED/);
assert.doesNotMatch(readme, /one supervised active project runtime at a time/i);
assert.match(readmeZh, /rootbound-public-preview-v6/);
assert.match(readmeZh, /33/);
assert.match(security, /connection-scoped/i);
assert.match(security, /PROJECT_SCOPE_REQUIRED/);
assert.match(security, /runtime anchor/i);

assert.match(multiProjectDoc, /one supervised runtime/i);
assert.match(multiProjectDoc, /connection-scoped project allowlist/i);
assert.match(multiProjectDoc, /PROJECT_SCOPE_REQUIRED/);
assert.match(multiProjectDoc, /runtime anchor/i);
assert.match(multiProjectDoc, /same runtime id \/ pid/i);

console.log("release-contract-v6: ok");
