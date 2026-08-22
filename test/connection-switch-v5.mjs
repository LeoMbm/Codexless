import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { grantConnectionProjectAccess } from "../src/connection-project-access.mjs";
import { addConnection, getActiveConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { registerProject } from "../src/project-registry.mjs";
import { runtimeStatus, stopRuntime } from "../src/runtime-state.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";
import { saveTunnelConfig } from "../src/tunnel-config.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "scripts", "connection-cli.mjs");
const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-connection-switch-"));
const home = path.join(root, "state");
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: home } });
const fakeTunnel = path.join(root, "fake-tunnel.mjs");
await writeFile(fakeTunnel, `
import http from "node:http";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const mode = process.argv[2] || "ready";
const home = process.env.ROOTBOUND_HOME;
const id = process.env.ROOTBOUND_CONNECTION_ID;
const server = http.createServer((req, res) => {
  if (req.url === "/readyz") { res.statusCode = mode === "ready" ? 200 : 503; res.end(mode); return; }
  if (req.url === "/healthz") { res.statusCode = 200; res.end("alive"); return; }
  res.statusCode = 404; res.end();
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const runtime = path.join(home, "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, \`tunnel-health-\${id}.url\`), \`http://127.0.0.1:\${address.port}\\n\`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`, "utf8");

const a = await addConnection({ paths, name: "alpha", tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeActive: true });
const b = await addConnection({ paths, name: "beta", tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
const c = await addConnection({ paths, name: "gamma", tunnelId: "tunnel_cccccccccccccccccccccccccccccccc" });
await configure(a.connection, "ready");
await configure(b.connection, "ready");
await configure(c.connection, "fail");

const store = await openStateStore({ paths });
let project;
try {
  project = await registerProject(store, root, { trusted: true });
} finally { store.close(); }
for (const { connection } of [a, b, c]) {
  await grantConnectionProjectAccess({
    paths: resolveConnectionPaths({ paths, connection }),
    projectRef: project.projectRef,
  });
}

const initial = spawn(process.execPath, [path.join(repoRoot, "scripts", "supervisor.mjs")], {
  cwd: repoRoot,
  env: { ...process.env, ROOTBOUND_HOME: home, ROOTBOUND_PROJECT_REF: project.projectRef, ROOTBOUND_PROJECT_ROOT: project.root, ROOTBOUND_CONNECTION_ID: a.connection.id, ROOTBOUND_TUNNEL_RESTART_LIMIT: "0" },
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
initial.unref();
await waitForRuntime(a.connection.id, 6000);

try {
  const switched = JSON.parse((await runCli(["switch", "beta", "--json"])).stdout);
  assert.equal(switched.ok, true);
  assert.equal(switched.connection.id, b.connection.id);
  assert.equal(switched.runtime.state.connectionId, b.connection.id);
  assert.equal(switched.runtime.state.ready, true);
  let registry = await loadConnectionRegistry({ paths });
  assert.equal(getActiveConnection(registry)?.id, b.connection.id);

  const failed = await runCli(["switch", "gamma", "--json"], { expectedExitCode: 1 });
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.errorCode, "CONNECTION_SWITCH_FAILED_RESTORED");
  registry = await loadConnectionRegistry({ paths });
  assert.equal(getActiveConnection(registry)?.id, b.connection.id, "failed switch must keep previous active connection");
  const restored = await waitForRuntime(b.connection.id, 6000);
  assert.equal(restored.state.ready, true);
} finally {
  await stopRuntime(paths, { force: true }).catch(() => {});
}

console.log("connection-switch-v5: ok");

async function configure(connection, mode) {
  const connectionPaths = resolveConnectionPaths({ paths, connection });
  await saveTunnelConfig({ argv: [process.execPath, fakeTunnel, mode], paths: connectionPaths });
}

async function waitForRuntime(connectionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await runtimeStatus(paths);
    if (status.running && status.state?.connectionId === connectionId && status.state?.ready === true) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime ${connectionId} did not become ready within ${timeoutMs}ms`);
}

async function runCli(args, { expectedExitCode = 0 } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ROOTBOUND_HOME: home, NODE_NO_WARNINGS: "1" },
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (expectedExitCode !== 0) assert.fail(`Expected connection CLI to exit ${expectedExitCode}, but it exited 0`);
    return { ...result, exitCode: 0 };
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? error.code : null;
    if (exitCode !== expectedExitCode) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode };
  }
}
