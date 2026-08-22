import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addConnection } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { grantConnectionProjectAccess } from "../src/connection-project-access.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { registerProject } from "../src/project-registry.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const repoRoot = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-public-multiproject-scope-"));
const stateHome = path.join(temp, "state");
const codexHome = path.join(temp, "codex");
const aRoot = path.join(temp, "workspace-a");
const bRoot = path.join(temp, "workspace-b");
await mkdir(aRoot, { recursive: true });
await mkdir(bRoot, { recursive: true });
await mkdir(codexHome, { recursive: true });

const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: stateHome } });
const store = await openStateStore({ paths });
let a;
let b;
try {
  a = await registerProject(store, aRoot, { trusted: true });
  b = await registerProject(store, bRoot, { trusted: true });
} finally {
  store.close();
}

const added = await addConnection({
  paths,
  name: "scope-test",
  storageKind: "scoped-v1",
  source: "guided",
  makeActive: true,
});
const connection = added.connection;
const connectionPaths = resolveConnectionPaths({ paths, connection });
await grantConnectionProjectAccess({ paths: connectionPaths, projectRef: a.projectRef });
await grantConnectionProjectAccess({ paths: connectionPaths, projectRef: b.projectRef });

const codexBin = (await resolveCodexExecutable({ acceptedVersions: null })).path;
const trustedRoots = [repoRoot, a.root, b.root];
const codexConfig = trustedRoots
  .map((root) => `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`)
  .join("\n");
await writeFile(path.join(codexHome, "config.toml"), codexConfig, { mode: 0o600 });

function isolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("ROOTBOUND_")) delete env[key];
  }
  return {
    ...env,
    CODEX_BIN: codexBin,
    CODEX_HOME: codexHome,
    ROOTBOUND_HOME: stateHome,
    ROOTBOUND_CONNECTION_ID: connection.id,
    ROOTBOUND_DEFAULT_CWD: repoRoot,
    NODE_NO_WARNINGS: "1",
  };
}

const client = new Client({ name: "rootbound-public-multiproject-scope", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "src", "mcp-stdio.mjs")],
  cwd: repoRoot,
  env: isolatedEnv(),
  stderr: "pipe",
});
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[rootbound] ${chunk}`));

try {
  await client.connect(transport);

  const listed = await client.callTool({ name: "codex.workspace_list", arguments: {} });
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent?.count, 2);
  assert.deepEqual(
    listed.structuredContent?.workspaces?.map((workspace) => workspace.projectRef).sort(),
    [a.projectRef, b.projectRef].sort(),
  );

  const unscopedStatus = await client.callTool({ name: "codex.git_status", arguments: {} });
  assert.equal(unscopedStatus.isError, true, "git_status without cwd must fail closed when multiple workspaces are allowed");
  assert.equal(unscopedStatus.structuredContent?.errorCode, "PROJECT_SCOPE_REQUIRED");
  assert.equal(unscopedStatus.structuredContent?.operation, "git_status");
  assert.equal(unscopedStatus.structuredContent?.details?.candidates?.length, 2);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}

console.log("public-multiproject-scope-v6: ok");
