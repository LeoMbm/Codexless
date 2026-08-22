import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { probeCodexExecutable, redactHomePath, resolveCodexExecutable } from "../src/codex-bin.mjs";
import { parseCodexVersion, resolveCompatibleCodexRuntime } from "../src/codex-compatibility.mjs";
import { getActiveConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { readJsonFile } from "../src/json-file.mjs";
import { withRootboundPermissionOverrides } from "../src/rootbound-permission-profile.mjs";
import { runtimeStatus } from "../src/runtime-state.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";
import { validateManagedTunnel } from "../src/tunnel-bootstrap.mjs";
import { tunnelConfigStatus } from "../src/tunnel-config.mjs";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const rootboundPaths = resolveRootboundPaths();
const packageJson = await readJsonFile(path.join(projectRoot, "package.json"), "package.json");
const args = parseArgs(process.argv.slice(2));
const callerCwd = path.resolve(process.cwd());
const explicitCwd = args.cwd ? path.resolve(args.cwd) : null;
const requestedCwd = explicitCwd ?? (callerCwd !== projectRoot ? callerCwd : null);
const runtimeCwd = requestedCwd ?? projectRoot;
const profileOverride = typeof process.env.ROOTBOUND_PROFILE === "string" && process.env.ROOTBOUND_PROFILE.trim() ? process.env.ROOTBOUND_PROFILE.trim() : null;
const configOverridesFile = typeof process.env.ROOTBOUND_CONFIG_OVERRIDES_FILE === "string" && process.env.ROOTBOUND_CONFIG_OVERRIDES_FILE.trim() ? process.env.ROOTBOUND_CONFIG_OVERRIDES_FILE.trim() : null;
const configuredOverrides = configOverridesFile ? (await readJsonFile(configOverridesFile, "ROOTBOUND_CONFIG_OVERRIDES_FILE"))?.overrides : [];
const configOverrides = withRootboundPermissionOverrides(configuredOverrides, { profileOverride });
const checks = [];
const warnings = [];
let codexResolution = null;
let codexProbe = null;
let appServer = null;
let projectContext = null;
let codexCompatibility = null;
let connectionContext = { status: "not_configured" };

const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
const dynamicMacCompatibility = process.platform === "darwin" && process.arch === "arm64";
record("platform", supportedPlatform, supportedPlatform ? `${process.platform}/${process.arch}` : `Unsupported platform: ${process.platform}/${process.arch}`);
const nodeSupported = compareVersion(process.versions.node, "22.13.0") >= 0;
record("node", nodeSupported, `Node ${process.version}`, nodeSupported ? null : "Node.js >=22.13.0 is required by the Rootbound SQLite state layer");

const forbiddenModelTools = PUBLIC_TOOL_NAMES.filter((name) => name === "codex.account_preflight" || name === "codex.model_list" || name.startsWith("codex.agent_"));
const uniqueToolNames = new Set(PUBLIC_TOOL_NAMES).size === PUBLIC_TOOL_NAMES.length;
const versionedSurface = /^rootbound-public-preview-v\d+$/.test(PUBLIC_SURFACE_VERSION);
const expectedSurface = versionedSurface && uniqueToolNames && PUBLIC_TOOL_NAMES.length > 0;
record("public-surface", expectedSurface && forbiddenModelTools.length === 0, `${PUBLIC_SURFACE_VERSION}; ${PUBLIC_TOOL_NAMES.length} tools; modelLane=chatgpt-only`, forbiddenModelTools.length ? `Forbidden Codex model tools exposed: ${forbiddenModelTools.join(", ")}` : !versionedSurface ? "Public surface version is not a supported versioned Rootbound preview identifier" : !uniqueToolNames ? "Public tool list contains duplicate names" : "Expected a non-empty unique ChatGPT-only public surface");
record("surface-compatibility", expectedSurface, expectedSurface ? `${PUBLIC_SURFACE_VERSION} contract is internally consistent (${PUBLIC_TOOL_NAMES.length} tools)` : "Surface contract is stale or incomplete", expectedSurface ? null : "Restart/reconnect the Rootbound MCP connection after upgrading so ChatGPT refreshes its cached tool snapshot");

await checkConnections();

for (const spec of ["@modelcontextprotocol/node", "@modelcontextprotocol/server", "zod"]) {
  try {
    const resolved = require.resolve(spec);
    const local = isWithin(projectRoot, resolved) && resolved.toLowerCase().includes(`${path.sep}node_modules${path.sep}`.toLowerCase());
    record(`dependency:${spec}`, local, local ? "resolved from Rootbound node_modules" : "resolved outside Rootbound", local ? null : "Run npm ci in the Rootbound install directory");
  } catch (error) { record(`dependency:${spec}`, false, "not resolvable", error instanceof Error ? error.message : String(error)); }
}

let parsedVersion = null;
try {
  codexResolution = await resolveCodexExecutable({ acceptedVersions: null });
  codexProbe = await probeCodexExecutable(codexResolution.path, { cwd: runtimeCwd });
  record("codex-executable", codexProbe.ok, codexProbe.versionText ?? "Codex version probe failed", codexProbe.error);
  parsedVersion = parseCodexVersion(codexProbe.versionText);
  if (!parsedVersion) record("codex-version-gate", false, "Codex CLI version could not be parsed", "Install a Codex build whose --version output includes codex-cli <version>");
  else if (!requestedCwd && dynamicMacCompatibility && !ACCEPTED_CODEX_VERSIONS.includes(parsedVersion)) {
    record("codex-version-gate", true, `Codex CLI ${parsedVersion}; compatibility verification deferred until a trusted project is connected`, null, false);
  } else if (!dynamicMacCompatibility) {
    const versionAccepted = ACCEPTED_CODEX_VERSIONS.includes(parsedVersion);
    record("codex-version-gate", versionAccepted, `Codex CLI ${parsedVersion}`, versionAccepted ? null : `Accepted Codex builds: ${ACCEPTED_CODEX_VERSIONS.join(", ")}`);
  }
} catch (error) { record("codex-executable", false, "Codex executable resolution failed", error instanceof Error ? error.message : String(error)); }

if (codexResolution?.path && codexProbe?.ok) {
  const client = new CodexAppServerClient({
    cwd: runtimeCwd,
    launch: () => ({ command: codexResolution.path, args: [...configOverrides.flatMap((value) => ["-c", value]), "app-server", "--stdio"], options: { cwd: runtimeCwd } }),
    requestTimeoutMs: 20_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: () => {},
    clientInfo: { name: "rootbound_doctor", title: "Rootbound Doctor", version: packageJson.version },
  });
  try {
    const initialized = await client.start();
    appServer = { ok: true, serverName: initialized?.serverInfo?.name ?? null, serverVersion: initialized?.serverInfo?.version ?? null };
    record("codex-app-server", true, "initialize succeeded");
  } catch (error) {
    appServer = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
    record("codex-app-server", false, "initialize failed", appServer.error);
  } finally { await client.close().catch(() => {}); }

  if (requestedCwd) {
    try {
      let resolved;
      if (dynamicMacCompatibility) {
        codexCompatibility = await resolveCompatibleCodexRuntime({
          cwd: requestedCwd,
          profileOverride,
          configOverrides,
          maxTimeoutMs: 30_000,
          outputBytesCap: 64 * 1024,
        });
        resolved = codexCompatibility.authority;
        record(
          "codex-version-gate",
          true,
          `Codex CLI ${codexCompatibility.version}; ${codexCompatibility.knownAcceptedVersion ? "built-in version policy" : "runtime capability probe passed"}`
        );
      } else {
        const authority = new CodexAuthorityExecutor({ codexBin: codexResolution.path, defaultCwd: requestedCwd, profileOverride, configOverrides, acceptedCodexVersions: ACCEPTED_CODEX_VERSIONS });
        await authority.validate();
        resolved = await authority.resolveAuthority({ cwd: requestedCwd, access: "readOnly" });
      }
      projectContext = { ok: true, cwd: redactHomePath(resolved.effectiveCwd), permissionProfile: resolved.permissionProfile, permissionCeiling: resolved.permissionCeiling, authoritySource: resolved.authoritySource, trustedAncestor: redactHomePath(resolved.trustedAncestor), profileOverride };
      record("project-authority", true, `read-only authority accepted ${redactHomePath(requestedCwd)} as ${resolved.permissionProfile}`);
    } catch (error) {
      if (dynamicMacCompatibility && parsedVersion) {
        record("codex-version-gate", false, `Codex CLI ${parsedVersion}; runtime capability probe failed`, error instanceof Error ? error.message : String(error));
      }
      projectContext = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
      warnings.push({ kind: "project-authority", message: projectContext.error });
    }
  }
}

const failedCoreChecks = checks.filter((check) => check.required && !check.ok);
if (requestedCwd && !projectContext) {
  const prerequisite = checks.find((check) => !check.ok && ["codex-executable", "codex-version-gate", "codex-app-server"].includes(check.name)) ?? failedCoreChecks[0] ?? null;
  const detail = prerequisite
    ? `${prerequisite.name}: ${prerequisite.detail}${prerequisite.action ? `; ${prerequisite.action}` : ""}`
    : "project authority was not reached";
  projectContext = { ok: false, error: sanitizeText(`Project authority was not checked because a prerequisite failed: ${detail}`) };
}
const status = failedCoreChecks.length ? "error" : warnings.length || (requestedCwd && !projectContext?.ok) ? "partial" : "ok";
const result = {
  status,
  rootbound: { packageVersion: packageJson.version, serverVersion: PUBLIC_SERVER_VERSION, surfaceVersion: PUBLIC_SURFACE_VERSION, publicToolCount: PUBLIC_TOOL_NAMES.length, modelLane: "chatgpt-only", installRoot: redactHomePath(projectRoot) },
  host: { platform: process.platform, arch: process.arch, node: process.version },
  connection: connectionContext,
  codex: {
    resolutionSource: codexResolution?.source ?? null,
    executable: codexResolution?.path ? redactHomePath(codexResolution.path) : null,
    version: codexProbe?.versionText ?? null,
    appServer,
    compatibility: codexCompatibility ? { source: codexCompatibility.acceptanceSource, knownAcceptedVersion: codexCompatibility.knownAcceptedVersion, modelTurnStarted: false } : null,
  },
  project: requestedCwd ? projectContext : { status: "not_requested" },
  checks,
  warnings: dedupeWarnings(warnings),
  notes: [
    "The public MCP surface is ChatGPT-only and exposes no Codex model/agent/quota routing tools.",
    "Codex App Server remains the local sandbox, permission, history, and command execution substrate.",
    "Unknown Apple Silicon macOS Codex builds are accepted only for the current process after the model-free compatibility probe passes; no durable trust is written for future binaries.",
    "Doctor does not start a Codex model turn.",
    "Connection diagnostics validate Rootbound's local tunnel profile; ChatGPT must still select the same tunnel ID in its connector settings.",
    "After a surface upgrade, reconnect ChatGPT to refresh its cached MCP tool snapshot."
  ],
};

if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); else printHuman(result);
process.exitCode = status === "error" ? 1 : 0;

