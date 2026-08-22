import assert from "node:assert/strict";
import path from "node:path";
import { resolveProjectScope } from "../src/project-scope.mjs";

const a = { projectRef: "project_aaaaaaaaaaaaaaaaaaaa", root: path.resolve("/tmp/rootbound-a"), name: "same" };
const b = { projectRef: "project_bbbbbbbbbbbbbbbbbbbb", root: path.resolve("/tmp/rootbound-b"), name: "same" };
const nested = { projectRef: "project_cccccccccccccccccccc", root: path.resolve("/tmp/rootbound-a/packages/nested"), name: "nested" };

assert.equal(resolveProjectScope({ projects: [a], allowedProjectRefs: [a.projectRef] }).projectRef, a.projectRef);
assert.throws(() => resolveProjectScope({ projects: [a, b], allowedProjectRefs: [a.projectRef, b.projectRef] }), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
assert.equal(resolveProjectScope({ projects: [a, b], allowedProjectRefs: [a.projectRef, b.projectRef], projectRef: b.projectRef }).projectRef, b.projectRef);
assert.equal(resolveProjectScope({ projects: [a, nested], allowedProjectRefs: [a.projectRef, nested.projectRef], cwd: path.join(nested.root, "src") }).projectRef, nested.projectRef);
assert.equal(resolveProjectScope({ projects: [a], allowedProjectRefs: [a.projectRef], projectRef: a.projectRef, cwd: "src" }).cwd, path.join(a.root, "src"));
assert.throws(() => resolveProjectScope({ projects: [a, b], allowedProjectRefs: [a.projectRef], projectRef: b.projectRef }), (error) => error.code === "PROJECT_NOT_ALLOWED_FOR_CONNECTION");
assert.throws(() => resolveProjectScope({ projects: [a], allowedProjectRefs: [a.projectRef], projectRef: a.projectRef, cwd: "../outside" }), (error) => error.code === "PROJECT_SCOPE_MISMATCH");
assert.throws(() => resolveProjectScope({ projects: [a, b], allowedProjectRefs: [a.projectRef, b.projectRef], cwd: "src" }), (error) => error.code === "PROJECT_SCOPE_REQUIRED");
assert.equal(resolveProjectScope({ projects: [a], allowedProjectRefs: [a.projectRef], cwd: "src" }).projectRef, a.projectRef);
console.log("project-scope-v5: ok");
