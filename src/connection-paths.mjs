import path from "node:path";

export function resolveConnectionPaths({ paths, connection } = {}) {
  if (!paths || !connection?.id || !connection?.storageKind) throw new Error("resolveConnectionPaths requires Rootbound paths and a connection");
  if (connection.storageKind === "legacy-global") {
    return Object.freeze({
      ...paths,
      connectionId: connection.id,
      connectionDir: paths.stateDir,
      tunnelConfigPath: paths.tunnelConfigPath,
      tunnelManagedProfilePath: paths.tunnelManagedProfilePath,
      tunnelSecretPath: paths.tunnelSecretPath,
      tunnelHealthUrlPath: paths.tunnelHealthUrlPath,
      projectAccessPath: path.join(paths.stateDir, `connection-projects-${connection.id}.json`),
      projectAccessLockPath: path.join(paths.stateDir, `connection-projects-${connection.id}.lock`),
    });
  }
  if (connection.storageKind !== "scoped-v1") throw new Error(`Unsupported connection storage kind: ${connection.storageKind}`);
  const connectionDir = path.join(paths.connectionsDir, connection.id);
  return Object.freeze({
    ...paths,
    connectionId: connection.id,
    connectionDir,
    tunnelConfigPath: path.join(connectionDir, "tunnel.json"),
    tunnelManagedProfilePath: path.join(connectionDir, "tunnel-client.yaml"),
    tunnelSecretPath: path.join(connectionDir, "tunnel-runtime.key"),
    tunnelHealthUrlPath: path.join(paths.runtimeDir, `tunnel-health-${connection.id}.url`),
    projectAccessPath: path.join(connectionDir, "projects.json"),
    projectAccessLockPath: path.join(connectionDir, "projects.lock"),
  });
}
