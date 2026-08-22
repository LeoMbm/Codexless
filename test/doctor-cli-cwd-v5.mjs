import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

if (process.platform === "win32") {
  console.log("doctor-cli-cwd-v5: skipped on Windows");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const entrypoint = path.join(repoRoot, "bin", "rootbound-entry.mjs");
const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-doctor-cli-cwd-"));
const project = path.join(temp, "project");
const state = path.join(temp, "state");
const capture = path.join(temp, "codex-cwd.txt");
const fakeCodex = path.join(temp, "fake-codex");
await mkdir(project);

await writeFile(
  fakeCodex,
  "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ROOTBOUND_TEST_CAPTURE_CWD, process.cwd());\nprocess.stdout.write('codex-cli 0.0.0-test\\n');\nprocess.exit(1);\n",
  "utf8"
);
await chmod(fakeCodex, 0o755);

try {
  await execFileAsync(process.execPath, [entrypoint, "doctor", ".", "--json"], {
    cwd: project,
    env: {
      ...process.env,
      ROOTBOUND_HOME: state,
      ROOTBOUND_TEST_CAPTURE_CWD: capture,
      CODEX_BIN: fakeCodex,
      NODE_NO_WARNINGS: "1",
    },
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.fail("doctor must fail because the fake Codex probe exits non-zero");
} catch (error) {
  assert.equal(error?.code, 1);
}

const observedCwd = await readFile(capture, "utf8");
assert.equal(await realpath(observedCwd), await realpath(project));

console.log("doctor-cli-cwd-v5: ok");
