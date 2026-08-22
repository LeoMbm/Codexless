import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { grantConnectionProjectAccess, hasConnectionProjectAccess, loadConnectionProjectAccess, revokeConnectionProjectAccess } from "../src/connection-project-access.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-project-access-"));
const paths = { projectAccessPath: path.join(temp, "projects.json"), projectAccessLockPath: path.join(temp, "projects.lock") };
const a = "project_aaaaaaaaaaaaaaaaaaaa";
const b = "project_bbbbbbbbbbbbbbbbbbbb";

assert.deepEqual((await loadConnectionProjectAccess({ paths })).projectRefs, []);
const first = await grantConnectionProjectAccess({ paths, projectRef: a, now: () => 1 });
assert.equal(first.changed, true);
const replay = await grantConnectionProjectAccess({ paths, projectRef: a, now: () => 2 });
assert.equal(replay.changed, false);
const concurrent = await Promise.all([grantConnectionProjectAccess({ paths, projectRef: b, now: () => 3 }), grantConnectionProjectAccess({ paths, projectRef: b, now: () => 4 })]);
assert.equal(concurrent.filter((row) => row.changed).length, 1);
const access = await loadConnectionProjectAccess({ paths });
assert.deepEqual(access.projectRefs, [a, b]);
assert.equal(hasConnectionProjectAccess(access, b), true);
assert.equal((await revokeConnectionProjectAccess({ paths, projectRef: a, now: () => 5 })).changed, true);
assert.equal((await revokeConnectionProjectAccess({ paths, projectRef: a, now: () => 6 })).changed, false);
assert.deepEqual((await loadConnectionProjectAccess({ paths })).projectRefs, [b]);
console.log("connection-project-access-v5: ok");
