import { normalizeToolError } from "./tool-errors.mjs";

const IMPLICIT_SCOPE_GUARDED_TOOLS = new Set([
  "codex.command_exec",
  "codex.command_start",
  "codex.repo_search",
  "codex.git_status",
  "codex.git_diff",
  "codex.apply_patch",
  "codex.read_many",
  "codex.precise_edit",
]);

export function hasStrongProjectScope(args = {}) {
  return hasText(args?.cwd) || hasText(args?.bindingRef) || hasText(args?.rescueRef);
}

export function requiresImplicitProjectScopeGuard(toolName, args = {}) {
  return IMPLICIT_SCOPE_GUARDED_TOOLS.has(toolName) && !hasStrongProjectScope(args);
}

export function createProjectToolScopeGuard({ authorityExecutor } = {}) {
  if (!authorityExecutor || typeof authorityExecutor.resolveAuthority !== "function") {
    throw new Error("project tool scope guard requires authorityExecutor.resolveAuthority");
  }
  return async function guardProjectToolScope(toolName, args = {}) {
    if (!requiresImplicitProjectScopeGuard(toolName, args)) return null;
    return authorityExecutor.resolveAuthority({ cwd: null, access: "readOnly", timeoutMs: 10_000 });
  };
}

export function createProjectScopeGuardedServer(server, { guardProjectToolScope } = {}) {
  if (!server || typeof server.registerTool !== "function") throw new Error("project scope guarded server requires registerTool");
  if (typeof guardProjectToolScope !== "function") throw new Error("project scope guarded server requires guardProjectToolScope");
  return {
    registerTool(name, definition, handler) {
      server.registerTool(name, definition, async (args, ctx) => {
        try {
          await guardProjectToolScope(name, args ?? {});
        } catch (error) {
          const payload = normalizeToolError(error, { operation: operationName(name) });
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          };
        }
        return handler(args, ctx);
      });
    },
  };
}

function operationName(toolName) {
  return typeof toolName === "string" && toolName.startsWith("codex.") ? toolName.slice("codex.".length) : toolName;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
