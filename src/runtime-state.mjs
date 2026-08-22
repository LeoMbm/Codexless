import { execFile } from "node:child_process";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readRuntimeState(paths) {
  try {
    return JSON.parse(await readFile(paths.runtimeStatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid Rootbound runtime state: ${paths.runtimeStatePath}`);
    throw error;
  }
}

export async function writeRuntimeState(paths, value) {
  const temp = `${paths.runtimeStatePath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, paths.runtimeStatePath);
  return value;
}

export async function clearRuntimeState(paths) {
  try { await unlink(paths.runtimeStatePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function runtimeStatus(paths) {
  const state = await readRuntimeState(paths);
  if (!state) return { status: "stopped", running: false, stale: false, state: null };
  const running = isProcessAlive(state.pid);
  return { status: running ? "running" : "stale", running, stale: !running, state };
}

export async function stopRuntime(paths, { force = false, platform = process.platform } = {}) {
  const current = await runtimeStatus(paths);
  if (!current.state) return { status: "stopped", stopped: false, reason: "not_running" };

  const supervisorPid = runtimeSupervisorPid(current.state);
  const tunnelPid = runtimeTunnelPid(current.state);
  const supervisorAlive = isProcessAlive(supervisorPid);
  const tunnelAlive = isProcessAlive(tunnelPid);
  if (!supervisorAlive && !tunnelAlive) {
    await clearRuntimeState(paths);
    return { status: "stopped", stopped: false, reason: "stale_state_cleared", previousPid: supervisorPid ?? null, previousTunnelPid: tunnelPid ?? null };
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  await signalRuntimeTree({ supervisorPid, tunnelPid, force, platform });
  const deadline = Date.now() + (force ? 1500 : 5000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(supervisorPid) && !isProcessAlive(tunnelPid)) {
      await clearRuntimeState(paths);
      return { status: "stopped", stopped: true, signal, previousPid: supervisorPid ?? null, previousTunnelPid: tunnelPid ?? null };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    status: "stopping",
    stopped: false,
    signal,
    pid: supervisorPid ?? null,
    tunnelPid: tunnelPid ?? null,
    supervisorAlive: isProcessAlive(supervisorPid),
    tunnelAlive: isProcessAlive(tunnelPid),
  };
}

async function signalRuntimeTree({ supervisorPid, tunnelPid, force, platform }) {
  if (platform === "win32") {
    const rootPid = isProcessAlive(supervisorPid) ? supervisorPid : tunnelPid;
    if (!Number.isInteger(rootPid) || rootPid <= 0) return;
    try {
      await execFileAsync("taskkill", ["/PID", String(rootPid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024 });
      return;
    } catch (error) {
      if (!isProcessAlive(supervisorPid) && !isProcessAlive(tunnelPid)) return;
      throw error;
    }
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  for (const groupId of [supervisorPid, tunnelPid]) {
    if (!Number.isInteger(groupId) || groupId <= 0) continue;
    try {
      process.kill(-groupId, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  for (const pid of [tunnelPid, supervisorPid]) {
    if (!isProcessAlive(pid)) continue;
    try { process.kill(pid, signal); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
}

function runtimeSupervisorPid(state) {
  const value = state?.supervisorPid ?? state?.pid;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function runtimeTunnelPid(state) {
  const value = state?.tunnelPid;
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function tailLog(logPath, { maxBytes = 64 * 1024 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("maxBytes must be between 1 and 1048576");
  let info;
  try { info = await stat(logPath); } catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
  const length = Math.min(info.size, maxBytes);
  if (length === 0) return "";
  const handle = await open(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
