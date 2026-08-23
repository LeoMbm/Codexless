import path from "node:path";
import { createRequire } from "node:module";

export const DEFAULT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_MAX_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const ALLOWED_MIME_PREFIXES = ["image/", "text/", "audio/", "video/"];
const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/json",
  "application/zip",
  "application/octet-stream",
  "application/vnd.apple.installer+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function registerAssetTools(server, { authorityExecutor, continuityState = null, rescueManager = null, getSessionKey = null }) {
  if (!server || typeof server.registerTool !== "function" || !authorityExecutor) return;
  const require = createRequire(import.meta.url);
  const z = require("zod/v4");
  const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();
  const rescueRefSchema = z.string().regex(/^rescue_[0-9a-f-]{36}$/i).optional();

  server.registerTool("codex.asset_import", {
    title: "Import ChatGPT Asset Into Project",
    description: "Import one ChatGPT-provided file into the selected authorized workspace. The asset parameter is a ChatGPT file slot; Rootbound validates the OpenAI download host, MIME/size limits, workspace-relative destination, symlink boundaries, overwrite policy, and performs an atomic sandboxed write. No Codex model turn is started.",
    inputSchema: z.object({
      asset: z.any().describe("ChatGPT file parameter. Do not fabricate this object or pass an arbitrary URL/path."),
      destination: z.string().min(1).max(32_768).describe("Workspace-relative destination path, for example public/blog/cover.png."),
      cwd: z.string().min(1).max(32_768).optional(),
      overwrite: z.boolean().default(false),
      maxBytes: z.number().int().min(1).max(MAX_ASSET_MAX_BYTES).default(DEFAULT_ASSET_MAX_BYTES),
      expectedMimeType: z.string().min(1).max(255).optional(),
      rescueRef: rescueRefSchema,
      bindingRef: bindingRefSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["asset"] },
  }, async ({ bindingRef, rescueRef, ...input }, ctx) => {
    try {
      const resolved = rescueManager && getSessionKey
        ? rescueManager.resolveBinding({ sessionKey: getSessionKey(ctx), cwd: input.cwd, explicitBindingRef: bindingRef, rescueRef })
        : { bindingRef: bindingRef ?? null, rescue: null, implicit: false };
      if (resolved.rescue) await rescueManager.assertNoDrift(resolved.rescue);
      const scoped = resolved.bindingRef && continuityState ? continuityState.assertCwd(resolved.bindingRef, input.cwd) : null;
      const effectiveCwd = scoped?.targetCwd ?? input.cwd ?? resolved.rescue?.projectRoot;
      const result = await importChatGptAsset({ authorityExecutor, ...input, cwd: effectiveCwd });
      if (resolved.bindingRef && continuityState) {
        continuityState.record(resolved.bindingRef, { kind: "asset_import", path: result.path, cwd: result.cwd, status: "applied", bytes: result.bytes, sha256: result.sha256 });
      }
      let updatedRescue = resolved.rescue;
      if (resolved.rescue) {
        updatedRescue = await rescueManager.refreshExpected(resolved.rescue, { rollbackSafe: false, reason: "asset_import_write" });
      }
      const payload = {
        ...result,
        ...(resolved.bindingRef ? { continuityJournaled: true } : {}),
        ...(resolved.implicit && updatedRescue ? { rescueSession: rescueManager.publicSession(updatedRescue) } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
    } catch (error) {
      const payload = normalizeAssetToolError(error);
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
    }
  });
}

function normalizeAssetToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    operation: "asset_import",
    code: typeof error?.code === "string" ? error.code : "ASSET_IMPORT_FAILED",
    category: typeof error?.category === "string" ? error.category : "validation",
    retryable: error?.retryable === true,
    message,
    ...(Array.isArray(error?.nextActions) ? { nextActions: error.nextActions } : {}),
    modelTurnStarted: false,
  };
}