async function checkConnections() {
  let registry;
  try {
    registry = await loadConnectionRegistry({ paths: rootboundPaths });
    record("connection-registry", true, `${registry.connections.length} configured connection(s)`);
  } catch (error) {
    record("connection-registry", false, "connection registry is invalid", message(error), true);
    connectionContext = { status: "invalid", error: sanitizeText(message(error)) };
    return;
  }
  const active = getActiveConnection(registry);
  if (!active) {
    connectionContext = { status: "not_configured", count: registry.connections.length };
    record("active-connection", true, "no active connection configured yet", null, false);
    return;
  }
  const connectionPaths = resolveConnectionPaths({ paths: rootboundPaths, connection: active });
  let tunnel;
  try {
    tunnel = tunnelConfigStatus({ paths: connectionPaths, env: {} });
    record("active-connection", tunnel.configured, `${active.name}; tunnel=${tunnel.tunnelId ?? active.tunnelId ?? "manual/unknown"}`, tunnel.configured ? null : `Repair or configure connection "${active.name}"`);
  } catch (error) {
    record("active-connection", false, `${active.name}; invalid tunnel configuration`, message(error));
    connectionContext = { status: "invalid", id: active.id, name: active.name, error: sanitizeText(message(error)) };
    return;
  }
  if (connectionPaths.tunnelSecretPath && active.storageKind === "scoped-v1") {
    try {
      const info = await stat(connectionPaths.tunnelSecretPath);
      const safe = process.platform === "win32" || (info.mode & 0o077) === 0;
      record("tunnel-secret-permissions", safe, safe ? "runtime key is private" : `unsafe mode ${(info.mode & 0o777).toString(8)}`, `chmod 600 "${redactHomePath(connectionPaths.tunnelSecretPath)}"`);
    } catch (error) { record("tunnel-secret-permissions", false, "runtime key is missing", `Run rootbound connection repair ${active.name}`); }
  }
  if (active.storageKind === "scoped-v1" && tunnel?.tunnelId) {
    try {
      await validateManagedTunnel({ profilePath: connectionPaths.tunnelManagedProfilePath, cwd: projectRoot });
      record("tunnel-client-doctor", true, `${tunnel.tunnelId} validated`);
    } catch (error) { record("tunnel-client-doctor", false, `${tunnel.tunnelId} validation failed`, `Run rootbound connection repair ${active.name}`); }
  }
  const runtime = await runtimeStatus(rootboundPaths);
  const drift = runtime.running && Boolean(runtime.state?.connectionId) && runtime.state.connectionId !== active.id;
  record("runtime-connection", !drift, runtime.running ? (drift ? `registry=${active.name}; runtime=${runtime.state?.connectionName ?? runtime.state?.connectionId}` : `runtime uses ${active.name}`) : "runtime stopped", drift ? `Run rootbound connection switch ${active.name}` : null);
  const ready = !runtime.running || active.storageKind === "legacy-global" || runtime.state?.ready === true;
  record("tunnel-readiness", ready, runtime.running ? (runtime.state?.ready ? "runtime /readyz passed" : active.storageKind === "legacy-global" ? "legacy runtime compatibility mode" : "runtime is not ready") : "runtime stopped", ready ? null : `Run rootbound connection switch ${active.name}`);
  connectionContext = { status: tunnel?.configured ? "configured" : "invalid", id: active.id, name: active.name, tunnelId: tunnel?.tunnelId ?? active.tunnelId ?? null, storageKind: active.storageKind, runtime: runtime.status, ready: runtime.state?.ready ?? false, drift };
}

