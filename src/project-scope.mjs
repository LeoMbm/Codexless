import { realpathSync } from "node:fs";
import path from "node:path";
import { RootboundToolError } from "./tool-errors.mjs";

export function resolveProjectScope({ projects = [], allowedProjectRefs = [], cwd = null, projectRef = null } = {}) {
  if (!Array.isArray(projects)) throw new Error("project scope resolver requires projects array");
  if (!Array.isArray(allowedProjectRefs)) throw new Error("project scope resolver requires allowedProjectRefs array");
  const allowed = new Set(allowedProjectRefs);
  const visible = projects.filter((project) => project?.projectRef && project?.root && allowed.has(project.projectRef));
  const requestedProject = projectRef ? projects.find((project) => project?.projectRef === projectRef) ?? null : null;

  if (projectRef && !requestedProject) {
    throw scopeError("PROJECT_NOT_FOUND", `Rootbound project is not registered: ${projectRef}`, ["Call codex.workspace_list and use one returned projectRef."]);
  }
  if (requestedProject && !allowed.has(requestedProject.projectRef)) {
    throw scopeError("PROJECT_NOT_ALLOWED_FOR_CONNECTION", `Project ${requestedProject.projectRef} is not allowed for this Rootbound connection.`, ["Run rootbound connect from that project while this connection is active, then retry."]);
  }

  if (requestedProject) {
    const targetCwd = resolveTargetCwd(requestedProject.root, cwd);
    if (!isPathWithin(requestedProject.root, targetCwd)) {
      throw scopeError("PROJECT_SCOPE_MISMATCH", `Requested cwd is outside project ${requestedProject.projectRef}.`, ["Use a cwd inside the selected project or select the matching projectRef."], { projectRef: requestedProject.projectRef });
    }
    return scopedResult(requestedProject, targetCwd, "projectRef");
  }

  if (cwd) {
    if (!path.isAbsolute(cwd)) {
      if (visible.length === 1) {
        const only = visible[0];
        const targetCwd = resolveTargetCwd(only.root, cwd);
        if (!isPathWithin(only.root, targetCwd)) throw scopeError("PROJECT_SCOPE_MISMATCH", "Relative cwd escapes the only allowed project.");
        return scopedResult(only, targetCwd, "single-project-relative-cwd");
      }
      throw scopeRequired(visible);
    }
    const target = canonicalPath(cwd);
    const candidates = projects.filter((project) => project?.root && isPathWithin(project.root, target)).sort((a, b) => canonicalPath(b.root).length - canonicalPath(a.root).length);
    const matched = candidates[0] ?? null;
    if (!matched) {
      throw scopeError("PROJECT_NOT_FOUND", `No registered Rootbound project contains cwd ${target}.`, ["Run rootbound connect from that project, then retry."]);
    }
    if (!allowed.has(matched.projectRef)) {
      throw scopeError("PROJECT_NOT_ALLOWED_FOR_CONNECTION", `Project ${matched.projectRef} is not allowed for this Rootbound connection.`, ["Run rootbound connect from that project while this connection is active, then retry."], { projectRef: matched.projectRef });
    }
    return scopedResult(matched, target, "cwd");
  }

  if (visible.length === 1) return scopedResult(visible[0], canonicalPath(visible[0].root), "single-project-fallback");
  if (visible.length === 0) {
    throw scopeError("PROJECT_SCOPE_UNAVAILABLE", "This Rootbound connection has no available project workspace.", ["Run rootbound connect . from a trusted project while this connection is active."]);
  }
  throw scopeRequired(visible);
}

export function isPathWithin(root, target) {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(target);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveTargetCwd(root, cwd) {
  if (!cwd) return canonicalPath(root);
  return canonicalPath(path.isAbsolute(cwd) ? cwd : path.resolve(root, cwd));
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}

function scopedResult(project, targetCwd, source) {
  return { project, projectRef: project.projectRef, projectRoot: canonicalPath(project.root), cwd: targetCwd, source };
}

function scopeRequired(projects) {
  return scopeError("PROJECT_SCOPE_REQUIRED", "Multiple Rootbound workspaces are available; an explicit project scope is required.", ["Call codex.workspace_list, then retry with projectRef or an absolute cwd."], { candidates: projects.map((project) => ({ projectRef: project.projectRef, name: project.name ?? null })) });
}

function scopeError(code, message, nextActions = [], details = null) {
  return new RootboundToolError(message, { code, category: "state", retryable: false, nextActions, details });
}
