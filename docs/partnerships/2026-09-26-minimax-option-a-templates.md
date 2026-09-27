> ⚠️ **DEPRECATED — use `partnerships/2026-09-26-minimax-combined-pack.html` instead.**
> This file is from an earlier iteration of the partnership outreach plan (before we realized GitHub DM is unavailable, so we switched to a single combined GitHub issue).
> See `docs/partnerships/README.md` for the canonical flow.

# MiniMax Outreach — Chinese Business Culture Templates (Option A only)

> **Context:** Option A — pure OSS contribution, no business strings. Ask: collaborator invite so we can submit a real PR.
> **Cultural principles applied:** 谦逊 (humility first), 尊重 (respect hierarchy), 真诚 (sincerity over sales), 礼尚往来 (gift before ask), 关系 (relationship before transaction), 正式 (formal structure).

---

## CHANNEL 1 — GitHub DM to @hetaoBackend (PRIMARY, do this first)

@hetaoBackend is the release coordinator + CODEOWNERS owner. He's the decision-maker on PR policy. Use Chinese — it's his native language and signals cultural fluency + respect.

### 🇨🇳 中文版 (recommended primary)

```
您好 @hetaoBackend,

冒昧打扰,我是 Memphis-Chains 团队的 Wodzu (Marcin Kukla),来自波兰。

我们团队在过去一年里一直在使用您们发布的 minimax-code(已经在
production 跑了好几个月了),mcode 的 TUI 体验和 SPI 设计都让我们
受益匪浅——尤其是 @mavis/system-reminder 扩展点和
@minimax/oauth-lease-protocol 的设计思路。

基于这个基础,我们写了一个小模块 `@mavis/memphis-collective`,
想在不影响现有架构的前提下把它作为可选扩展贡献给您们。

具体内容很简单:
- 读取 `~/.memphis/chains/collective/*.json` 链式存储
- 通过 fs.watch 监听变化(100ms 防抖)
- 将最近 N 条记录渲染成 `<memphis-collective>...</memphis-collective>`
  系统提示块(完全兼容 @mavis/system-reminder)
- 暴露 `memphis_collective_append` 工具,带 hash linkage
- 全部 MIT 协议,与您们现有 LICENSE 一致

代码已经准备好了,rebased 在您们当前的 main 上:
- 仓库: https://github.com/Memphis-Chains/minimax-code
- 提交: c32c23f
- 测试: 16/16 通过
- 文件数: 22 个,1,521 行新增

我们仔细读过 CONTRIBUTING.md,知道目前只接受 collaborator 的 PR。
这个 issue 不是想绕过规则——是想请问一下,如果方便的话,
是否可以给我们 collaborator 权限,这样我们就可以正式走 PR 流程,
把代码 review 之后再 merge 上游,让其他用户也能通过
`mcode plugin add` 直接使用。

不着急,完全理解您们维护工作很忙。如果时机不对或者需要我们
先做其他准备工作(比如拆成更小的 PR、加更多测试、调整 API 名称
等等),请尽管告诉我们具体需要什么。

祝好,
Wodzu (Marcin Kukla)
Memphis-Chains | github.com/Memphis-Chains
memphis.kuklow@gmail.com | CET (UTC+1/+2)
```

### 🇬🇧 English version (backup, use only if he prefers English)

```
Hi @hetaoBackend,

Forgive the cold contact — I'm Wodzu (Marcin Kukla), part of the
Memphis-Chains team in Poland.

We've been using your minimax-code in production for several months
now, and it's been a pleasure — especially the @mavis/system-reminder
extension point and the @minimax/oauth-lease-protocol design.

On top of that base, we built a small package called
@mavis/memphis-collective that we wanted to contribute upstream as
an optional extension, without touching your existing architecture.

What it does, briefly:
- Reads `~/.memphis/chains/collective/*.json` chain files
- Watches for changes via fs.watch (100ms debounce)
- Renders recent N blocks as a `<memphis-collective>...</memphis-collective>`
  system-reminder (drop-in compatible with @mavis/system-reminder)
- Exposes a memphis_collective_append tool with proper hash linkage
- MIT-licensed, matches your existing LICENSE

The code is ready, rebased on your current main:
- Repo: https://github.com/Memphis-Chains/minimax-code
- Commit: c32c23f
- Tests: 16/16 passing
- Diff: 22 files, 1,521 insertions

We read CONTRIBUTING.md carefully and understand PRs are
collaborator-only at the moment. This message isn't trying to
bypass that — we're asking, if it's convenient, whether a
collaborator invite might be possible so we can go through the
proper PR review and merge flow. That way other users could
install via `mcode plugin add` instead of compiling from source.

No rush, and we completely understand maintainer time is precious.
If the timing isn't right, or if there's something specific you'd
need first (smaller PR scope, additional tests, API naming
adjustments, etc.), please tell us and we'll prepare accordingly.

Best regards,
Wodzu (Marcin Kukla)
Memphis-Chains | github.com/Memphis-Chains
memphis.kuklow@gmail.com | CET (UTC+1/+2)
```

---

## CHANNEL 2 — Email to api@minimax.io (BACKUP, do this in parallel with Channel 1)

Use if @hetaoBackend doesn't respond within 7 days. Goes to the official partnership intake — even though we're not proposing a partnership, this is the only email address on the official footer.

### 🇬🇧 Email (English only — api@minimax.io is the English-language contact)

**To:** api@minimax.io
**Subject:** Open-source contribution inquiry — `@mavis/memphis-collective` for minimax-code

```
Dear MiniMax team,

Forgive a cold email from a Polish open-source contributor.

We have been running minimax-code in production for several months
and have built a small extension package on top of it that we
would like to contribute upstream:

  https://github.com/Memphis-Chains/minimax-code  (commit c32c23f)

What it is:
- A reader/writer bridge between minimax-code agents and the
  Memphis `collective` chain (a content-addressed append-only log
  stored at ~/.memphis/chains/collective/)
- Renders recent decisions as a <memphis-collective>...</memphis-collective>
  system-reminder block (drop-in compatible with @mavis/system-reminder)
- Exposes a memphis_collective_append tool with hash linkage
  matching your serde_json canonical format
- MIT-licensed, 16/16 tests passing, rebased on your current main

We noticed in CONTRIBUTING.md that pull requests are currently
accepted only from repository collaborators. This message is to
ask, respectfully, whether a collaborator invite might be possible
so we can submit this through your standard review process. We
are not asking to bypass your policy — only to participate in it.

If the timing is not right, or if you would prefer we prepare
smaller PRs, additional tests, or different API surface, we are
happy to adjust. Please tell us what would help.

No deadline pressure from our side. Thank you for your time and
for the work you've put into minimax-code — we use it daily and
appreciate it.

With respect,
Marcin "Wodzu" Kukla
Memphis-Chains
github.com/Memphis-Chains
memphis.kuklow@gmail.com
```

---

## CHANNEL 3 — Issue body (POST AFTER collaborator invite granted)

⚠️ **DO NOT POST THIS UNTIL YOU HAVE COLLABORATOR ACCESS.** Posting this earlier will be flagged as policy violation and could hurt the request.

### Issue title (must follow `[Question]: ` template convention)

```
[Question]: memphis-collective integration — collaborator invite request for upstream PR
```

### Issue body

#### 🇬🇧 English

```markdown
## Background

We're a small team (Memphis-Chains, Poland) that has been running
minimax-code in production since mid-2025. The TUI experience and
the @mavis/system-reminder extension point have been essential to
our daily work.

## What we built

We extended minimax-code with a small package called
`@mavis/memphis-collective` that we would like to contribute
upstream. It is already in our public fork:

  https://github.com/Memphis-Chains/minimax-code (commit c32c23f)

The package:

- Reads `~/.memphis/chains/collective/*.json` (strict-shape scan
  matching the existing chain block format)
- Watches the directory via `fs.watch` (100 ms debounce +
  microtask gap) and reloads on change
- Renders the most recent N blocks as a
  `<memphis-collective>...</memphis-collective>` system-reminder
  block, drop-in compatible with `@mavis/system-reminder`
- Exposes a `memphis_collective_append` tool with proper `prev_hash`
  linkage, atomic rename, and `.napi-append.lock` for race-safety
- 16/16 vitest tests passing locally
- TypeScript types fully resolved (`tsc -p tsconfig.standalone.json
  --noEmit` exits 0)
- MIT-licensed

Diff: 22 files, 1,521 insertions, 1 deletion. Rebased on
`MiniMax-AI/minimax-code@4198174c89963ca7614ae7705bb897814d11b4ee`
(current main).

## Why we need a collaborator invite

We read `CONTRIBUTING.md` carefully and understand that pull
requests are currently accepted only from repository collaborators.
This issue is not a workaround — it is the request itself.

If a collaborator invite for `@Memphis-Chains` could be granted, we
will:

1. Open a focused PR with the rebased commit above
2. Split the change into reviewable chunks if that helps review
3. Add any additional tests you request
4. Wait patiently for code review and respond to feedback
5. Not push directly to `main`

If the timing is wrong, or if you would prefer the contribution to
go through a different shape (smaller scope, plugin-format instead
of in-tree package, etc.), please tell us what would work and we
will adapt.

## What we will NOT do

- We will not push directly to `main` without approval
- We will not bypass your collaborator policy in any way
- We will not bulk-submit multiple PRs before the first one lands

## Contact

- GitHub: @Memphis-Chains
- Email: memphis.kuklow@gmail.com
- Time zone: CET (UTC+1 / UTC+2)

Thank you for your time and for minimax-code.

— Wodzu / Memphis-Chains
```

#### 🇨🇳 中文版

```markdown
## 背景

我们是来自波兰的小型团队(Memphis-Chains),从 2025 年中开始
将 minimax-code 投入生产环境使用。日常工作中,TUI 的使用
体验和 `@mavis/system-reminder` 扩展点对我们的工作至关重要。

## 我们做了什么

我们在 minimax-code 基础上扩展了一个小包 `@mavis/memphis-collective`,
希望能够贡献回上游。代码已经在我们的公开 fork 中:

  https://github.com/Memphis-Chains/minimax-code (commit c32c23f)

这个包的功能:

- 读取 `~/.memphis/chains/collective/*.json`(严格遵循现有 chain
  block 的格式)
- 通过 `fs.watch` 监听目录变化(100ms 防抖 + microtask 间隔),
  变化时自动重载
- 将最近的 N 条记录渲染为 `<memphis-collective>...</memphis-collective>`
  系统提示块,与 `@mavis/system-reminder` 完全兼容
- 提供 `memphis_collective_append` 工具,带正确的 `prev_hash`
  linkage、原子重命名、以及 `.napi-append.lock` 防止竞态
- 16/16 vitest 测试本地通过
- TypeScript 类型完整(`tsc -p tsconfig.standalone.json --noEmit`
  退出码 0)
- MIT 协议

Diff:22 个文件,1,521 行新增,1 行删除。基于当前
`MiniMax-AI/minimax-code@4198174c89963ca7614ae7705bb897814d11b4ee`
(main)rebase。

## 为什么需要 collaborator 权限

我们仔细读过 `CONTRIBUTING.md`,了解到目前只接受 collaborator
的 PR。这个 issue 不是绕过的方案——它就是请求本身。

如果能为 `@Memphis-Chains` 授予 collaborator 权限,我们将:

1. 用上面的 rebase commit 开一个专注的 PR
2. 如有帮助评审,将改动拆成可审查的小块
3. 根据需求添加额外的测试
4. 耐心等待 code review,并对反馈做出响应
5. 不会直接 push 到 `main`

如果时机不对,或者您们更希望以其他形式贡献(更小的范围、
plugin 格式而非 in-tree package 等),请告诉我们哪种方式可行,
我们会调整。

## 我们不会做的事

- 未经批准不会直接 push 到 `main`
- 不会以任何方式绕过您的 collaborator 政策
- 在第一个 PR 完成之前不会批量提交多个 PR

## 联系方式

- GitHub: @Memphis-Chains
- 邮箱: memphis.kuklow@gmail.com
- 时区: CET (UTC+1 / UTC+2)

感谢您们的时间和 minimax-code。

— Wodzu / Memphis-Chains
```

---

## OPERATIONAL ORDER

| Step | When | What | Channel |
|---|---|---|---|
| 1 | Today | Send DM to @hetaoBackend (Chinese version primary) | GitHub DM |
| 2 | Same day | Send email to api@minimax.io (English) | Email |
| 3 | +7 days | If no response, send a single polite follow-up DM (one line: "checking if you saw my note about @mavis/memphis-collective") | GitHub DM |
| 4 | +14 days | If still no response, escalate to Discord (discord.gg/692jE8wsmj) | Discord |
| 5 | After collaborator invite granted | Post CHANNEL 3 issue body, then submit real PR | GitHub |

## TONE CALIBRATION

What I avoided (Western default → Chinese fix):

- ❌ "We want to contribute" → ✅ "我们想贡献" (with explicit defer: "if convenient / 不着急")
- ❌ "We're excited to..." → ✅ No exclamation, no enthusiasm markers
- ❌ "Here's what we built for you" → ✅ "我们写了一个小模块 ... 想在不影响现有架构的前提下把它作为可选扩展贡献给您们" (deferential framing)
- ❌ "Please review our PR" → ✅ "如果方便的话 ... 请尽管告诉我们具体需要什么" (invite feedback, don't demand action)
- ❌ "ASAP / urgent" → ✅ "不着急,完全理解您们维护工作很忙" (explicitly remove time pressure)
- ❌ Bullet lists for first contact → ✅ Continuous prose paragraphs (more respectful)
- ❌ Partnership / equity / business terms → ✅ Zero (Option A only)
- ❌ Emojis / exclamation marks → ✅ Zero
- ❌ "Dear Sir/Madam" / "To whom it may concern" → ✅ "您好 @hetaoBackend" (specific name, not generic)

## ANTI-CONFAB

**VERIFIED (live 2026-09-26):**
- @hetaoBackend is the right primary target (release coord, CODEOWNERS owner, 23 merged PR)
- @1anZhang is backup (Shanghai MiniMax employee, 6 merged PR)
- Email api@minimax.io verified from official minimax.io footer
- Chinese business communication principles are widely-documented (no web fetch needed; this is standard tech partnership etiquette in Chinese orgs)
- Templates are copy-paste ready; no fabrication of facts

**UNVERIFIED:**
- Whether @hetaoBackend personally prefers Chinese vs English (most likely bilingual, but Chinese signals respect)
- Specific honorific preferences (we used "您好" which is universal; if he prefers "老师" or other titles, can adjust)
- Whether 4-week response window is acceptable to operator (Chinese partnerships can be slower than Western — relationship-building phase is real)

**OUT OF SCOPE:**
- Sending without operator review (template only)
- Translation accuracy verification beyond high-level professional Mandarin
- Any Option B/C content (rejected by operator)
