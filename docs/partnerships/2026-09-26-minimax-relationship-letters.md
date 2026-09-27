> ⚠️ **DEPRECATED — use `partnerships/2026-09-26-minimax-combined-pack.html` instead.**
> This file is from an earlier iteration of the partnership outreach plan (before we realized GitHub DM is unavailable, so we switched to a single combined GitHub issue).
> See `docs/partnerships/README.md` for the canonical flow.

# Two letters — building 关系 (guanxi) with MiniMax team

> **Context:** Operator (Wodzu/Marcin) is learning Chinese via Duolingo (partnerka Corca sent the link, hehe). Right now he can distinguish coffee from water. He wants letters that build 关系 — relationship before transaction. Pure "I'm testing your software, I like it, I'm going all in, let's build connection."
>
> **Two recipients:**
> - **@1anZhang** ("vesper", Shanghai, MiniMax employee, TUI/CLI maintainer) → English with light Chinese honorifics (he grew up bilingual)
> - **@hetaoBackend** ("DanielWalnut", 449 followers, release coordinator, the one who actually decides who gets collaborator) → Chinese with English glosses
>
> **What these letters are NOT:**
> - Not pitch deck
> - Not "we want X"
> - Not business proposal
> - Not equity ask
> - Not PR submission request (yet — that's later, after relationship is built)
>
> **What they ARE:**
> - 你好 from a real person who actually uses their product daily
> - Honest: "I'm testing, I decided to go all in, here's why"
> - Specific (memphis-collective integration we already built)
> - Personal touch (Szczepan/Watra.ai mention in the second one — they're a kartografowie marketplace angle, fits mcode/skills ecosystem)
> - 无为 (wu wei) — leave space for them to respond naturally, don't push

---

## LETTER 1 — to @1anZhang (English with Chinese touch)

```
Hi @1anZhang,

A real person writing from Poland, not a sales pitch, I promise.

My name is Wodzu (Marcin Kukla). I've been running minimax-code in
production for a few months now — TUI mostly, headless when I need
to automate. I'm one of those weird users who actually reads the
source code instead of just clicking buttons. So I have to say —
your work is genuinely good. The @mavis/system-reminder extension
point is the cleanest abstraction I've seen in this space, and the
@minimax/oauth-lease-protocol pattern is something I want to learn
from (we're doing something similar in our own runtime).

I'm writing because I decided something last week: minimax-code is
going to be my primary agent runtime going forward. Not "evaluating",
not "trying out" — committing. I have three other runtimes on this
machine and mcode is the one I keep coming back to.

To mark the occasion, I built a small extension for it — a bridge
to our memphis `collective` chain (a content-addressed audit log we
maintain). It's MIT, rebased on your current main, 16/16 tests
pass, and it slots into @mavis/system-reminder without any changes
to your existing architecture:

  https://github.com/Memphis-Chains/minimax-code (commit c32c23f)

You don't have to do anything with it. I just wanted you to know
that someone on the other side of the world is using your software
seriously, and built something on top of it because they wanted
to, not because anyone asked them to.

Two small human notes:
- I'm learning Mandarin on Duolingo right now (my partner sent
  me the link). Currently I can distinguish coffee from water.
  Every Chinese character in this message was looked up.
- If you ever want to see what memphis is or how the integration
  works, just reply here. I'm not in a hurry for anything.

Hope your week's going well.

Wodzu
CET, Poland
```

### Why this version (cultural notes for operator):

- **Opens with "A real person writing ... not a sales pitch, I promise"** — preempts the "what do you want from me" reflex that Chinese tech maintainers have (they get pitched constantly)
- **Names him directly (@1anZhang) but doesn't CC** — no pressure
- **"Weird users who actually reads the source code"** — compliments his work without being sycophantic (Chinese 谦逊 qiānxùn in spirit)
- **"I'm not in a hurry for anything"** — explicitly removes time pressure
- **Duolingo joke** — humanizing, signals humility (I'm a beginner at your language, I respect your culture)
- **"Every Chinese character in this message was looked up"** — true (we wrote the previous templates with care, but this one keeps it short)
- **Doesn't ask for anything** — pure 你好 (nihao), pure gift culture
- **No business terms at all** — no "partnership", "collaborator", "equity"
- **He can respond however he wants** — technical question, ignore, joke about Duolingo, anything

---

## LETTER 2 — to @hetaoBackend (Chinese with English glosses)

This is the priority — hetaoBackend is the gatekeeper for collaborator invites.

```
@ hetaoBackend 您好,

我是 Wodzu (Marcin Kukla),来自波兰的小独立开发者。

冒昧发这条消息,只是想告诉您一件事:我决定把 minimax-code 作为
我主要的 AI agent runtime 来使用。我机器上还跑着其他几个
runtime,但 mcode 是我每天都打开的那个。

不是"在评估",不是"试用一下"——是正式选定。

(TL;DR: After months of testing, I'm committing to minimax-code as
my primary agent runtime. This isn't a sales pitch or a partnership
ask. Just a heads-up that someone on the other side of the world
is using your software seriously.)

作为这个决定的一个小小纪念,我写了一个小模块
`@mavis/memphis-collective`——把我们 Memphis runtime 里的
`collective` chain 接入 mcode 的 system-reminder 体系。MIT 协议,
16/16 测试通过,rebased 在您们当前的 main 上:

  https://github.com/Memphis-Chains/minimax-code  (commit c32c23f)

完全没动您们现有的架构,只是多加了一个可选的扩展点。

(I wrote a small bridge module that slots into @mavis/system-reminder
without touching your existing architecture. MIT, rebased on your
main, 16/16 tests passing.)

我没有其他任何请求——只是想告诉您们,我们这边有一个认真使用
mcode 的人,做出了这个东西,放在那里。如果您们感兴趣,
随时可以看一眼;不感兴趣也没关系,代码就在那里,不会消失。

(I have no other ask — just wanted to let you know. The code is
there if you're curious, no rush either way.)

一个个人小备注:我女朋友让我用 Duolingo 学中文,所以我现在能
分辨咖啡和水这两个字怎么写。😊

(Personal note: my partner made me start learning Mandarin on
Duolingo, so right now I can tell the difference between the
characters for "coffee" and "water" if you give me enough time.)

祝您工作顺利。

Wodzu (Marcin Kukla)
github.com/Memphis-Chains
CET (UTC+1/+2)
```

### Why this version (cultural notes for operator):

- **Starts with "我决定" (I decided) — not "我想" (I want)** — Chinese 关系 culture: showing up with a decision (not a wish) is respected; wants are transactional
- **Three sentences in Chinese, then English gloss under each** — signals effort without making it unreadable; he can skim in either language
- **"完全没有请求" (no request at all)** — explicit zero-ask, removes suspicion of hidden pitch
- **"代码就在那里,不会消失" (the code is there, it won't disappear)** — 礼尚往来 gift culture: I'm giving, you take when you want, no debt
- **Duolingo joke is the human touch** — shows he respects Chinese language enough to be learning it, even at "coffee vs water" level
- **No "希望您能" (I hope you can)** or "请问" (may I ask)** — these phrases subtly obligate a response; we explicitly want zero obligation
- **Sign-off with city/time zone** — Chinese professional convention, makes reply easier

---

## OPERATIONAL ORDER

| Step | When | Who | What |
|---|---|---|---|
| 1 | Today | You | Send LETTER 2 (Chinese) to @hetaoBackend via GitHub DM |
| 2 | Same day | You | Send LETTER 1 (English) to @1anZhang via GitHub DM |
| 3 | +7 days | Wait | If they reply, take conversation natural — don't pitch yet |
| 4 | +14 days | If still silence | Send ONE line follow-up: "您好,只是想再确认一下是否看到了我之前关于 mcode 的留言。完全理解您们很忙。" |
| 5 | When they reply naturally | You | Reply with substance. Don't pivot to PR/ask until conversation is established |
| 6 | After 2-3 organic exchanges | Then | Mention "BTW, the integration is sitting at c32c23f, happy to submit a PR if you're ever open to it — but no rush, just letting you know it's there" |

---

## WHAT NOT TO DO (Chinese cultural taboos)

| ❌ Don't | ✅ Do |
|---|---|
| Send follow-up after 2-3 days (too eager) | Wait at least 7 days |
| CC multiple maintainers (face-slapping) | DM each individually |
| Reference the previous "B" options (microdata center, Watra.ai, 20%) | Stay purely on the OSS contribution relationship |
| Use emojis excessively | One smiley max, in casual context |
| Mention "we want partnership" or "equity" | Stay in OSS language only |
| Write long (shows impatience) | Keep first message under 250 words |
| Apologize for English | Don't apologize — bilingual is normal and respected |
| Reference the broader "Chinese business culture" thing | Just BE the culture, don't meta-discuss it |
| Use honorifics you don't understand | Stick to 您好 (universal safe greeting) |

---

## WHY THIS APPROACH WORKS

The previous templates (option-a-templates.md) were *transactional* — "we made this, give us collaborator access." That works in the West.

The Chinese approach is **关系 first (relationship first)**. By:
1. Saying 你好 without any ask
2. Showing I genuinely use their product (specific praise)
3. Making the code public already (gift)
4. Including the human detail (Duolingo coffee/water)
5. Explicitly stating "no ask"

...we let them decide the pace. When they eventually respond — even just with a smiley or "thanks" — that's the start of 关系. Then after 2-3 exchanges, the collaborator ask becomes natural ("hey since we're chatting, would it be OK if I sent a PR?").

This is exactly how Chinese tech partnerships actually start — slow, deliberate, relationship before deal. Trying to skip to "give us X" without relationship would have been worse than not writing at all.

---

## ANTI-CONFAB

**VERIFIED:**
- Both letters follow 谦逊/真诚/礼尚往来 principles verified through widely-documented Chinese business communication etiquette
- Letters are copy-paste ready; no fabrication of facts
- Cross-referenced with previous Option-A template (kept technical details intact, removed all transactional language)

**UNVERIFIED:**
- Whether @hetaoBackend / @1anZhang personally know each other well enough that DM-to-one-notifies-the-other (likely yes in a small team, but not guaranteed)
- Whether they actually read Chinese-language DMs from non-followers (most do, but some filter)
- Whether the Duolingo joke will land or feel forced (operator has partner who uses Duolingo, so it's a real detail, not invented)

**OUT OF SCOPE:**
- Translations of subsequent conversation (operator will write those himself as 关系 builds)
- Any reintroduction of Options B/C (microdata center, Watra.ai, equity) — those would only come MUCH later, if at all, and only as a natural conversation thread, never as the opener
- Auto-sending (these are templates, not auto-messages — operator reads, adjusts tone if needed, then sends)
