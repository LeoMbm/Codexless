import path from "node:path";
import { createRequire } from "node:module";
import { createContinuityIdempotency } from "./continuity-idempotency.mjs";
import { buildContinuityManifest, manifestInjectionFooter, persistContinuityManifest } from "./continuity-manifest.mjs";
import { registerProject, resolveProjectRoot } from "./project-registry.mjs";
import { buildContinuityCheckpoint } from "./thread-history-tools.mjs";
import { publicFingerprint } from "./rescue-continuity.mjs";
import { RootboundToolError, typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const cwdSchema = z.string().min(1).max(32_768).optional();
const threadIdSchema = z.string().min(1).max(4_096).optional();
const rescueRefSchema = z.string().regex(/^rescue_[0-9a-f-]{36}$/i).optional();
const lineSchema = z.string().min(1).max(8_192);
const idempotencyKeySchema = z.string().min(8).max(256).regex(/^[A-Za-z0-9._:-]+$/).optional();

export function registerRescueTools(server, { context, authorityExecutor, continuityState, stateStore, rescueManager, rescueAutopilot = null, getSessionKey }) {
  if (!server || !context || !authorityExecutor || !continuityState || !stateStore || !rescueManager || !getSessionKey) return;
  const idempotency = createContinuityIdempotency({ store: stateStore });

  server.registerTool("codex.continuity_resume", {
    title: "Resume Interrupted Codex Work",
    description: "Reattach a verified durable rescue when possible, otherwise consume a revalidated quota-autopilot candidate or find the best matching persisted Codex session for the authorized workspace. This reads history and current worktree state without starting a Codex model turn.",
    inputSchema: z.object({ cwd: cwdSchema, threadId: threadIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, ctx) => typedToolResponse(async () => {
    const project = await resolveAuthorizedProject({ cwd: input.cwd, authorityExecutor, stateStore });
    const fingerprint = await rescueManager.captureFingerprint(project.root);
    let selection = null;
    let selectionSource = "search";

    if (!input.threadId) {
      const active = rescueManager.activeForProject?.(project.projectRef) ?? null;
      if (active?.threadId) {
        selection = await selectContinuationThread({ context, authorityExecutor, project, fingerprint, threadId: active.threadId });
        selectionSource = "durable_rescue";
      }
    }

    if (!selection && !input.threadId && rescueAutopilot) {
      const armed = rescueAutopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: fingerprint.fingerprintHash });
      if (armed?.threadId) {
        try {
          const candidate = await selectContinuationThread({ context, authorityExecutor, project, fingerprint, threadId: armed.threadId });
          if (candidate.match?.confidence !== "not_found" && candidate.match?.repository !== "mismatch") {
            selection = candidate;
            selectionSource = "autopilot";
          }
        } catch {}
      }
    }

    if (!selection) {
      selection = await selectContinuationThread({ context, authorityExecutor, project, fingerprint, threadId: input.threadId });
      selectionSource = input.threadId ? "explicit_thread" : "search";
    }

    if (selection.status === "not_found") {
      return { status: "not_found", project: publicProject(project), match: selection.match, worktree: publicFingerprint(fingerprint), modelTurnStarted: false };
    }
    if (selection.status === "ambiguous") {
      return { status: "ambiguous", project: publicProject(project), candidates: selection.candidates, worktree: publicFingerprint(fingerprint), modelTurnStarted: false,
        nextActions: ["Retry codex.continuity_resume with the intended threadId."] };
    }
    const thread = selection.thread;
    const binding = continuityState.bindOrReuse({ threadId: thread.id, cwd: project.root, threadPreview: thread.preview ?? null });
    const quota = await safeQuota(context);
    const sessionKey = getSessionKey(ctx);
    const rescue = await rescueManager.start({ sessionKey, project, thread, bindingRef: binding.bindingRef, match: selection.match, quota });
    const recent = await context.threadRead({ threadId: thread.id, limit: 8, sortDirection: "desc", metadata: { thread } });
    const response = {
      status: "ready",
      rescueMode: {
        active: true,
        reason: quota?.codex?.availability === "exhausted" ? "codex_quota_exhausted" : "codex_interruption_or_manual_handoff",
        codexAvailability: quota?.codex?.availability ?? "unknown",
        resetsAt: quota?.codex?.resetsAt ?? null,
        durable: true,
        reattached: rescue.reattached === true,
        selectionSource,
      },
      project: publicProject(project),
      thread: publicThread(thread),
      match: selection.match,
      rescue: rescueManager.publicSession(rescue),
      handoff: projectBoundedHistory(recent),
      worktree: publicFingerprint(rescue.baselineFingerprint),
      quota,
      autopilot: rescueAutopilot ? { enabled: true, candidateUsed: selectionSource === "autopilot", state: rescueAutopilot.status() } : { enabled: false },
      bindingReused: binding.reused === true,
      modelTurnStarted: false,
    };
    if (!sessionKey) response.nextActions = ["Silently propagate rescue.rescueRef on subsequent Rootbound project tools and continuity actions; do not ask the user to copy it."];
    return response;
  }, { operation: "continuity_resume" }));

  server.registerTool("codex.quota_status", {
    title: "Read Codex Quota Status",
    description: "Read the current Codex/ChatGPT rate-limit snapshot through Codex App Server without starting a Codex model turn. Quota state is advisory and never gates Rootbound continuity.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => typedToolResponse(async () => ({
    ...await safeQuota(context),
    autopilot: rescueAutopilot ? { enabled: true, ...rescueAutopilot.status() } : { enabled: false, status: "disabled" },
    modelTurnStarted: false,
  }), { operation: "quota_status" }));

  server.registerTool("codex.continuity_handoff", {
    title: "Hand Rescue Work Back To Codex",
    description: "Verify the active rescue worktree, create a hashed Rootbound continuity manifest, inject a bounded delta checkpoint into the original persisted Codex thread without starting a model turn, and close the rescue session as handed off.",
    inputSchema: z.object({
      rescueRef: rescueRefSchema,
      summary: z.string().min(1).max(30_000),
      decisions: z.array(lineSchema).max(100).default([]),
      remainingWork: z.array(lineSchema).max(100).default([]),
      idempotencyKey: idempotencyKeySchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input, ctx) => typedToolResponse(async () => {
    const rescue = requireActiveRescue(rescueManager, { sessionKey: getSessionKey(ctx), rescueRef: input.rescueRef });
    await rescueManager.assertNoDrift(rescue);
    const project = stateStore.getProject(rescue.projectRef);
    if (!project) throw stateError("RESCUE_PROJECT_MISSING", "The rescue project no longer exists in Rootbound state.");
    const metadata = await context.threadMetadata({ threadId: rescue.threadId });
    assertThreadInProject(metadata.thread, project);
    const authority = await authorityExecutor.resolveAuthority({ cwd: metadata.thread.cwd, access: "readOnly", timeoutMs: 10_000 });
    if (!authority.trustedAncestor || !samePath(authority.trustedAncestor, project.root)) {
      throw new RootboundToolError("The original Codex thread no longer has exact-root authority matching this rescue project.", {
        code: "CONTINUITY_AUTHORITY_CHANGED",
        category: "permission",
        retryable: false,
        nextActions: ["Restore exact-root trust for the project, then retry the handoff."],
      });
    }
    const pending = continuityState.prepareCheckpoint(rescue.bindingRef);
    if (pending.threadId !== rescue.threadId) throw stateError("RESCUE_BINDING_MISMATCH", "The active rescue binding no longer targets the original Codex thread.");
    const request = { rescueRef: rescue.rescueRef, summary: input.summary, decisions: input.decisions, remainingWork: input.remainingWork };
    const idem = idempotency.begin({ operation: "handoff", key: input.idempotencyKey, request, bindingRef: rescue.bindingRef });
    if (idem.mode === "replay") return { ...idem.result, idempotencyReplayed: true };

    const baseText = buildContinuityCheckpoint({ summary: input.summary, decisions: input.decisions, remainingWork: input.remainingWork, journal: pending.journal });
    const currentRescue = stateStore.getRescueSession(rescue.rescueRef);
    const fingerprint = await rescueManager.assertNoDrift(currentRescue);
    const commits = await commitsSinceBaseline({ authorityExecutor, cwd: project.root, baselineHead: rescue.baselineGit?.head, currentHead: fingerprint.head });
    const quota = await safeQuota(context);
    const mutations = stateStore.listRescueMutations(rescue.rescueRef);
    const manifest = buildContinuityManifest({
      rescue: currentRescue,
      project,
      finalFingerprint: fingerprint,
      commits,
      journal: pending.journal,
      mutations,
      summary: input.summary,
      decisions: input.decisions,
      remainingWork: input.remainingWork,
      quota,
      checkpointText: baseText,
    });
    const text = `${baseText.trimEnd()}${manifestInjectionFooter(manifest)}\n`;
    const injected = await context.injectContinuity({ threadId: rescue.threadId, text });
    const binding = continuityState.acknowledgeCheckpoint(rescue.bindingRef, pending.throughSeq);
    const persistedManifest = persistContinuityManifest({
      store: stateStore,
      manifest,
      projectRef: project.projectRef,
      bindingRef: rescue.bindingRef,
      throughSeq: pending.throughSeq,
    });
    stateStore.recordEvent({
      projectRef: project.projectRef,
      bindingRef: rescue.bindingRef,
      kind: "rescue.manifest.created",
      payload: { rescueRef: rescue.rescueRef, checkpointId: persistedManifest.checkpointId, manifestHash: persistedManifest.manifestHash },
    });
    const ended = rescueManager.handoffComplete(stateStore.getRescueSession(rescue.rescueRef), quota);
    const result = {
      ...injected,
      status: "handoff_ready",
      rescue: rescueManager.publicSession(ended),
      checkpoint: {
        threadId: rescue.threadId,
        journalEntriesIncluded: pending.journal.length,
        injectedChars: text.length,
        bindingCheckpointCount: binding.checkpointCount,
        manifestCheckpointId: persistedManifest.checkpointId,
      },
      manifest: {
        schema: manifest.schema,
        hash: manifest.integrity.hash,
        algorithm: manifest.integrity.algorithm,
        baseline: manifest.verified.baseline,
        result: manifest.verified.result,
        verifiedMutationCount: manifest.verified.mutations.length,
        verifiedActivityCount: manifest.verified.activity.length,
        commitCount: manifest.verified.commits.length,
      },
      activity: pending.journal.slice(0, 200),
      worktree: publicFingerprint(fingerprint),
      commits,
      quota,
      modelTurnStarted: false,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    idempotency.complete({ operation: "handoff", key: input.idempotencyKey, requestHash: idem.requestHash, bindingRef: rescue.bindingRef, result });
    return result;
  }, { operation: "continuity_handoff" }));

  server.registerTool("codex.continuity_rollback", {
    title: "Rollback This Rescue Session",
    description: "Restore only file mutations Rootbound safely snapshotted after the rescue baseline. It refuses external drift, incomplete rollback coverage, sensitive snapshots, and hash conflicts; it never uses git reset.",
    inputSchema: z.object({ rescueRef: rescueRefSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ rescueRef }, ctx) => typedToolResponse(async () => {
    const rescue = requireActiveRescue(rescueManager, { sessionKey: getSessionKey(ctx), rescueRef });
    return rescueManager.rollback(rescue);
  }, { operation: "continuity_rollback" }));

  server.registerTool("codex.continuity_search", {
    title: "Search Original Codex Thread Memory",
    description: "Search visible persisted messages in the original Codex thread on demand as cold memory. Uses the experimental occurrence-search API when available and falls back to bounded item scanning; raw reasoning is never returned.",
    inputSchema: z.object({
      query: z.string().min(1).max(2_048),
      cwd: cwdSchema,
      threadId: threadIdSchema,
      rescueRef: rescueRefSchema,
      cursor: z.string().min(1).max(32_768).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, ctx) => typedToolResponse(async () => {
    let rescue = null;
    let threadId = input.threadId;
    if (!threadId) {
      rescue = rescueManager.activeForRequest({ sessionKey: getSessionKey(ctx), cwd: input.cwd, rescueRef: input.rescueRef });
      threadId = rescue?.threadId ?? null;
    }
    if (!threadId) throw stateError("RESCUE_SESSION_NOT_FOUND", "No active rescue session or explicit threadId is available for continuity search.");
    const metadata = await context.threadMetadata({ threadId });
    const project = rescue ? stateStore.getProject(rescue.projectRef) : await resolveAuthorizedProject({ cwd: metadata.thread.cwd, authorityExecutor, stateStore });
    assertThreadInProject(metadata.thread, project);
    try {
      const result = await context.threadSearchOccurrences({ threadId, query: input.query, cursor: input.cursor, limit: input.limit });
      return { status: "ok", source: "thread/searchOccurrences", thread: publicThread(metadata.thread), result, modelTurnStarted: false };
    } catch (error) {
      const fallback = await fallbackSearchVisibleHistory({ context, threadId, query: input.query, limit: input.limit });
      return { status: "ok", source: fallback.source, thread: publicThread(metadata.thread), matches: fallback.matches, searchedItems: fallback.searchedItems,
        experimentalError: { name: error?.name ?? "Error", message: error?.message ?? String(error) }, modelTurnStarted: false };
    }
  }, { operation: "continuity_search" }));
}

export async function selectContinuationThread({ context, authorityExecutor, project, fingerprint, threadId = null }) {
  if (threadId) {
    const metadata = await context.threadMetadata({ threadId });
    assertThreadInProject(metadata.thread, project);
    const candidate = await scoreCandidate({ authorityExecutor, project, fingerprint, thread: metadata.thread });
    return { status: "ready", thread: metadata.thread, match: candidate.match };
  }

  const exact = await context.threadList({ cwd: project.root, limit: 25, sortKey: "recency_at", sortDirection: "desc", archived: false });
  const broadRows = [];
  let broadCursor = null;
  let containedRows = 0;
  for (let page = 0; page < 20; page += 1) {
    const broad = await context.threadList({ omitCwd: true, cursor: broadCursor ?? undefined, limit: 50, sortKey: "recency_at", sortDirection: "desc", archived: false });
    const pageRows = broad?.data ?? [];
    broadRows.push(...pageRows);
    containedRows += pageRows.filter((row) => typeof row?.cwd === "string" && isPathWithin(project.root, row.cwd) && !samePath(row.cwd, project.root)).length;
    broadCursor = broad?.nextCursor ?? null;
    if (!broadCursor || containedRows >= 25) break;
  }
  const descendantRows = broadRows.filter((row) => typeof row?.cwd === "string" && isPathWithin(project.root, row.cwd) && !samePath(row.cwd, project.root));
  const unknownCwdRows = broadRows.filter((row) => typeof row?.cwd !== "string");
  const rows = dedupeThreads([...(exact?.data ?? []), ...descendantRows, ...unknownCwdRows]);
  const likelyRows = rows.filter((row) => typeof row?.cwd !== "string" || isPathWithin(project.root, row.cwd)).slice(0, 250);
  const metadataRows = await mapLimit(likelyRows, 8, async (row) => {
    try {
      const metadata = await context.threadMetadata({ threadId: row.id });
      if (!isPathWithin(project.root, metadata.thread.cwd)) return null;
      return { ...row, ...metadata.thread, recencyAt: metadata.thread.recencyAt ?? row.recencyAt ?? row.updatedAt ?? row.createdAt ?? 0 };
    } catch { return null; }
  });
  const candidates = [];
  for (const thread of metadataRows.filter(Boolean)) candidates.push(await scoreCandidate({ authorityExecutor, project, fingerprint, thread }));
  candidates.sort((a, b) => b.score - a.score || Number(b.thread.recencyAt ?? 0) - Number(a.thread.recencyAt ?? 0));
  const viable = candidates.filter((candidate) => candidate.score >= 20 && candidate.match.repository !== "mismatch");
  if (!viable.length) return { status: "not_found", match: { confidence: "not_found", reasons: ["No persisted Codex thread matched the authorized repository strongly enough."] } };
  const top = viable[0];
  const second = viable[1] ?? null;
  if (second && isAmbiguous(top, second)) {
    return { status: "ambiguous", candidates: viable.slice(0, 5).map(publicCandidate), match: { confidence: "ambiguous", reasons: ["Multiple recent Codex sessions match this workspace with similar continuity evidence."] } };
  }
  return { status: "ready", thread: top.thread, match: top.match };
}

async function scoreCandidate({ authorityExecutor, project, fingerprint, thread }) {
  const threadCwd = typeof thread.cwd === "string" ? path.resolve(thread.cwd) : null;
  const exactCwd = threadCwd ? samePath(threadCwd, project.root) : false;
  const inside = threadCwd ? isPathWithin(project.root, threadCwd) : false;
  const currentOrigin = normalizeOrigin(fingerprint.origin);
  const threadOrigin = normalizeOrigin(thread.gitInfo?.originUrl ?? thread.gitInfo?.origin ?? null);
  const repository = currentOrigin && threadOrigin ? (currentOrigin === threadOrigin ? "same" : "mismatch") : inside ? "same_by_root" : "unknown";
  const currentBranch = fingerprint.branch ?? null;
  const threadBranch = thread.gitInfo?.branch ?? null;
  const branch = currentBranch && threadBranch ? (currentBranch === threadBranch ? "same" : "different") : "unknown";
  const currentHead = fingerprint.head ?? null;
  const threadSha = thread.gitInfo?.sha ?? null;
  let sha = currentHead && threadSha ? (currentHead === threadSha ? "exact" : "different") : "unknown";
  if (sha === "different" && repository !== "mismatch") {
    const ancestor = await isAncestorSha({ authorityExecutor, cwd: project.root, ancestor: threadSha, descendant: currentHead });
    if (ancestor === true) sha = "ancestor";
  }
  let score = 0;
  if (exactCwd) score += 30; else if (inside) score += 20;
  if (repository === "same") score += 35; else if (repository === "same_by_root") score += 20; else if (repository === "mismatch") score -= 100;
  if (branch === "same") score += 20; else if (branch === "different") score -= 10;
  if (sha === "exact") score += 30; else if (sha === "ancestor") score += 15;
  const confidence = repository !== "mismatch" && inside && sha === "exact" && branch !== "different"
    ? "exact"
    : repository !== "mismatch" && inside && (branch === "same" || sha === "ancestor" || exactCwd)
      ? "compatible"
      : "not_found";
  const reasons = [];
  reasons.push(exactCwd ? "thread cwd exactly matches the canonical project root" : inside ? "thread cwd is inside the canonical Git root" : "thread cwd does not match the project");
  if (repository === "same") reasons.push("repository origin matches");
  if (branch === "same") reasons.push("branch matches"); else if (branch === "different") reasons.push("branch differs");
  if (sha === "exact") reasons.push("Git SHA matches exactly"); else if (sha === "ancestor") reasons.push("thread SHA is an ancestor of current HEAD"); else if (sha === "different") reasons.push("Git SHA diverged or moved");
  return { thread, score, match: { confidence, score, cwd: exactCwd ? "exact" : inside ? "contained" : "mismatch", repository, branch, sha, reasons } };
}

function isAmbiguous(first, second) {
  if (first.match.confidence !== second.match.confidence) return false;
  if (Math.abs(first.score - second.score) > 5) return false;
  const a = Number(first.thread.recencyAt ?? first.thread.updatedAt ?? 0);
  const b = Number(second.thread.recencyAt ?? second.thread.updatedAt ?? 0);
  return Math.abs(a - b) <= 600;
}

async function resolveAuthorizedProject({ cwd, authorityExecutor, stateStore }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd: cwd ?? null, access: "readOnly", timeoutMs: 10_000 });
  if (!authority?.effectiveCwd) {
    throw new RootboundToolError("Rootbound continuity could not resolve an authorized project scope.", {
      code: "PROJECT_SCOPE_UNAVAILABLE",
      category: "state",
      retryable: false,
      nextActions: ["Call codex.workspace_list, then retry codex.continuity_resume with the intended project cwd."],
    });
  }
  const resolved = await resolveProjectRoot(authority.effectiveCwd);
  if (!authority.trustedAncestor || !samePath(authority.trustedAncestor, resolved.root)) {
    throw new RootboundToolError(`Rootbound continuity requires exact-root Codex trust for ${resolved.root}.`, {
      code: "EXACT_ROOT_TRUST_REQUIRED", category: "permission", retryable: false,
      nextActions: [`Trust the canonical workspace root exactly: ${resolved.root}`, "Then retry codex.continuity_resume."],
    });
  }
  return registerProject(stateStore, resolved.root, { trusted: true });
}

function assertThreadInProject(thread, project) {
  if (!thread?.cwd || !isPathWithin(project.root, thread.cwd)) {
    throw new RootboundToolError("The selected Codex thread does not belong to the authorized project root.", {
      code: "CONTINUITY_THREAD_PROJECT_MISMATCH", category: "permission", retryable: false,
      nextActions: ["Choose a persisted thread whose cwd is inside the authorized Git root."],
    });
  }
}

function requireActiveRescue(rescueManager, { sessionKey, rescueRef }) {
  const rescue = rescueManager.activeForRequest({ sessionKey, rescueRef });
  if (!rescue) throw stateError("RESCUE_SESSION_NOT_FOUND", "No active Rootbound rescue session is available for this request.");
  return rescue;
}

async function safeQuota(context) {
  try { return await context.quotaSnapshot(); }
  catch (error) { return { status: "unavailable", observedAt: new Date().toISOString(), codex: { availability: "unknown", exhausted: false, resetsAt: null, limits: [] }, error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } }; }
}

async function commitsSinceBaseline({ authorityExecutor, cwd, baselineHead, currentHead }) {
  if (!baselineHead || !currentHead || baselineHead === currentHead) return [];
  const result = await authorityExecutor.exec({ command: ["git", "log", "--format=%H%x09%s", `${baselineHead}..${currentHead}`, "--max-count=50"], cwd, access: "readOnly", timeoutMs: 10_000 });
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [sha, ...rest] = line.split("\t"); return { sha, subject: rest.join("\t").slice(0, 500) }; });
}