export async function importChatGptAsset({
  authorityExecutor,
  asset,
  destination,
  cwd,
  overwrite = false,
  maxBytes = DEFAULT_ASSET_MAX_BYTES,
  expectedMimeType = null,
}) {
  if (!authorityExecutor || typeof authorityExecutor.exec !== "function" || typeof authorityExecutor.resolveAuthority !== "function") {
    throw new Error("asset_import requires authorityExecutor resolveAuthority/exec");
  }
  const normalizedAsset = normalizeAsset(asset);
  const normalizedDestination = normalizeDestination(destination);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ASSET_MAX_BYTES) {
    throw new Error(`maxBytes must be an integer between 1 and ${MAX_ASSET_MAX_BYTES}`);
  }
  if (expectedMimeType !== null && !isAllowedMimeType(expectedMimeType)) throw new Error(`unsupported expectedMimeType: ${expectedMimeType}`);
  if (normalizedAsset.mimeType && !isAllowedMimeType(normalizedAsset.mimeType)) throw new Error(`unsupported asset mime_type: ${normalizedAsset.mimeType}`);
  if (expectedMimeType && normalizedAsset.mimeType && expectedMimeType !== normalizedAsset.mimeType) {
    throw new Error(`asset mime_type mismatch: expected ${expectedMimeType}, received ${normalizedAsset.mimeType}`);
  }
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit", timeoutMs: 10_000 });
  if (authority.permissionProfile === ":read-only") {
    const error = new Error("asset_import requires a write-capable authorized workspace profile");
    error.code = "PERMISSION_APPROVAL_REQUIRED";
    error.category = "permission";
    error.retryable = false;
    throw error;
  }
  const payload = Buffer.from(JSON.stringify({
    downloadUrl: normalizedAsset.downloadUrl,
    destination: normalizedDestination,
    overwrite,
    maxBytes,
    expectedMimeType: expectedMimeType ?? normalizedAsset.mimeType ?? null,
  }), "utf8").toString("base64");
  const result = await authorityExecutor.exec({
    command: [process.execPath, "-e", ASSET_IMPORT_SCRIPT, payload],
    cwd: authority.effectiveCwd ?? cwd,
    access: "inherit",
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const error = new Error(sanitizeImportError(result.stderr || result.stdout || `asset import failed with exit code ${result.exitCode}`));
    error.code = assetImportErrorCode(result.exitCode);
    error.category = result.exitCode === 23 ? "conflict" : "validation";
    error.retryable = result.exitCode === 28;
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(String(result.stdout ?? "").trim()); }
  catch { throw new Error("asset_import returned an invalid sandbox result"); }
  if (!parsed || parsed.status !== "ok" || typeof parsed.path !== "string" || typeof parsed.sha256 !== "string") {
    throw new Error("asset_import returned an incomplete sandbox result");
  }
  return {
    status: "ok",
    path: parsed.path,
    relativePath: normalizedDestination,
    bytes: parsed.bytes,
    sha256: parsed.sha256,
    mimeType: parsed.mimeType ?? normalizedAsset.mimeType ?? null,
    fileId: normalizedAsset.fileId,
    fileName: normalizedAsset.fileName,
    created: parsed.created === true,
    overwritten: parsed.overwritten === true,
    cwd: result.effectiveCwd ?? authority.effectiveCwd ?? cwd,
    permissionProfile: result.permissionProfile ?? authority.permissionProfile,
    permissionCeiling: result.permissionCeiling ?? authority.permissionCeiling,
    authoritySource: result.authoritySource ?? authority.authoritySource,
    trustedAncestor: result.trustedAncestor ?? authority.trustedAncestor,
    modelTurnStarted: false,
  };
}

export function normalizeAsset(asset) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new Error("asset must be a ChatGPT file parameter object");
  const downloadUrl = stringField(asset.download_url, "asset.download_url");
  const fileId = stringField(asset.file_id, "asset.file_id");
  let url;
  try { url = new URL(downloadUrl); }
  catch { throw new Error("asset.download_url must be a valid URL"); }
  if (url.protocol !== "https:") throw new Error("asset.download_url must use HTTPS");
  if (!isTrustedOpenAiFileHost(url.hostname)) throw new Error("asset.download_url host is not an approved ChatGPT file host");
  if (url.username || url.password) throw new Error("asset.download_url must not contain URL credentials");
  const mimeType = optionalString(asset.mime_type ?? asset.mimeType);
  const fileName = optionalString(asset.file_name ?? asset.fileName ?? asset.name);
  const size = Number.isSafeInteger(asset.size) && asset.size >= 0 ? asset.size : null;
  return { downloadUrl: url.toString(), fileId, mimeType, fileName, size };
}

export function normalizeDestination(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("destination must be a non-empty workspace-relative path");
  if (value.includes("\0")) throw new Error("destination contains a NUL byte");
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error("destination must stay inside the selected workspace");
  }
  if (/^[A-Za-z]:\//.test(normalized)) throw new Error("destination must be workspace-relative");
  return normalized;
}

export function isTrustedOpenAiFileHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  return host === "files.oaiusercontent.com" || host.endsWith(".files.oaiusercontent.com");
}

