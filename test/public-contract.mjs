import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
// The public-contract test owns surface/guard assertions, not Codex build policy.
// Resolve the real executable regardless of its version and let the spawned
// Rootbound runtime perform the normal known-version/capability compatibility gate.
const codexBin = (await resolveCodexExecutable({ acceptedVersions: null })).path;
const testCwd = process.env.ROOTBOUND_TEST_CWD;
const stateHome = path.join(projectRoot, "node_modules", `.rootbound-public-contract-${process.pid}`);
const codexHome = path.join(stateHome, "codex");
await mkdir(codexHome, { recursive: true });
const trustedRoots = [...new Set([projectRoot, ...(testCwd ? [path.resolve(testCwd)] : [])])];
const codexConfig = trustedRoots
  .map((root) => `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`)
  .join("\n");
await writeFile(path.join(codexHome, "config.toml"), codexConfig, { mode: 0o600 });

function createIsolatedPublicTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("ROOTBOUND_")) delete env[key];
  }
  Object.assign(env, {
    CODEX_BIN: codexBin,
    CODEX_HOME: codexHome,
    ROOTBOUND_HOME: stateHome,
    ...(testCwd ? { ROOTBOUND_DEFAULT_CWD: testCwd } : {}),
    ...extra,
  });
  return env;
}

assert.equal(PUBLIC_SURFACE_VERSION, "rootbound-public-preview-v6");
assert.ok(PUBLIC_TOOL_NAMES.length >= 33);
assert.equal(new Set(PUBLIC_TOOL_NAMES).size, PUBLIC_TOOL_NAMES.length);

const requiredNames = [
  "codex.command_start", "codex.command_poll", "codex.command_write", "codex.command_terminate",
  "codex.workspace_list", "codex.workspace_open", "codex.precise_edit", "codex.edit_undo", "codex.edit_redo",
  "codex.continuity_resume", "codex.quota_status", "codex.continuity_handoff", "codex.continuity_rollback", "codex.continuity_search",
];
const forbiddenNames = [
  "codex.account_preflight", "codex.model_list", "codex.agent_start", "codex.agent_card_render", "codex.agent_card_state",
  "codex.agent_show", "codex.agent_send", "codex.agent_decline", "codex.agent_commit", "codex.agent_approve", "codex.agent_reject",
  "codex.agent_cancel", "codex.thread_archive", "codex.thread_delete", "codex.thread_rollback", "codex.continuity_push",
  "codex.command_status", "codex.command_output", "codex.command_stop",
];