function parseArgs(argv) {
  const parsed = { json: false, cwd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--cwd") { const value = argv[i + 1]; if (!value) throw new Error("--cwd requires a path"); parsed.cwd = value; i += 1; }
    else if (arg === "--help" || arg === "-h") { process.stdout.write("Usage: node scripts/doctor.mjs [--json] [--cwd <project-directory>]\n"); process.exit(0); }
    else throw new Error(`Unknown doctor argument: ${arg}`);
  }
  return parsed;
}
function record(name, ok, detail, action = null, required = true) { checks.push({ name, ok: Boolean(ok), required, detail: sanitizeText(detail), ...(action ? { action: sanitizeText(action) } : {}) }); }
function compareVersion(a, b) { const left = String(a).split(".").map((part) => Number.parseInt(part, 10)); const right = String(b).split(".").map((part) => Number.parseInt(part, 10)); for (let i = 0; i < Math.max(left.length, right.length); i += 1) { const delta = (left[i] ?? 0) - (right[i] ?? 0); if (delta !== 0) return delta > 0 ? 1 : -1; } return 0; }
function isWithin(root, candidate) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function sanitizeText(value) { return String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@").replace(/([?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret)=)[^&\s"']+/gi, "$1<redacted>").replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer <redacted>"); }
function dedupeWarnings(rows) { const seen = new Set(); return rows.filter((row) => { const key = `${row.kind}:${row.message}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function printHuman(value) {
  const mark = (ok) => ok ? "PASS" : "FAIL";
  process.stdout.write(`Rootbound doctor: ${value.status.toUpperCase()}\n`);
  process.stdout.write(`Version ${value.rootbound.packageVersion} | ${value.rootbound.surfaceVersion} | ${value.rootbound.publicToolCount} public tools | ChatGPT-only\n\n`);
  for (const check of value.checks) { process.stdout.write(`[${mark(check.ok)}] ${check.name}: ${check.detail}\n`); if (!check.ok && check.action) process.stdout.write(`       -> ${check.action}\n`); }
  if (value.connection?.name) process.stdout.write(`\nConnection: ${value.connection.name}${value.connection.tunnelId ? ` (${value.connection.tunnelId})` : ""}\n`);
  if (value.project.status !== "not_requested") process.stdout.write(`Project authority: ${value.project.ok ? "ok" : "needs attention"}\n`);
  if (value.warnings.length) { process.stdout.write("\nWarnings:\n"); for (const warning of value.warnings) process.stdout.write(`- ${warning.kind}: ${warning.message}\n`); }
  process.stdout.write("\nNo Codex model turn was started.\n");
}
