import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getActiveConnection, getConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { ensureRootboundStateDirs, resolveRootboundPaths } from "../src/state-paths.mjs";
import { clearRuntimeState, writeRuntimeState } from "../src/runtime-state.mjs";
import { resolveTunnelLaunch } from "../src/tunnel-config.mjs";
import { managedTunnelEnvironment } from "../src/tunnel-bootstrap.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = await ensureRootboundStateDirs(resolveRootboundPaths());
const projectRoot = process.env.ROOTBOUND_PROJECT_ROOT || null;
const projectRef = process.env.ROOTBOUND_PROJECT_REF || null;
const registry = await loadConnectionRegistry({ paths });
const requestedConnection = process.env.ROOTBOUND_CONNECTION_ID ? getConnection(registry, process.env.ROOTBOUND_CONNECTION_ID) : null;
const persistentConnection = requestedConnection ?? getActiveConnection(registry);
const connection = persistentConnection ?? (process.env.ROOTBOUND_TUNNEL_ARGV_JSON ? {
  id: "connection_environment",
  name: "environment",
  storageKind: "legacy-global",
  source: "environment",
  tunnelId: null,
} : null);
if (!connection) throw new Error("No active Rootbound connection; run `rootbound connect .` first.");
const environmentOnlyConnection = connection.source === "environment" && !persistentConnection;
const connectionPaths = environmentOnlyConnection ? paths : resolveConnectionPaths({ paths, connection });
const runtimeId = `runtime_${randomUUID()}`;
const restartLimit = parseBoundedInt(process.env.ROOTBOUND_TUNNEL_RESTART_LIMIT ?? "3", 0, 20, "ROOTBOUND_TUNNEL_RESTART_LIMIT");
const launchEnv = requestedConnection ? explicitConnectionEnvironment(process.env) : process.env;
const launch = resolveTunnelLaunch({ env: launchEnv, packageRoot, projectRoot, paths: connectionPaths });
const childBaseEnv = connection.storageKind === "scoped-v1" ? managedTunnelEnvironment(launchEnv) : launchEnv;
const logHandle = await open(paths.logPath, "a", 0o600);
let child = null;
let stopping = false;
let restarts = 0;

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
log(`supervisor start pid=${process.pid} anchorProject=${projectRef ?? "none"} connection=${connection.id} tunnel=${connection.tunnelId ?? "unknown"} tunnelSource=${launch.source ?? "unknown"}`);
await startChild();

async function startChild() {
  const startedAt = Date.now();
  if (connectionPaths.tunnelHealthUrlPath) await unlink(connectionPaths.tunnelHealthUrlPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  child = spawn(launch.command, launch.args, {
    cwd: projectRoot ?? packageRoot,
    env: {
      ...childBaseEnv,
      ROOTBOUND_STDIO_NODE: process.execPath,
      ROOTBOUND_STDIO_SCRIPT: path.join(packageRoot, "scripts", "launch.mjs"),
      ROOTBOUND_CONNECTION_ID: connection.id,
    },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    windowsHide: true,
    shell: false,
  });
  child.once("error", (error) => log(`tunnel spawn error: ${error.message}`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 250);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`tunnel exited during startup: code=${code} signal=${signal}`)); });
  });

  const requiresReadiness = connection.storageKind === "scoped-v1";
  if (!requiresReadiness) await writeRuntimeState(paths, runtimeValue({ status: "starting", ready: false, startedAt }));
  const readiness = await waitForTunnelReadiness({ healthUrlPath: connectionPaths.tunnelHealthUrlPath, timeoutMs: requiresReadiness ? 4_000 : 10_000 });
  if (!readiness.ok && requiresReadiness) {
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(`Tunnel did not become ready: ${readiness.error}`);
  }
  const readyAt = readiness.ok ? Date.now() : null;
  await writeRuntimeState(paths, runtimeValue({ status: readiness.ok ? "ready" : "running", ready: readiness.ok, startedAt, readyAt, legacyReadinessFallback: !readiness.ok }));
  log(`tunnel ${readiness.ok ? "ready" : "running (legacy readiness fallback)"} pid=${child.pid}`);
  child.once("exit", (code, signal) => void onChildExit(code, signal));
}

function runtimeValue({ status, ready, startedAt, readyAt = null, legacyReadinessFallback = false }) {
  return {
    schemaVersion: 2,
    status,
    ready,
    runtimeId,
    supervisorPid: process.pid,
    pid: process.pid,
    tunnelPid: child?.pid ?? null,
    startedAt,
    readyAt,
    scopeMode: "multi-project",
    anchorProjectRef: projectRef,
    anchorProjectRoot: projectRoot,
    projectRef,
    projectRoot,
    connectionId: connection.id,
    connectionName: connection.name,
    tunnelId: connection.tunnelId ?? null,
    transport: "secure-mcp-tunnel",
    tunnelSource: launch.source ?? null,
    legacyReadinessFallback,
  };
}

async function waitForTunnelReadiness({ healthUrlPath, timeoutMs }) {
  if (!healthUrlPath) return { ok: false, error: "health URL path unavailable" };
  const deadline = Date.now() + timeoutMs;
  let lastError = "health URL not published";
  while (Date.now() < deadline) {
    if (stopping) return { ok: false, error: "supervisor is stopping" };
    if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: false, error: "tunnel exited before readiness" };
    try {
      const base = (await readFile(healthUrlPath, "utf8")).trim().replace(/\/$/, "");
      if (base) {
        const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return { ok: true, url: base };
        lastError = `/readyz returned HTTP ${response.status}`;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false, error: lastError };
}

async function onChildExit(code, signal) {
  log(`tunnel exit code=${code} signal=${signal}`);
  child = null;
  if (stopping) return;
  await writeRuntimeState(paths, runtimeValue({ status: "recovering", ready: false, startedAt: Date.now() })).catch(() => {});
  if (restarts >= restartLimit) {
    log(`restart limit reached (${restartLimit}); supervisor stopping`);
    await clearRuntimeState(paths).catch(() => {});
    await logHandle.close().catch(() => {});
    process.exitCode = 1;
    return;
  }
  restarts += 1;
  const delay = Math.min(1000 * (2 ** (restarts - 1)), 8000);
  log(`restart ${restarts}/${restartLimit} in ${delay}ms`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  try { await startChild(); }
  catch (error) {
    log(`restart failed: ${error instanceof Error ? error.message : String(error)}`);
    await onChildExit(null, "restart-failed");
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`supervisor shutdown ${signal}`);
  const current = child;
  if (current && current.exitCode === null && current.signalCode === null) {
    try { current.kill("SIGTERM"); } catch {}
    await Promise.race([new Promise((resolve) => current.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (current.exitCode === null && current.signalCode === null) { try { current.kill("SIGKILL"); } catch {} }
  }
  if (connectionPaths.tunnelHealthUrlPath) await unlink(connectionPaths.tunnelHealthUrlPath).catch(() => {});
  await clearRuntimeState(paths).catch(() => {});
  await logHandle.close().catch(() => {});
  process.exit(0);
}

function explicitConnectionEnvironment(env) { const clean = { ...env }; delete clean.ROOTBOUND_TUNNEL_ARGV_JSON; return clean; }
function log(message) { logHandle.write(`${new Date().toISOString()} [${runtimeId}] ${message}\n`); }
function parseBoundedInt(value, min, max, label) { const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || String(parsed) !== String(value) || parsed < min || parsed > max) throw new Error(`${label} must be an integer between ${min} and ${max}`); return parsed; }
