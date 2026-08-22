# Rootbound — 中文说明

> **V5 架构文档仍在同步；当前公开 MCP surface 已升级到 V6。**
>
> 为避免翻译文档落后于真实实现，在完整中文文档更新完成之前，请以英文 [`README.md`](README.md)、[`SECURITY.md`](SECURITY.md) 和 [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md) 为准。

## 当前核心状态

- ChatGPT 作为推理层；Rootbound 只暴露经过接受和验证的 model-free 本地能力。
- 当前公开 surface：`rootbound-public-preview-v6`。
- 当前公开工具数：33。
- 新增 `codex.workspace_list`，用于列出当前 Rootbound connection 明确允许访问的项目。
- 一个 active connection 使用一个 supervised runtime，但这个 runtime 可以同时服务多个已授权 workspace。
- `rootbound connect .` 会验证 exact-root trust，并把该项目授予当前 connection；连接第二个项目不会再为了“切项目”而重启 runtime。
- runtime anchor 只用于启动/恢复 runtime，不是 ChatGPT 的隐式“当前项目”。
- 当多个 workspace 可用而请求没有安全 scope 时，Rootbound 返回 `PROJECT_SCOPE_REQUIRED`，不会猜测项目。
- 不同 saved connections 使用独立的 project allowlist，不会自动共享项目授权。
- 不再把 Codex Agent / Task Card / model routing 作为公开 surface。
- 本地状态和 continuity 元数据持久化；长命令支持 `start / poll / write / terminate`。
- `workspace_open` 会按 `projectRef` / `cwd` 重新验证项目 authority。
- `repo_search` / `read_many` 支持分页；`precise_edit` 支持 SHA-guarded undo / redo。
- continuity binding / checkpoint 支持持久化和幂等 retry。
- diagnostics 会对路径和凭据进行脱敏，并且不会导出命令 stdout / stderr 或 thread preview。

## 安装要求

- Node.js >= 22.13.0
- 本机已有受支持的 Codex 安装
- 当前公开 Technical Preview：Apple Silicon macOS
- Windows 代码仍在仓库中，但尚未通过公开 release 所需的真实机器验收

## 日常 CLI

```text
rootbound connect .
rootbound status
rootbound connection current
rootbound project list
rootbound self-test .
rootbound logs
rootbound diagnostic
rootbound stop
rootbound upgrade --from <release-dir>
```

## 多项目使用

对每个希望暴露给当前 connection 的项目执行一次：

```text
cd /path/to/project-a
rootbound connect .

cd /path/to/project-b
rootbound connect .
```

随后 ChatGPT 可以通过 `codex.workspace_list` 查看允许的 workspace，并使用明确的 `projectRef` / `cwd` 在不同项目之间工作，无需再次在终端切换 Rootbound runtime。

详细功能、安装、security boundary、multi-project lifecycle 和 release checklist 请查看：

- [`README.md`](README.md)
- [`SECURITY.md`](SECURITY.md)
- [`docs/multi-project-runtime.md`](docs/multi-project-runtime.md)
- [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md)