async function fallbackSearchVisibleHistory({ context, threadId, query, limit }) {
  const needle = query.toLowerCase();
  let cursor = null;
  let searchedItems = 0;
  const matches = [];
  try {
    for (let page = 0; page < 5 && matches.length < limit; page += 1) {
      const result = await context.threadItems({ threadId, cursor, limit: 100, sortDirection: "desc" });
      const payload = result?.items ?? {};
      const items = Array.isArray(payload?.data) ? payload.data : [];
      for (const item of items) {
        searchedItems += 1;
        const text = collectVisibleText(item);
        if (text.toLowerCase().includes(needle)) matches.push(compactValue(item, 0));
        if (matches.length >= limit) break;
      }
      cursor = payload?.nextCursor ?? null;
      if (!cursor) break;
    }
    return { source: "thread/items/list-fallback", matches, searchedItems };
  } catch {
    cursor = null;
    searchedItems = 0;
    matches.length = 0;
  }

  for (let page = 0; page < 8 && matches.length < limit; page += 1) {
    const result = await context.threadRead({ threadId, cursor, limit: 50, sortDirection: "desc" });
    const payload = result?.turns ?? {};
    const turns = Array.isArray(payload?.data) ? payload.data : [];
    for (const turn of turns) {
      searchedItems += 1;
      const text = collectVisibleText(turn);
      if (text.toLowerCase().includes(needle)) matches.push(compactValue(turn, 0));
      if (matches.length >= limit) break;
    }
    cursor = payload?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { source: "thread/turns/list-fallback", matches, searchedItems };
}

function projectBoundedHistory(read) {
  const turnsPayload = read?.turns ?? {};
  const turns = Array.isArray(turnsPayload?.data) ? turnsPayload.data : [];
  const projected = [];
  let budget = 28_000;
  for (const turn of turns.slice(0, 8)) {
    const compact = compactValue(turn, 0);
    const size = JSON.stringify(compact).length;
    if (size > budget && projected.length) break;
    projected.push(compact);
    budget -= Math.min(size, budget);
  }
  return { recentConversation: projected, returnedTurns: projected.length, nextCursor: turnsPayload?.nextCursor ?? null, bounded: true };
}

function compactValue(value, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 1_999)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[bounded]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => compactValue(entry, depth + 1));
  if (typeof value !== "object") return String(value);
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 30)) output[key] = compactValue(child, depth + 1);
  return output;
}