export function isAllowedMimeType(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return ALLOWED_MIME_EXACT.has(mime) || ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function stringField(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
function optionalString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function sanitizeImportError(value) {
  return String(value ?? "asset import failed").replace(/https:\/\/[^\s]+/g, "[redacted-download-url]").slice(0, 4000).trim();
}
function assetImportErrorCode(exitCode) {
  if (exitCode === 22) return "ASSET_TOO_LARGE";
  if (exitCode === 23) return "ASSET_DESTINATION_EXISTS";
  if (exitCode === 24) return "ASSET_DESTINATION_INVALID";
  if (exitCode === 25) return "ASSET_MIME_MISMATCH";
  if (exitCode === 26) return "ASSET_DOWNLOAD_REJECTED";
  if (exitCode === 27) return "ASSET_WRITE_FAILED";
  if (exitCode === 28) return "ASSET_DOWNLOAD_FAILED";
  return "ASSET_IMPORT_FAILED";
}

export const ASSET_IMPORT_SCRIPT = String.raw`
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
(async()=>{
  const cfg=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
  const root=await fsp.realpath(process.cwd());
  const destination=String(cfg.destination||'');
  const target=path.resolve(root,destination);
  const rel=path.relative(root,target);
  if(!destination||rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)){console.error('destination escapes workspace');process.exit(24);}
  const parent=path.dirname(target);
  await fsp.mkdir(parent,{recursive:true});
  const canonicalParent=await fsp.realpath(parent);
  const parentRel=path.relative(root,canonicalParent);
  if(parentRel==='..'||parentRel.startsWith('..'+path.sep)||path.isAbsolute(parentRel)){console.error('destination parent resolves outside workspace');process.exit(24);}
  let existing=null;
  try{existing=await fsp.lstat(target);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing&&existing.isSymbolicLink()){console.error('destination symlink refused');process.exit(24);}
  if(existing&&!cfg.overwrite){console.error('destination already exists');process.exit(23);}
  if(existing&&!existing.isFile()){console.error('destination is not a regular file');process.exit(24);}
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),25000);
  let response;
  try{response=await fetch(cfg.downloadUrl,{redirect:'error',signal:controller.signal,headers:{'user-agent':'Rootbound/asset-import'}});}catch(e){clearTimeout(timer);console.error('asset download failed');process.exit(28);}
  clearTimeout(timer);
  if(!response.ok){console.error('asset download rejected: HTTP '+response.status);process.exit(26);}
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>cfg.maxBytes){console.error('asset exceeds maxBytes');process.exit(22);}
  const mime=(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase()||null;
  if(cfg.expectedMimeType&&mime&&cfg.expectedMimeType.toLowerCase()!==mime){console.error('downloaded asset MIME mismatch');process.exit(25);}
  const temp=path.join(parent,'.rootbound-asset-'+crypto.randomUUID()+'.tmp');
  let bytes=0;
  const hash=crypto.createHash('sha256');
  try{
    const source=Readable.fromWeb(response.body);
    source.on('data',(chunk)=>{bytes+=chunk.length;if(bytes>cfg.maxBytes)source.destroy(new Error('asset exceeds maxBytes'));else hash.update(chunk);});
    await pipeline(source,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
    if(bytes>cfg.maxBytes){await fsp.rm(temp,{force:true});console.error('asset exceeds maxBytes');process.exit(22);}
    if(existing&&cfg.overwrite)await fsp.rm(target,{force:false});
    await fsp.rename(temp,target);
    await fsp.chmod(target,0o644).catch(()=>{});
  }catch(e){await fsp.rm(temp,{force:true}).catch(()=>{});if(/maxBytes/.test(String(e&&e.message))){console.error('asset exceeds maxBytes');process.exit(22);}console.error('asset write failed');process.exit(27);}
  const canonicalTarget=await fsp.realpath(target);
  const finalRel=path.relative(root,canonicalTarget);
  if(finalRel==='..'||finalRel.startsWith('..'+path.sep)||path.isAbsolute(finalRel)){await fsp.rm(target,{force:true}).catch(()=>{});console.error('written destination resolves outside workspace');process.exit(24);}
  process.stdout.write(JSON.stringify({status:'ok',path:canonicalTarget,bytes,sha256:hash.digest('hex'),mimeType:mime,created:!existing,overwritten:Boolean(existing&&cfg.overwrite)}));
})().catch(()=>{console.error('asset import failed');process.exit(27);});
`;
