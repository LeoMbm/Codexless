import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "./runtime-state.mjs";

const SCHEMA_VERSION = 1;
const PROJECT_REF_PATTERN = /^project_[0-9a-f]{20}$/;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;

export async function loadConnectionProjectAccess({ paths } = {}) {
  assertPaths(paths);
  try {
    return validateAccess(JSON.parse(await readFile(paths.projectAccessPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, projectRefs: [], updatedAt: null };
    if (error instanceof SyntaxError) throw accessError("CONNECTION_PROJECT_ACCESS_INVALID", `Invalid project access file: ${paths.projectAccessPath}`);
    throw error;
  }
}

export async function grantConnectionProjectAccess({ paths, projectRef, now = Date.now } = {}) {
  validateProjectRef(projectRef);
  return withAccessLock(paths, async () => {
    const current = await loadConnectionProjectAccess({ paths });
    if (current.projectRefs.includes(projectRef)) return { access: current, changed: false };
    const next = { schemaVersion: SCHEMA_VERSION, projectRefs: [...current.projectRefs, projectRef].sort(), updatedAt: now() };
    await writeAccess(paths, next);
    return { access: next, changed: true };
  });
}

export async function revokeConnectionProjectAccess({ paths, projectRef, now = Date.now } = {}) {
  validateProjectRef(projectRef);
  return withAccessLock(paths, async () => {
    const current = await loadConnectionProjectAccess({ paths });
    if (!current.projectRefs.includes(projectRef)) return { access: current, changed: false };
    const next = { schemaVersion: SCHEMA_VERSION, projectRefs: current.projectRefs.filter((value) => value !== projectRef), updatedAt: now() };
    await writeAccess(paths, next);
    return { access: next, changed: true };
  });
}

export function hasConnectionProjectAccess(access, projectRef) {
  validateProjectRef(projectRef);
  return validateAccess(access).projectRefs.includes(projectRef);
}

async function writeAccess(paths, value) {
  assertPaths(paths);
  const access = validateAccess(value);
  await mkdir(path.dirname(paths.projectAccessPath), { recursive: true, mode: 0o700 });
  const temp = `${paths.projectAccessPath}.${process.pid}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(access, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  if (process.platform !== "win32") await chmod(temp, 0o600);
  await rename(temp, paths.projectAccessPath);
  if (process.platform !== "win32") await chmod(paths.projectAccessPath, 0o600);
  return access;
}

async function withAccessLock(paths, fn) {
  assertPaths(paths);
  await mkdir(path.dirname(paths.projectAccessLockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle = null;
  while (!handle) {
    try {
      handle = await open(paths.projectAccessLockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(await readFile(paths.projectAccessLockPath, "utf8")); } catch {}
      if (!Number.isInteger(owner?.pid) || !isProcessAlive(owner.pid)) {
        await unlink(paths.projectAccessLockPath).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
        continue;
      }
      if (Date.now() >= deadline) throw accessError("CONNECTION_PROJECT_ACCESS_BUSY", `Project access is being modified by pid ${owner.pid}.`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    await handle.sync();
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(paths.projectAccessLockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

function validateAccess(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.projectRefs)) throw accessError("CONNECTION_PROJECT_ACCESS_INVALID", "Unsupported connection project access schema.");
  const projectRefs = [...new Set(value.projectRefs)];
  if (projectRefs.length !== value.projectRefs.length || !projectRefs.every((projectRef) => PROJECT_REF_PATTERN.test(projectRef))) throw accessError("CONNECTION_PROJECT_ACCESS_INVALID", "Connection project access contains invalid or duplicate project refs.");
  return { schemaVersion: SCHEMA_VERSION, projectRefs: [...projectRefs].sort(), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null };
}

function validateProjectRef(projectRef) {
  if (typeof projectRef !== "string" || !PROJECT_REF_PATTERN.test(projectRef)) throw accessError("PROJECT_REF_INVALID", "Invalid Rootbound projectRef.");
}
function assertPaths(paths) {
  if (!paths?.projectAccessPath || !paths?.projectAccessLockPath) throw new Error("connection project access requires projectAccessPath and projectAccessLockPath");
}
function accessError(code, message) { const error = new Error(message); error.code = code; return error; }