function collectVisibleText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(collectVisibleText).join("\n");
  return Object.entries(value).filter(([key]) => !/reasoning|encrypted|raw/i.test(key)).map(([, child]) => collectVisibleText(child)).join("\n");
}

function publicCandidate(candidate) { return { thread: publicThread(candidate.thread), match: candidate.match }; }
function publicThread(thread) { return { id: thread?.id ?? null, preview: thread?.preview ?? null, cwd: thread?.cwd ?? null, createdAt: thread?.createdAt ?? null, updatedAt: thread?.updatedAt ?? null, recencyAt: thread?.recencyAt ?? null, gitInfo: thread?.gitInfo ? { sha: thread.gitInfo.sha ?? null, branch: thread.gitInfo.branch ?? null, originUrl: thread.gitInfo.originUrl ?? null } : null }; }
function publicProject(project) { return { projectRef: project.projectRef, root: project.root, gitRoot: project.gitRoot, name: project.name, trusted: project.trusted }; }
function dedupeThreads(rows) { const seen = new Set(); return rows.filter((row) => row?.id && !seen.has(row.id) && seen.add(row.id)); }
async function mapLimit(values, limit, mapper) { const output = new Array(values.length); let index = 0; async function worker() { while (true) { const current = index++; if (current >= values.length) return; output[current] = await mapper(values[current], current); } } await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker)); return output; }
async function isAncestorSha({ authorityExecutor, cwd, ancestor, descendant }) { if (!ancestor || !descendant) return null; const result = await authorityExecutor.exec({ command: ["git", "merge-base", "--is-ancestor", ancestor, descendant], cwd, access: "readOnly", timeoutMs: 5_000 }); return result.exitCode === 0 ? true : result.exitCode === 1 ? false : null; }
function normalizeOrigin(value) { if (typeof value !== "string" || !value.trim()) return null; let out = value.trim().replace(/\\/g, "/").replace(/\.git$/i, ""); out = out.replace(/^ssh:\/\//i, "").replace(/^https?:\/\//i, "").replace(/^git@/i, ""); out = out.replace(/^([^/]+):(?=[^/])/, "$1/"); out = out.replace(/^[^@/]+@/, ""); return out.replace(/\/+$/, "").toLowerCase(); }
function samePath(left, right) { const a = path.resolve(left); const b = path.resolve(right); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function isPathWithin(root, target) { if (typeof target !== "string" || !target) return false; const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function stateError(code, message) { return new RootboundToolError(message, { code, category: "state", retryable: false }); }
