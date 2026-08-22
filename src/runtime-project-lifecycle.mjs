import { grantConnectionProjectAccess, loadConnectionProjectAccess } from "./connection-project-access.mjs";
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

export function runtimeMatchesConnection(runtime, connectionId) {
  return Boolean(runtime?.running && connectionId && runtime.state?.connectionId === connectionId);
}
