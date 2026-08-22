import { resolveProjectScope } from "./project-scope.mjs";

export function createConnectionScopedAuthorityExecutor({ base, store, projectAccessProvider }) {
  if (!base || !store || typeof projectAccessProvider !== "function") throw new Error("connection-scoped authority requires base, store, and projectAccessProvider");
  return {
    get codexVersion() { return base.codexVersion; },
    get defaultCwd() {
      const projects = store.listProjects();
      if (projects.length <= 1) return base.defaultCwd ?? null;
      return resolveProjectScope({ projects, allowedProjectRefs: projects.map((project) => project.projectRef) }).cwd;
    },
    get profileOverride() { return base.profileOverride ?? null; },
    validate(...args) { return base.validate(...args); },
    async resolveAuthority(input = {}) {
      const cwd = await resolveScopedCwd({ cwd: input.cwd ?? null, store, projectAccessProvider });
      return base.resolveAuthority({ ...input, cwd });
    },
    async exec(input = {}) {
      const cwd = await resolveScopedCwd({ cwd: input.cwd ?? null, store, projectAccessProvider });
      return base.exec({ ...input, cwd });
    },
  };
}

export function createConnectionScopedPublicContext({ base, store, projectAccessProvider }) {
  if (!base || !store || typeof projectAccessProvider !== "function") throw new Error("connection-scoped public context requires base, store, and projectAccessProvider");
  const scope = async (input = {}) => ({ ...input, cwd: await resolveScopedCwd({ cwd: input.cwd ?? null, store, projectAccessProvider }) });
  return {
    get generation() { return base.generation; },
    get running() { return base.running; },
    start(...args) { return base.start(...args); },
    close(...args) { return base.close(...args); },
    async projectContext(input = {}) { return base.projectContext(await scope(input)); },
    async skillList(input = {}) { return base.skillList(await scope(input)); },
    async skillRead(input = {}) { return base.skillRead(await scope(input)); },
    async threadList(input = {}) {
      if (input.omitCwd === true) return base.threadList(input);
      return base.threadList(await scope(input));
    },
    threadMetadata(input) { return base.threadMetadata(input); },
    threadRead(input) { return base.threadRead(input); },
    threadItems(input) { return base.threadItems(input); },
    threadSearchOccurrences(input) { return base.threadSearchOccurrences(input); },
    quotaSnapshot(...args) { return base.quotaSnapshot(...args); },
    injectContinuity(input) { return base.injectContinuity(input); },
    async browserPrerequisites(input = {}) { return base.browserPrerequisites(await scope(input)); },
    async nodeReplCall(input = {}) { return base.nodeReplCall(await scope(input)); },
  };
}

export function createConnectionScopedBrowserReader({ base, store, projectAccessProvider }) {
  if (!base || !store || typeof projectAccessProvider !== "function") throw new Error("connection-scoped browser reader requires base, store, and projectAccessProvider");
  const scopedInput = async (input = {}) => ({ ...input, cwd: await resolveScopedCwd({ cwd: input.cwd ?? null, store, projectAccessProvider }) });
  return {
    async status(input = {}) { return base.status(await scopedInput(input)); },
    async listTabs(input = {}) { return base.listTabs(await scopedInput(input)); },
    async readTab(input = {}) { return base.readTab(await scopedInput(input)); },
  };
}

export async function resolveScopedCwd({ cwd = null, store, projectAccessProvider }) {
  if (!store || typeof projectAccessProvider !== "function") throw new Error("scoped cwd resolution requires store and projectAccessProvider");
  const access = await projectAccessProvider();
  if (access?.enforced !== true) return cwd;
  return resolveProjectScope({ projects: store.listProjects(), allowedProjectRefs: access.projectRefs ?? [], cwd }).cwd;
}
