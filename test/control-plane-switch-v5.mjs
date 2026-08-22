import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { projectRefForRoot } from "../src/project-registry.mjs";
import { recordRootboundPermissionConsent } from "../src/rootbound-permission-profile.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "bin", "rootbound.mjs");
const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-control-plane-switch-"));
const projectAPath = path.join(temp, "project-a");
const projectBPath = path.join(temp, "project-b");
await mkdir(projectAPath);
await mkdir(projectBPath);
const projectA = await realpath(projectAPath);
const projectB = await realpath(projectBPath);
const stateRoot = path.join(temp, "state");
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: stateRoot }, home: temp, platform: process.platform });
await recordRootboundPermissionConsent({ paths, now: 1 });
const projectARef = projectRefForRoot(projectA);
const projectBRef = projectRefForRoot(projectB);

const store = await openStateStore({ paths });
try {
  for (const [projectRef, root, name] of [[projectARef, projectA, "project-a"], [projectBRef, projectB, "project-b"]]) {
    store.upsertProject({ projectRef, root, gitRoot: null, name, trusted: true, createdAt: 1, updatedAt: 1, lastConnectedAt: 1 });
  }
} finally { store.close(); }

const env = { ...process.env, ROOTBOUND_HOME: stateRoot, ROOTBOUND_TUNNEL_ARGV_JSON: JSON.stringify([process.execPath, "-e", "setInterval(()=>{},1000)"]), NODE_NO_WARNINGS: "1" };

try {
  const first = JSON.parse((await runCli(["start", projectA, "--json"])).stdout);
  assert.equal(first.ok, true);
  assert.equal(first.runtime.state.projectRef, projectARef);
  assert.equal(first.runtime.state.anchorProjectRef, projectARef);
  assert.equal(first.runtime.state.scopeMode, "multi-project");
  const firstSupervisorPid = first.runtime.state.supervisorPid;
  const firstRuntimeId = first.runtime.state.runtimeId;

  const second = JSON.parse((await runCli(["start", projectB, "--json"])).stdout);
  assert.equal(second.ok, true);
  assert.equal(second.project.projectRef, projectBRef);
  assert.equal(second.runtime.state.anchorProjectRef, projectARef, "second project must not replace the runtime anchor");
  assert.equal(second.runtime.state.supervisorPid, firstSupervisorPid, "second project must reuse the supervisor");
  assert.equal(second.runtime.state.runtimeId, firstRuntimeId, "second project must reuse the runtime identity");
  assert.equal(second.runtime.reused, true);
  assert.equal(second.runtime.requestedProjectRef, projectBRef);

  const status = JSON.parse((await runCli(["status", "--json"])).stdout);
  assert.equal(status.runtime.running, true);
  assert.equal(status.runtime.state.anchorProjectRef, projectARef);
  assert.equal(status.runtime.state.connectionId, "connection_environment");
  assert.equal(status.projects.length, 2);
} finally {
  await runCli(["stop", "--force", "--json"], { allowedExitCodes: [0, 1] }).catch(() => {});
}

console.log("control-plane-switch-v5: ok");

async function runCli(args, { expectedExitCode = 0, allowedExitCodes = null } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd: repoRoot, env, timeout: 20_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    if (expectedExitCode !== 0 && !(allowedExitCodes ?? []).includes(0)) assert.fail(`Expected rootbound ${args.join(" ")} to exit ${expectedExitCode}, but it exited 0`);
    return { ...result, exitCode: 0 };
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? error.code : null;
    const allowed = allowedExitCodes ?? [expectedExitCode];
    if (!allowed.includes(exitCode)) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode };
  }
}
