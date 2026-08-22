import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { grantConnectionProjectAccess } from "../src/connection-project-access.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { addConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { allowedProjectsForCurrentConnection, assertRuntimeProjectAllowed, grantProjectForCurrentConnection, migrationSeedProjectRefs, resolveControlPlaneConnection, runtimeMatchesConnection } from "../src/runtime-project-lifecycle.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";

const a = { projectRef: "project_aaaaaaaaaaaaaaaaaaaa", trusted: true };
const b = { projectRef: "project_bbbbbbbbbbbbbbbbbbbb", trusted: true };
assert.deepEqual(migrationSeedProjectRefs({ registry: { connections: [{ id: "c" }] }, projects: [b, a] }), [a.projectRef, b.projectRef]);
assert.deepEqual(migrationSeedProjectRefs({ registry: { connections: [{ id: "a" }, { id: "b" }] }, projects: [a, b] }), []);
assert.equal(runtimeMatchesConnection({ running: true, state: { connectionId: "c" } }, "c"), true);
assert.equal(runtimeMatchesConnection({ running: true, state: { connectionId: "x" } }, "c"), false);

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-runtime-project-life-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(temp, "state") }, home: temp, platform: process.platform });
const added = await addConnection({ paths, name: "default", tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeActive: true, now: () => 1 });
const store = { listProjects() { return [a, b]; } };
const context = await resolveControlPlaneConnection({ paths });
assert.equal(context.scoped, true);
assert.equal(context.connectionId, added.connection.id);

const grant = await grantProjectForCurrentConnection({ paths, store, projectRef: b.projectRef });
assert.equal(grant.scoped, true);
assert.equal(grant.migrated, true);
assert.deepEqual(grant.projectRefs, [a.projectRef, b.projectRef]);
const replay = await grantProjectForCurrentConnection({ paths, store, projectRef: b.projectRef });
assert.equal(replay.changed, false);
const allowed = await allowedProjectsForCurrentConnection({ paths, store });
assert.deepEqual(allowed.projects.map((project) => project.projectRef).sort(), [a.projectRef, b.projectRef]);

const singleRegistry = await loadConnectionRegistry({ paths });
assert.equal((await assertRuntimeProjectAllowed({ paths, registry: singleRegistry, connection: added.connection, projectRef: a.projectRef })).allowed, true);

const second = await addConnection({ paths, name: "work", tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", now: () => 2 });
const multiRegistry = await loadConnectionRegistry({ paths });
await assert.rejects(
  () => assertRuntimeProjectAllowed({ paths, registry: multiRegistry, connection: second.connection, projectRef: a.projectRef }),
  (error) => error.code === "PROJECT_NOT_ALLOWED_FOR_CONNECTION"
);
const secondPaths = resolveConnectionPaths({ paths, connection: second.connection });
await grantConnectionProjectAccess({ paths: secondPaths, projectRef: b.projectRef, now: () => 3 });
assert.equal((await assertRuntimeProjectAllowed({ paths, registry: multiRegistry, connection: second.connection, projectRef: b.projectRef })).allowed, true);
await assert.rejects(
  () => assertRuntimeProjectAllowed({ paths, registry: multiRegistry, connection: second.connection, projectRef: a.projectRef }),
  (error) => error.code === "PROJECT_NOT_ALLOWED_FOR_CONNECTION"
);

const environmentTemp = await mkdtemp(path.join(os.tmpdir(), "rootbound-runtime-project-env-"));
const environmentPaths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(environmentTemp, "state") }, home: environmentTemp, platform: process.platform });
const environmentContext = await resolveControlPlaneConnection({ paths: environmentPaths, env: { ROOTBOUND_TUNNEL_ARGV_JSON: "[\"x\"]" } });
assert.equal(environmentContext.connectionId, "connection_environment");
assert.equal(environmentContext.scoped, false);

console.log("runtime-project-lifecycle-v5: ok");
