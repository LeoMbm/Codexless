import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isProcessAlive, readRuntimeState, runtimeStatus, stopRuntime, tailLog, writeRuntimeState } from "../src/runtime-state.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-runtime-state-"));
const runtimeDir = path.join(root, "runtime");
await mkdir(runtimeDir);
const paths = { runtimeStatePath: path.join(runtimeDir, "runtime.json") };
const spawnedGroups = new Set();

try {
  assert.equal(await readRuntimeState(paths), null);
  await writeRuntimeState(paths, { pid: 99_999_999, startedAt: 1 });
  assert.equal((await runtimeStatus(paths)).status, "stale");
  assert.equal((await stopRuntime(paths)).reason, "stale_state_cleared");

  const logPath = path.join(root, "rootbound.log");
  await writeFile(logPath, "abcdef");
  assert.equal(await tailLog(logPath, { maxBytes: 3 }), "def");

  if (process.platform !== "win32") {
    const first = await spawnRuntimeTree(root, "force-tree");
    await writeRuntimeState(paths, { pid: first.supervisorPid, supervisorPid: first.supervisorPid, tunnelPid: first.tunnelPid, startedAt: Date.now() });
    const forced = await stopRuntime(paths, { force: true });
    assert.equal(forced.status, "stopped");
    assert.equal(forced.stopped, true);
    assert.equal(forced.previousPid, first.supervisorPid);
    assert.equal(forced.previousTunnelPid, first.tunnelPid);
    await waitForExit(first.supervisorPid);
    await waitForExit(first.tunnelPid);
    await waitForExit(first.mcpPid);
    assert.equal(isProcessAlive(first.supervisorPid), false);
    assert.equal(isProcessAlive(first.tunnelPid), false);
    assert.equal(isProcessAlive(first.mcpPid), false, "force stop must terminate grandchildren in the detached runtime process group");
    spawnedGroups.delete(first.supervisorPid);
    assert.equal(await readRuntimeState(paths), null);

    const orphan = await spawnRuntimeTree(root, "orphan-tree");
    await writeRuntimeState(paths, { pid: orphan.supervisorPid, supervisorPid: orphan.supervisorPid, tunnelPid: orphan.tunnelPid, startedAt: Date.now() });
    process.kill(orphan.supervisorPid, "SIGKILL");
    await waitForExit(orphan.supervisorPid);
    assert.equal(isProcessAlive(orphan.supervisorPid), false);
    assert.equal(isProcessAlive(orphan.tunnelPid), true, "fixture must reproduce the historical orphaned tunnel state");
    assert.equal(isProcessAlive(orphan.mcpPid), true, "fixture must reproduce the historical orphaned MCP state");

    const recovered = await stopRuntime(paths, { force: true });
    assert.equal(recovered.status, "stopped");
    assert.equal(recovered.stopped, true);
    await waitForExit(orphan.tunnelPid);
    await waitForExit(orphan.mcpPid);
    assert.equal(isProcessAlive(orphan.tunnelPid), false, "stale runtime cleanup must reap an orphaned tunnel");
    assert.equal(isProcessAlive(orphan.mcpPid), false, "stale runtime cleanup must reap the tunnel's MCP child");
    spawnedGroups.delete(orphan.supervisorPid);
    assert.equal(await readRuntimeState(paths), null);
  }

  console.log("runtime-state-v5: ok");
} finally {
  if (process.platform !== "win32") {
    for (const groupId of spawnedGroups) {
      try { process.kill(-groupId, "SIGKILL"); }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  }
  await rm(root, { recursive: true, force: true });
}

async function spawnRuntimeTree(base, label) {
  const dir = path.join(base, label);
  await mkdir(dir, { recursive: true });
  const tunnelScript = path.join(dir, "tunnel.mjs");
  const supervisorScript = path.join(dir, "supervisor.mjs");
  const pidFile = path.join(dir, "pids.json");

  await writeFile(tunnelScript, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const pidFile = process.argv[2];
const mcp = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, JSON.stringify({ tunnelPid: process.pid, mcpPid: mcp.pid }));
setInterval(() => {}, 1000);
`);
  await writeFile(supervisorScript, `
import { spawn } from "node:child_process";
const tunnelScript = process.argv[2];
const pidFile = process.argv[3];
spawn(process.execPath, [tunnelScript, pidFile], { stdio: "ignore" });
setInterval(() => {}, 1000);
`);

  const supervisor = spawn(process.execPath, [supervisorScript, tunnelScript, pidFile], {
    detached: true,
    stdio: "ignore",
  });
  const supervisorPid = supervisor.pid;
  spawnedGroups.add(supervisorPid);
  const pids = await waitForPidFile(pidFile);
  assert.equal(isProcessAlive(supervisorPid), true);
  assert.equal(isProcessAlive(pids.tunnelPid), true);
  assert.equal(isProcessAlive(pids.mcpPid), true);
  return { supervisor, supervisorPid, ...pids };
}

async function waitForPidFile(pidFile) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(pidFile, "utf8"));
      if (Number.isInteger(value.tunnelPid) && Number.isInteger(value.mcpPid)) return value;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`runtime tree fixture did not publish pids: ${pidFile}`);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process did not exit: ${pid}`);
}
