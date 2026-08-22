import { grantConnectionProjectAccess, loadConnectionProjectAccess, revokeConnectionProjectAccess } from "./connection-project-access.mjs";
import { resolveConnectionPaths } from "./connection-paths.mjs";
import { getActiveConnection, loadConnectionRegistry } from "./connection-registry.mjs";

export async function resolveControlPlaneConnection({ paths, env = process.env } = {}) {
  if (!paths) throw new Error("control-plane connection resolution requires paths");
  const registry = await loadConnectionRegistry({ paths });
  const active = getActiveConnection(registry);
  if (active) return { scoped: true, connectionId: active.id, connection: active, connectionPaths: resolveConnectionPaths({ paths, connection: active }), registry };
  if (typeof env.ROOTBOUND_TUNNEL_ARGV_JSON === "string" && env.ROOTBOUND_TUNNEL_ARGV_JSON.trim()) {
    return { scoped: false, connectionId: "connection_environment", connection: null, connectionPaths: null, registry };
  }
  return { scoped: false, connectionId: null, connection: null, connectionPaths: null, registry };
}

export function migrationSeedProjectRefs({ registry, projects = [] } = {}) {
  if (!registry || !Array.isArray(registry.connections) || registry.connections.length !== 1) return [];
  return projects.filter((project) => project?.trusted === true && typeof project?.projectRef === "string").map((project) => project.projectRef).sort();
}

export async function grantProjectForCurrentConnection({ paths, store, projectRef, env = process.env } = {}) {
  if (!store) throw new Error("project grant requires store");
  const context = await resolveControlPlaneConnection({ paths, env });
  if (!context.scoped) return { scoped: false, connectionId: context.connectionId, changed: false, projectRefs: store.listProjects().map((project) => project.projectRef) };
  const existing = await loadConnectionProjectAccess({ paths: context.connectionPaths });
  const seedProjectRefs = existing.updatedAt === null ? migrationSeedProjectRefs({ registry: context.registry, projects: store.listProjects() }) : [];
  const granted = await grantConnectionProjectAccess({ paths: context.connectionPaths, projectRef, seedProjectRefs });
  return { scoped: true, connectionId: context.connectionId, changed: granted.changed, projectRefs: granted.access.projectRefs, migrated: existing.updatedAt === null && seedProjectRefs.length > 0 };
}

export async function allowedProjectsForCurrentConnection({ paths, store, env = process.env } = {}) {
  if (!store) throw new Error("allowed project resolution requires store");
  const context = await resolveControlPlaneConnection({ paths, env });
  const projects = store.listProjects();
  if (!context.scoped) return { ...context, projects };
  const access = await loadConnectionProjectAccess({ paths: context.connectionPaths });
  const refs = access.updatedAt === null ? migrationSeedProjectRefs({ registry: context.registry, projects }) : access.projectRefs;
  const allowed = new Set(refs);
  return { ...context, projectRefs: refs, projects: projects.filter((project) => allowed.has(project.projectRef)) };
}

export async function revokeProjectFromSavedConnections({ paths, projectRef } = {}) {
  if (!paths || typeof projectRef !== "string" || !projectRef) throw new Error("project grant cleanup requires paths and projectRef");
  const registry = await loadConnectionRegistry({ paths });
  const changedConnectionIds = [];
  const failures = [];
  for (const connection of registry.connections) {
    try {
      const connectionPaths = resolveConnectionPaths({ paths, connection });
      const revoked = await revokeConnectionProjectAccess({ paths: connectionPaths, projectRef });
      if (revoked.changed) changedConnectionIds.push(connection.id);
    } catch (error) {
      failures.push({
        connectionId: connection.id,
        connectionName: connection.name,
        errorCode: typeof error?.code === "string" ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { changedConnectionIds, failures };
}

export async function assertRuntimeProjectAllowed({ paths, registry, connection, projectRef } = {}) {
  if (!paths || !registry || !connection || typeof projectRef !== "string" || !projectRef) throw new Error("runtime project access check requires paths, registry, connection, and projectRef");
  if (connection.source === "environment") return { allowed: true, scoped: false, migrationFallback: false };
  const connectionPaths = resolveConnectionPaths({ paths, connection });
  const access = await loadConnectionProjectAccess({ paths: connectionPaths });
  if (access.updatedAt === null && registry.connections.length === 1) {
    return { allowed: true, scoped: true, migrationFallback: true };
  }
  if (!access.projectRefs.includes(projectRef)) {
    const error = new Error(`Project ${projectRef} is not allowed for Rootbound connection ${connection.name}.`);
    error.code = "PROJECT_NOT_ALLOWED_FOR_CONNECTION";
    error.nextActions = ["Stop Rootbound, switch to the target connection, run rootbound connect . from an intended project, then retry the connection switch."];
    throw error;
  }
  return { allowed: true, scoped: true, migrationFallback: false };
}

export function runtimeMatchesConnection(runtime, connectionId) {
  return Boolean(runtime?.running && connectionId && runtime.state?.connectionId === connectionId);
}
