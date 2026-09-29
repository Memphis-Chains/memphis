## memphis-collective 集成方案 —— 供维护者 PR 使用并附 attribution

> **作者:** @Memphis-Chains (Wodzu / Marcin Kukla,波兰)
> **代码所在仓库:** https://github.com/Memphis-Chains/minimax-code
> **分支 / 提交:** `c32c23f`(已 rebase 在您们当前的 `main` 上)
> **类别:** 扩展建议、可选插件式补充

## 简要

我们写了一个小扩展包 `@mavis/memphis-collective`,已经推到一个公开的 fork。MIT 协议,与您们当前的 main 一致,16/16 测试通过,接入到您们现有架构 ——除了新增软件包注册所必需的注入点之外,不修改您们任何文件。Diff 22 个文件,1,521 行新增,1 行删除。

我们正是按您在 #362 中描述的路径来做的 —— 在这里开 issue,review 留给你们,如果接受,由你们准备维护者 PR 并附 attribution。除此之外没有任何其他要求。

## `@mavis/memphis-collective` 功能

- 服务启动时读取 `~/.memphis/chains/collective/*.json`(对现有 chain-block 格式做严格结构扫描)
- 用 `fs.watch` 监听目录(100ms 防抖 + microtask 间隔),变化时重新加载
- 把最近 N 条 block (默认 20) 渲染为 `<memphis-collective>...</memphis-collective>` 系统提示块,与 `@mavis/system-reminder` 完全兼容
- 提供 `memphis_collective_append` 工具,带正确的 `prev_hash` linkage,匹配您们 `serde_json` canonical 格式
- 使用 atomic rename + `.napi-append.lock` 保证与源运行时没有竞态

## 为什么想让它进入上游

- Memphis 目前有 chain-backed 内存(7+ 条 chain:`journal`、`decisions`、`system`、`reflections`、`cases`、`collective`、`patterns`),agent runtime 决定往哪里写。同主机上的其他 agent 没有发现路径。我们的扩展让 `collective` chain 作为 live context 可被发现。
- 波兰 + EU 的运营方(在监管推动本地优先 + 可审计 agent 内存的环境下)会受益于通过 `mcode plugin add` 安装 `@mavis/memphis-collective`。
- 贡献本身是 MIT 协议,不增加任何新依赖。

## Diff 概览

```
22 files changed, 1521 insertions(+), 1 deletion(-)

packages/agent-modules/memphis-collective/
  src/  →  10 个源文件 (canonical、hasher、loader、watcher、writer、
                              provider、service、settings、types、index)
  test/ →  1 个测试文件 (16/16 vitest 通过)
  README.md  (162 行,说明"做什么"与"不做什么")
  package.json  (workspace package,MIT)

packages/agent-extension/src/memphis-collective.ts  →  1 个接线文件 (161 行)

packages/config/src/memphis-collective-config.ts  →  zod schema + parser
packages/config/src/config.ts                      →  +12 行 config passthrough
packages/agent-runtime/src/service/turn-system/production-composition.ts  →  +18 行

pnpm-workspace.yaml        →  +1 行 (workspace member)
tsconfig.standalone.json   →  +3 行 (path mapping)
release/extraction.json    →  +1 行 (build inventory)
package.json               →  +2/-1 行 (onlyBuiltDependencies + manifest entry)
```

对 `packages/agent-core`、`packages/protocol`、`packages/agent-runtime/src/service/*`、`packages/tui`、`packages/cli` 以及所有 wire-format 代码 —— 零修改。

## 验证

- `git diff --check`:clean
- `pnpm vitest run packages/agent-modules/memphis-collective/test/`:16/16 通过,39 ms
- `tsc -p tsconfig.standalone.json --noEmit`:退出码 0
- 在 `MiniMax-AI/minimax-code@4198174c89963ca7614ae7705bb897814d11b4ee`(当前 `main`)上干净地 rebase 完成
- **本地未运行:** 完整 `pnpm verify`、Windows + Linux 原生 acceptance、performance CI。这与您们的公开源码惯例一致 —— 在维护者 PR 起草之前,我们很希望您确认我们的集成需要满足的标准。

## 我们不会做的事

- 不直接 push 到 `main`
- 不绕过您们的 collaborator 政策
- 在第一个 PR 落地之前不批量提交多个 PR
- 不重命名现有 API、不动 `serde_json` 引用、不更改您们的 chain-block 格式

## 我们非常愿意调整

- 把 diff 拆成可审查的多块
- 如果您们更喜欢其它命名空间,可以重命名扩展 ID(`memphis-collective`)
- 按您们的指导添加或重组测试
- 把包移到不同位置(`packages/agent-modules/external/`、`packages/agent-modules/plugins/memphis/` 等)
- 如果您们更倾向,可以把 live-watch 改成 polling 方案
- 等。我们这边没有 deadline。

## Attribution 模型(如果接受)

正如您在 #362 中描述的,我们很高兴由您们准备维护者 PR 并 attribution 到我们的提交 `c32c23f`(`Memphis-Chains/minimax-code` 中)。该 commit 以 "Wodzu (Marcin Kukla) <wodzu@memphis.local>" 签名。我们会保留那个 fork 用于我们自己的部署,因此不论上游状态如何,我们都没有在 merge 之后索要任何权限。

## 联系方式

- GitHub: @Memphis-Chains
- 邮箱: memphis.kuklow@gmail.com
- 时区: CET (UTC+1 / UTC+2)
- 我们的 runtime(最近已公开):https://github.com/Memphis-Chains/memphis

感谢 minimax-code。我们每天都用,希望这个小贡献能合得上。

— Wodzu / Memphis-Chains
