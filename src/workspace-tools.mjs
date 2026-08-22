import { realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadConnectionProjectAccess } from "./connection-project-access.mjs";
import { resolveConnectionPaths } from "./connection-paths.mjs";
import { getActiveConnection, getConnection, loadConnectionRegistry } from "./connection-registry.mjs";
import { registerProject, resolveProjectRoot } from "./project-registry.mjs";
import { resolveProjectScope } from "./project-scope.mjs";
import { resolveRootboundPaths } from "./state-paths.mjs";
import { RootboundToolError, typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const projectRefSchema = z.string().regex(/^project_[0-9a-f]{20}$/);

export function registerWorkspaceTools(server, { store, authorityExecutor, publicContext, projectAccessProvider = null }) {
  if (!store || !authorityExecutor || !publicContext) return;
  const effectiveAccessProvider = projectAccessProvider ?? createRuntimeProjectAccessProvider({ store });

  server.registerTool(
    "codex.workspace_list",
    {
      title: "List Rootbound Workspaces",
      description: "List only the local project workspaces allowed for the current Rootbound connection. This is read-only, starts no Codex model turn, and never widens trust or connection access.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => typedToolResponse(() => listWorkspaces({ store, projectAccessProvider: effectiveAccessProvider }), { operation: "workspace_list" })
  );

  server.registerTool(
    "codex.workspace_open",
    {
      title: "Open Rootbound Workspace",
      description: "Open one Rootbound workspace by projectRef or cwd, require exact-root Codex trust for its canonical root, and return reusable read-only project context. On a connection with multiple allowed workspaces, omitting both selectors fails closed instead of guessing. This never creates or widens Codex trust.",
      inputSchema: z.object({ cwd: z.string().min(1).max(32_768).optional(), projectRef: projectRefSchema.optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd, projectRef }) => typedToolResponse(() => openWorkspace({ cwd, projectRef, store, authorityExecutor, publicContext, projectAccessProvider: effectiveAccessProvider }), { operation: "workspace_open" })
  );
}

export async function listWorkspaces({ store, projectAccessProvider = null }) {
  if (!store) throw new Error("workspace_list requires store");
  const projects = store.listProjects();
  const access = projectAccessProvider ? await projectAccessProvider() : { enforced: false, projectRefs: projects.map((project) => project.projectRef) };
  const allowed = new Set(access.projectRefs ?? []);
  const visible = access.enforced ? projects.filter((project) => allowed.has(project.projectRef)) : projects;
  return {
    status: "ok",
    connectionScoped: access.enforced === true,
    connectionId: access.connectionId ?? null,
    count: visible.length,
    workspaces: visible.map((project) => ({
      projectRef: project.projectRef,
      name: project.name,
      root: project.root,
      gitRoot: project.gitRoot ?? null,
      trusted: project.trusted === true,
      available: pathAvailable(project.root),
      lastConnectedAt: project.lastConnectedAt ?? null,
    })),
    modelTurnStarted: false,
  };
}

export async function openWorkspace({ cwd = null, projectRef = null, store, authorityExecutor, publicContext, projectAccessProvider = null }) {
  if (!store || !authorityExecutor || !publicContext) throw new Error("workspace_open requires store, authorityExecutor, and publicContext");
  let resolved;
  let project;

  const access = projectAccessProvider ? await projectAccessProvider() : null;
  if (access?.enforced === true) {
    const scope = resolveProjectScope({ projects: store.listProjects(), allowedProjectRefs: access.projectRefs ?? [], cwd, projectRef });
    try {
      resolved = await resolveProjectRoot(scope.projectRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new RootboundToolError(`Rootbound project path is no longer available: ${scope.projectRoot}`, {
        code: "PROJECT_PATH_UNAVAILABLE",
        category: "state",
        retryable: false,
        nextActions: ["Restore the project path or run rootbound connect . from its new location."],
        details: { projectRef: scope.projectRef },
      });
    }
    project = store.getProject(scope.projectRef);
    if (!project) {
      throw new RootboundToolError(`Rootbound project disappeared from state: ${scope.projectRef}`, {
        code: "PROJECT_NOT_FOUND",
        category: "state",
        retryable: false,
      });
    }
  } else {
    const requested = cwd ?? authorityExecutor.defaultCwd ?? process.cwd();
    resolved = await resolveProjectRoot(requested);
    project = store.getProjectByRoot(resolved.root);
    if (!project) project = await registerProject(store, resolved.root, { trusted: false });
  }

  let authority = null;
  try {
    authority = await authorityExecutor.resolveAuthority({ cwd: resolved.root, access: "readOnly", timeoutMs: 10_000 });
  } catch (error) {
    if (error?.code !== "PERMISSION_APPROVAL_REQUIRED") throw error;
    project = markProjectUntrusted(store, project);
    return needsTrust({
      project,
      resolved,
      errorCode: error.code,
      nextActions: Array.isArray(error.nextActions) ? error.nextActions : ["Authorize the exact workspace root, then retry workspace_open."],
    });
  }

  if (!authority.trustedAncestor || !samePath(authority.trustedAncestor, resolved.root)) {
    project = markProjectUntrusted(store, project);
    return needsTrust({
      project,
      resolved,
      errorCode: "EXACT_ROOT_TRUST_REQUIRED",
      trustedAncestor: authority.trustedAncestor ?? null,
      nextActions: [
        `Trust the canonical workspace root exactly: ${resolved.root}`,
        "Then retry codex.workspace_open.",
      ],
    });
  }

  project = await registerProject(store, resolved.root, { trusted: true });
  const context = await publicContext.projectContext({ cwd: resolved.root });
  return {
    status: "ready",
    project: { ...project, root: resolved.root, gitRoot: resolved.gitRoot },
    authority: {
      permissionProfile: authority.permissionProfile,
      permissionCeiling: authority.permissionCeiling,
      authoritySource: authority.authoritySource,
      trustedAncestor: authority.trustedAncestor,
      exactRoot: true,
    },
    context,
    modelTurnStarted: false,
  };
}

export function createRuntimeProjectAccessProvider({ store, env = process.env, paths = resolveRootboundPaths({ env }) } = {}) {
  if (!store) throw new Error("runtime project access provider requires store");
  const requestedConnectionId = typeof env.ROOTBOUND_CONNECTION_ID === "string" && env.ROOTBOUND_CONNECTION_ID.trim() ? env.ROOTBOUND_CONNECTION_ID.trim() : null;

  return async function runtimeProjectAccess() {
    if (requestedConnectionId === "connection_environment") {
      return { enforced: false, connectionId: requestedConnectionId, projectRefs: store.listProjects().map((project) => project.projectRef), migrationFallback: false };
    }
    const registry = await loadConnectionRegistry({ paths });
    const connection = requestedConnectionId ? getConnection(registry, requestedConnectionId) : getActiveConnection(registry);
    if (requestedConnectionId && !connection) {
      throw new RootboundToolError(`Runtime connection is no longer configured: ${requestedConnectionId}`, {
        code: "CONNECTION_NOT_FOUND",
        category: "configuration",
        retryable: false,
        nextActions: ["Check rootbound connection current and restart Rootbound on a configured connection."],
      });
    }
    if (!connection) {
      return { enforced: false, connectionId: null, projectRefs: store.listProjects().map((project) => project.projectRef), migrationFallback: false };
    }

    const connectionPaths = resolveConnectionPaths({ paths, connection });
    const access = await loadConnectionProjectAccess({ paths: connectionPaths });
    let projectRefs = access.projectRefs;
    let migrationFallback = false;
    if (access.updatedAt === null && registry.connections.length === 1) {
      projectRefs = store.listProjects().filter((project) => project.trusted === true).map((project) => project.projectRef).sort();
      migrationFallback = projectRefs.length > 0;
    }
    if (access.updatedAt === null && registry.connections.length > 1) projectRefs = [];
    return { enforced: true, connectionId: connection.id, projectRefs, migrationFallback };
  };
}

function needsTrust({ project, resolved, errorCode, trustedAncestor = null, nextActions }) {
  return {
    status: "needs_trust",
    project: { ...project, root: resolved.root, gitRoot: resolved.gitRoot },
    authority: trustedAncestor ? { trustedAncestor, exactRoot: false } : null,
    modelTurnStarted: false,
    errorCode,
    category: "permission",
    retryable: false,
    nextActions,
  };
}

function markProjectUntrusted(store, project) {
  if (!project?.trusted) return project;
  return store.upsertProject({ ...project, trusted: false, updatedAt: Date.now() });
}

function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}

function pathAvailable(value) {
  try { realpathSync.native(path.resolve(value)); return true; }
  catch { return false; }
}