async function assertPublicSurface(client) {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.equal(names.length, PUBLIC_TOOL_NAMES.length);
  assert.deepEqual([...names].sort(), [...PUBLIC_TOOL_NAMES].sort());
  for (const name of requiredNames) assert.equal(names.includes(name), true, `${name} must be exposed by V6 surface`);
  for (const name of forbiddenNames) assert.equal(names.includes(name), false, `${name} must not be exposed by ChatGPT-only surface`);
  assert.equal(names.some((name) => name.startsWith("codex.agent_")), false);

  const commandTool = tools.tools.find((tool) => tool.name === "codex.command_exec");
  const commandStartTool = tools.tools.find((tool) => tool.name === "codex.command_start");
  const commandPollTool = tools.tools.find((tool) => tool.name === "codex.command_poll");
  const commandWriteTool = tools.tools.find((tool) => tool.name === "codex.command_write");
  const commandTerminateTool = tools.tools.find((tool) => tool.name === "codex.command_terminate");
  const workspaceListTool = tools.tools.find((tool) => tool.name === "codex.workspace_list");
  const workspaceTool = tools.tools.find((tool) => tool.name === "codex.workspace_open");
  const undoTool = tools.tools.find((tool) => tool.name === "codex.edit_undo");
  const redoTool = tools.tools.find((tool) => tool.name === "codex.edit_redo");
  const searchTool = tools.tools.find((tool) => tool.name === "codex.repo_search");
  const patchTool = tools.tools.find((tool) => tool.name === "codex.apply_patch");
  const statusTool = tools.tools.find((tool) => tool.name === "codex.git_status");
  const diffTool = tools.tools.find((tool) => tool.name === "codex.git_diff");
  const contextTool = tools.tools.find((tool) => tool.name === "codex.project_context");
  const resumeTool = tools.tools.find((tool) => tool.name === "codex.continuity_resume");
  const quotaTool = tools.tools.find((tool) => tool.name === "codex.quota_status");
  const handoffTool = tools.tools.find((tool) => tool.name === "codex.continuity_handoff");
  const rollbackTool = tools.tools.find((tool) => tool.name === "codex.continuity_rollback");
  const continuitySearchTool = tools.tools.find((tool) => tool.name === "codex.continuity_search");

  assert.equal(commandTool?.annotations?.destructiveHint, true);
  assert.equal(commandStartTool?.annotations?.destructiveHint, true);
  assert.equal(commandPollTool?.annotations?.readOnlyHint, true);
  assert.equal(commandWriteTool?.annotations?.destructiveHint, true);
  assert.equal(commandTerminateTool?.annotations?.destructiveHint, true);
  assert.equal(workspaceListTool?.annotations?.readOnlyHint, true);
  assert.equal(workspaceTool?.annotations?.readOnlyHint, true);
  assert.equal(undoTool?.annotations?.destructiveHint, true);
  assert.equal(redoTool?.annotations?.destructiveHint, true);
  assert.equal(searchTool?.annotations?.readOnlyHint, true);
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  assert.equal(diffTool?.annotations?.readOnlyHint, true);
  assert.equal(patchTool?.annotations?.destructiveHint, true);
  assert.equal(resumeTool?.annotations?.readOnlyHint, true);
  assert.equal(quotaTool?.annotations?.readOnlyHint, true);
  assert.equal(handoffTool?.annotations?.destructiveHint, true);
  assert.equal(rollbackTool?.annotations?.destructiveHint, true);
  assert.equal(continuitySearchTool?.annotations?.readOnlyHint, true);
  assert.match(commandTool?.description ?? "", /without starting a Codex model turn/i);
  assert.match(commandStartTool?.description ?? "", /without starting a Codex model turn/i);
  assert.match(commandPollTool?.description ?? "", /incremental/i);
  assert.match(commandWriteTool?.description ?? "", /stdin/i);
  assert.match(commandTerminateTool?.description ?? "", /terminate/i);
  assert.match(workspaceListTool?.description ?? "", /workspace/i);
  assert.match(workspaceTool?.description ?? "", /never creates|never.*trust|does not.*trust/i);
  assert.match(undoTool?.description ?? "", /hash|SHA/i);
  assert.match(redoTool?.description ?? "", /hash|SHA/i);
  assert.match(patchTool?.description ?? "", /does not start a Codex model turn/i);
  assert.match(contextTool?.description ?? "", /read-only/i);
  assert.match(resumeTool?.description ?? "", /without starting a Codex model turn/i);
  assert.match(quotaTool?.description ?? "", /without starting a Codex model turn/i);
  assert.match(handoffTool?.description ?? "", /without starting a model turn/i);
  assert.match(rollbackTool?.description ?? "", /never uses git reset/i);
  assert.match(continuitySearchTool?.description ?? "", /cold memory/i);

  const nestedCodexCommand = await client.callTool({ name: "codex.command_exec", arguments: { command: [codexBin, "--version"], access: "readOnly" } });
  assert.equal(nestedCodexCommand.isError, true, "nested Codex launch must stay blocked");
  assert.match(nestedCodexCommand.structuredContent?.error ?? nestedCodexCommand.content?.[0]?.text ?? "", /Codex|agent/i);

  const nestedLongCommand = await client.callTool({ name: "codex.command_start", arguments: { command: [codexBin, "--version"], cwd: projectRoot, access: "readOnly" } });
  assert.equal(nestedLongCommand.isError, true, "nested Codex launch through command_start must stay blocked");
}

const client = new Client({ name: "rootbound-public-contract", version: "0.1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "src", "mcp-stdio.mjs")], cwd: projectRoot, env: createIsolatedPublicTestEnv(), stderr: "pipe" });
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[rootbound] ${chunk}`));
await client.connect(transport);
try { await assertPublicSurface(client); }
finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }

if (process.env.ROOTBOUND_TEST_SKIP_HTTP === "1") {
  console.log("Rootbound HTTP public contract SKIPPED by explicit test-only environment override");
} else {
  const httpPort = 17691;
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const httpChild = spawn(process.execPath, [path.join(projectRoot, "src", "mcp-http.mjs")], {
    cwd: projectRoot,
    env: createIsolatedPublicTestEnv({ ROOTBOUND_HOST: "127.0.0.1", ROOTBOUND_PORT: String(httpPort) }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let httpStderr = "";
  httpChild.stderr.setEncoding("utf8");
  httpChild.stderr.on("data", (chunk) => { httpStderr += chunk; });
  async function waitForHttpHealth() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (httpChild.exitCode !== null) throw new Error(`Rootbound HTTP exited early (${httpChild.exitCode}): ${httpStderr}`);
      try { const response = await fetch(`${baseUrl}/healthz`); if (response.ok) return response.json(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Rootbound HTTP did not become healthy: ${httpStderr}`);
  }

  try {
    const health = await waitForHttpHealth();
    assert.equal(health.ok, true);
    assert.equal(health.surfaceVersion, PUBLIC_SURFACE_VERSION);
    assert.equal(health.toolCount, PUBLIC_TOOL_NAMES.length);
    const httpClient = new Client({ name: "rootbound-public-contract-http", version: "0.1.0" });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try { await httpClient.connect(httpTransport); await assertPublicSurface(httpClient); }
    finally { await httpClient.close().catch(() => {}); }
  } finally {
    if (httpChild.exitCode === null) httpChild.kill("SIGTERM");
  }
}

await rm(stateHome, { recursive: true, force: true });
console.log("ChatGPT-only public contract PASS");
