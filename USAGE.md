# Auditrail working guide

How to run it, what each command is for, and the situations it was built to answer.

Everything below was run against the synthetic fixture that ships in this repository
(`test/fixtures/showcase/power-user/projects`), so every figure quoted here is one you can
reproduce on your own machine from a clean clone. None of it is anyone's real usage.

---

## 1. What it does

Auditrail reads the session logs your coding agent already writes to disk, prices every model
response at published API list rates, ranks what to change, scans the transcripts for leaked
secrets, and writes one HTML report, all on your own machine with no account, no key and no
network call.

## 2. Why it exists

If you are on a subscription, the only number you ever see is the monthly charge. You cannot tell
what the work was worth, which project consumed it, where the agent went in circles, or whether
the keys you pasted into a session three weeks ago are still sitting in a readable file. The logs
contain all of that already. Nothing reads them, and Claude Code deletes them on a schedule, so
the evidence expires before anyone looks at it.

## 3. Quickstart

Installed:

```
npx auditrail
```

From a clone:

```
node scripts/gen-synthetic.mjs      # build the synthetic fixtures
node scripts/build.mjs              # build dist/auditrail.mjs and dist/auditrail.html
node dist/auditrail.mjs
```

Node 22 or later. Zero runtime dependencies. `pnpm dlx auditrail` and `bunx auditrail` work too.

Every command prints the same header first, so you always know what was read before you read any
number:

```
auditrail 0.1.0
network: denied by the Node runtime (--permission, no --allow-net)
scan taken 2026-09-21T21:21:46.859Z
scanned 856 files (6.5 MB) in 0.4 s, peak memory 80 MB
0 parse errors, 0 partial trailing lines (sessions still writing)
responses 6,751, of which 0.0% never recorded final output counts (value is a lower bound)
report C:\Users\You\.auditrail\reports\auditrail-2026-09-21-1721.html
```

The report is written to `~/.auditrail/reports/` and opened in your browser. Pass `--no-open` to
skip the browser, `--out <file>` to choose the path.

The six commands:

| Command | What it writes |
|---|---|
| `auditrail` (or `auditrail report`) | one self-contained HTML report, then opens it |
| `auditrail card` | one PNG share card, plus a manifest of every field the image contains |
| `auditrail audit [--methods]` | receipts to the terminal: files, lines, responses, dedup, prices, cross-checks |
| `auditrail export --csv/--json/--md [--by day/month/model/project]` | a file you can hand to a spreadsheet or an invoice |
| `auditrail remember` | updates a numbers-only ledger so history survives log deletion |
| `auditrail secrets --locations` | terminal-only list of which files hold each secret finding |

The report itself is fourteen findings. Each one is arithmetic over your logs, with the event
count behind it and one thing to change:

| id | Finding |
|---|---|
| i01 | What the work was worth |
| i02 | Where the value goes |
| i03 | Idle-resume tax |
| i04 | Delegation |
| i05 | Repricing what-if |
| i06 | Rate-limit walls |
| i07 | Tool reliability |
| i08 | Churn hot spots |
| i09 | Working patterns |
| i10 | Workflow agent outcomes |
| i11 | Secrets in transcripts |
| i12 | History at risk |
| i13 | Model and effort mix |
| i14 | Activity receipts |

A finding with nothing to report is marked not shown rather than padded out. On the shipped
fixture, i03, i06, i10 and i11 are all not shown, because that fixture has no long idle gaps, no
rate-limit windows, no workflow agents and no planted secrets.

## 4. Use cases

### 4.1 Putting a number on AI coding for a budget or an expense claim

**Situation.** Your finance lead asks what the AI tooling line item actually buys, or you need to
justify a renewal, or you are self-employed and want the deduction defensible. You have a
subscription receipt and nothing else.

**What you do.**

```
auditrail export --csv --by month
auditrail export --csv --by project
auditrail --plan max20x
```

**What you learn.** `--by month` gives you value per calendar month with a response count beside
it. On the shipped fixture the months run March to August 2026 and the first three rows are
`2026-03,1038,609.490952`, `2026-04,1160,677.039249`, `2026-05,1414,815.112878`. `--by project`
splits the same total by project folder. `--plan` prints the multiple: the fixture total of
$4,028.32 over 6 months, against the Max 20x price of $200 per month, comes out at 3.36x. Every
export carries a method footnote on the last line, so the number arrives with its own caveat
attached instead of floating free in a spreadsheet.

**The action it leads to.** Attach the CSV to the allocation sheet with the footnote intact, and
write the line item as "API-equivalent value at list price" rather than as cost. If the multiple
is under 1.0x you are paying more than the work is worth at list, which is the moment to compare
a subscription against an API key.

### 4.2 Billing a client for the AI work on their project

**Situation.** You ran three client projects through one subscription this quarter. One of them
wants to know what share of the tool cost was theirs, and "I used it a lot for you" is not an
invoice line.

**What you do.**

```
auditrail export --csv --by project --since 2026-07-01 --until 2026-09-30
```

Add `--redact` if the CSV is going anywhere you would rather not name folders.

**What you learn.** One row per project, with responses, value and session count. On the shipped
fixture: `orbit-api,2500,1476.019194,85`, `atlas-app,2154,1336.748448,79`,
`lumen-docs,2097,1215.552714,71`. With `--redact` the same rows come back as Project A, Project B
and Project C in the same order, so you can show the shape of the split without naming the other
clients.

**The action it leads to.** Allocate the subscription cost by value share rather than by
guesswork, and put the method footnote in the invoice notes. If a client disputes it,
`auditrail audit --methods` reproduces the arithmetic in front of them.

### 4.3 Finding secrets sitting in your transcripts

**Situation.** Over six months you or your agent pasted API keys into sessions, and the agent read
`.env` files out loud into tool results. Those transcripts are plain text files on disk that no
scanner in your stack is looking at.

**What you do.** Run the report first and read finding i11. Then, only if there is something to
act on:

```
auditrail secrets --locations
```

**What you learn.** Sixteen vendor formats are matched: private key PEM blocks, Anthropic, OpenAI,
AWS, GitHub, GitLab, Slack tokens and incoming webhooks, Stripe live keys, Google API keys and
OAuth client secrets, SendGrid, Hugging Face, npm, JSON Web Tokens, and database URLs with an
inline password. Each finding is reported as a type, a twelve hex character fingerprint of
SHA-256 over the value, a count of copies and the newest date. Against the canary fixture in this
repo the output is:

```
critical anthropic 4cbd38f327f9 (1 locations)
  -fake-CANARY-PROJECT-7f3a/aaaaaaaa-0000-4000-8000-000000000003.jsonl:8
```

Severity is earned, not assumed. A finding is `critical` only when it matches a vendor format, the
random body scores at least 3.2 bits of Shannon entropy per character, there is no fixture context
word ("test", "mock", "example", "placeholder" and similar) within 150 characters, and it came
from your own text or from local tool output. Anything found in WebFetch or WebSearch output is
`third_party_public`, information only. Everything else is `likely_fixture` and collapsed by
default.

**The action it leads to.** Rotate at the provider first, using the rotation sentence the finding
carries, then delete the sessions that hold the copies. Rotate before deleting: the file is the
only record of which key it was.

### 4.4 Finding where the agent thrashes, so you can fix the docs or the tests

**Situation.** Some part of the codebase keeps costing you a whole afternoon. You suspect the agent
is going round in circles there but you have no evidence, only a feeling.

**What you do.** Read findings i08 (churn hot spots) and i07 (tool reliability) in the report.

**What you learn.** i08 counts edits per file and reports the distinct files touched, how many were
edited ten or more times, the worst single file, and the top ten by edit count. On the shipped
fixture: 241 distinct files, 18 of them edited ten or more times, worst file 74 edits. i07 pairs
every tool call with its result and reports a failure rate per tool plus the longest run of
consecutive failures on the same tool. On the fixture: 5,115 tool calls, all paired, a 3.0 percent
overall failure rate, Bash at 8.6 percent (107 non-zero shell exits), Edit at 5.1 percent (48
failures), Read at 0 percent.

Read the longest-fail-run column, not just the rate. A tool that fails 5 percent of the time at
random is noise. A tool with a fail run of six is the agent retrying the same wrong thing.

**The action it leads to.** For the top churn files, add a test, a CLAUDE.md note or a short doc so
the next attempt is right the first time. For a repeated non-zero exit, fix the script or write
down how to run it.

### 4.5 Cache efficiency, and where the value actually goes

**Situation.** The monthly number is higher than you expect and you assume it is because the agent
writes a lot of code. That assumption is usually wrong, and it sends you optimising the wrong
thing.

**What you do.** Read finding i02 (where the value goes) and finding i03 (idle-resume tax).

**What you learn.** i02 splits the total five ways: uncached input, output, 5 minute cache writes,
1 hour cache writes and cache reads, with the share of value each one carries, plus a cache hit
rate. On the shipped fixture, output is 15.2 percent of value, so generation is the small half;
cache writes are 62.1 percent (23.4 percent at the 5 minute rate, 38.7 percent at the 1 hour rate)
and cache reads are 22.6 percent, at an 85.6 percent hit rate.

i03 tells you what re-broke the cache. It buckets every cache write by what preceded it: the first
write in a session, a model switch, a resume inside 5 minutes, a resume between 5 and 60 minutes,
and a resume after more than an hour. Come back to a session after lunch and the whole context is
written again at full price.

**The action it leads to.** Trim what loads on every single turn, which is usually a long CLAUDE.md
or a large MCP tool list, because that is the thing you pay for on every cache write. Before a
break longer than an hour, wrap up and start fresh with a short handoff note rather than leaving
the session open. Avoid switching models mid-session.

### 4.6 Proving what you shipped with an agent, for a review, a portfolio or a client

**Situation.** You need to show what you shipped over six months: to a manager in a performance
review, to a hiring manager, or to a client who wants to know what they got. Screenshots of a chat
window are not evidence.

**What you do.**

```
auditrail export --md
auditrail card --size portrait --theme dark
```

**What you learn.** The Markdown export is finding i14, activity receipts, as a table you can paste
into a document. On the shipped fixture it reports 150 active days, 225.0 active hours at a 15
minute idle cutoff, 235 work blocks, 1,015 prompts, 0 interrupts, 223 files created, 18 files
edited, 16,211 lines written by agent tool calls, and command counts with failures broken out (329
test runs with 24 failures, 292 builds with 28 failures). The line count is labelled "lines written
by agent tool calls, not lines that survived", because that is what the logs support.

The card is a PNG built from an allowlist, and it prints the manifest of exactly what it drew next
to the file path:

```
card card.png (2160 x 2700 px, portrait, dark)
manifest: the 11 fields this image contains, and nothing else
  Archetype: The Conductor: You don't type code. You run a crew.
  Badges: Streak 52
  Coverage: Mar 2 to Aug 30, 2026 | 150 active days
  Value: at least $4.0K API-equivalent value at list price
  Active hours (15-minute idle cutoff): 225 hours with your agent
  Tool calls: 5.1K actions by your agent
  Longest streak: 52 days in a row
  Delegation (share of value): 34% of the work done by subagents
  Activity heatmap (prompts by weekday and hour, 4 levels): when you and your agent work
  Peak hour: busiest hour 5 PM
  Footer: API-equivalent value at list prices as of 2026-09-14. Not what I paid. ...
```

A project name, a file path, a prompt or a secret cannot reach that image, and a test in the suite
fails if one ever can.

**The action it leads to.** Put the Markdown table in the review document with its method notes
intact, and the card in the portfolio or the post. Say "API-equivalent value at list price" out
loud, because that is what the number is, and a reviewer who checks will find you said it first.

### 4.7 Your history is being deleted on a schedule

**Situation.** Claude Code deletes transcripts older than `cleanupPeriodDays`, which is 30 days by
default. The sweep is per file, so how much history you still have depends on how you work and
nobody can tell you from the outside. Your first run will cover far less than you expect, and next
quarter's run will have lost this quarter.

**What you do.** Read finding i12, then turn on the ledger:

```
auditrail remember
```

**What you learn.** i12 prints your real measured coverage window rather than guessing at it. On
the shipped fixture: earliest 2026-03-02, latest 2026-08-30, 182 days covered, retention at the
default. `remember` writes a numbers-only ledger to `~/.auditrail/ledger/v1` and reports what it
did:

```
ledger updated: 6 months, 150 days, 235 session-days (235 added, 0 refreshed, 0 kept)
```

What goes in it: per local day and hashed session, tokens by model, file class, hashed project key,
and tool-call counts by built-in name. What never goes in it: prompts, paths, file names, titles,
tool inputs, secrets, raw session ids, and any model id that is not in the published price table,
because a gateway id can carry a cloud account number and is hashed instead.

**The action it leads to.** Run `remember` on a schedule now, not later, because it cannot recover
what is already gone. The command prints a `SessionEnd` hook you can paste into your Claude Code
`settings.json` yourself; auditrail never installs it for you. The alternative is raising
`cleanupPeriodDays`, which also keeps everything ever pasted into a session, secrets included, on
disk for that long. The ledger is the safer half of that trade.

### 4.8 Deciding between a subscription and an API key

**Situation.** You are on a plan and you do not know whether an API key would be cheaper, or you
are on an API key and you do not know whether a plan would be. The vendor cannot tell you, because
the answer depends on how you personally work.

**What you do.**

```
auditrail --plan pro
auditrail --plan max20x
auditrail --plan-price 47.50
```

**What you learn.** The value multiple, computed as total value divided by the number of months
with responses, divided by your monthly price. Above 1.0x, the plan is doing better than list rates
for your pattern of use. The bundled plan table carries a source URL and a fetch date per tier, so
the price side of the ratio is checkable too. `--plan-price` takes your own figure for a plan that
is not in the table, a team seat at a negotiated rate, or a currency conversion you did yourself.

**The action it leads to.** Read it as a direction, not a decision. The value is a lower bound, so a
multiple slightly under 1.0x is not proof the plan loses. A multiple of 3x or more, month after
month, says the plan is comfortably the cheaper side for your pattern.

### 4.9 Moving the cheap work to a cheaper model

**Situation.** You suspect a lot of your spend is mechanical work (file reading, test running,
summarising) being done by an expensive model because that is what the default is.

**What you do.** Read findings i04 (delegation), i05 (repricing what-if) and i13 (model mix).

**What you learn.** i13 splits value by model. On the fixture, Claude Fable 5 carries 82.4 percent
of value over 4,735 responses and Claude Opus 5 carries 17.6 percent over 2,016. i04 reports the
share of value done by subagents, 34 percent on the fixture. i05 takes the responses that are
eligible to be repriced and shows what those exact token counts would have cost at a cheaper
model's list rates: 3,081 responses, 34.0 percent of total value, $1,370.75 as run against $319.27
at Sonnet 5 list prices.

Read the label i05 carries with it. Models differ in quality and in tokenization, and later models
produce roughly 30 percent more tokens for the same text, so this is a rough bound and not a
promise.

**The action it leads to.** Pin an explicit cheaper model for subagents and for workflows where
quality allows, then re-run next month and check whether the delegation share moved without the
failure rate in i07 moving with it.

### 4.10 Scheduling around the rate-limit walls

**Situation.** You hit a wall at the same point in the afternoon most days and lose the run.

**What you do.** Read finding i06.

**What you learn.** Which local hours your rate-limit windows start in, how many episodes there
were, and how much value you had already spent before each window opened. On the shipped fixture
this finding is not shown, because the fixture contains no rate-limit events, which is itself the
correct behaviour: no events, no finding, no padding.

**The action it leads to.** Move the heavy workflows into your quiet hours and push subagents onto a
cheaper model, so the window lasts through your peak rather than ending in the middle of it.

## 5. Getting the most out of it

**Run `audit --methods` once on your own logs, early.** The counting-method table in the README is
a ratio measured on real logs, not a claim about your machine. `--methods` recomputes the same
comparison on yours. On the clean synthetic fixture every dedup method agrees exactly, which is the
honest result for a fixture with one line per response; on real logs they will not, and the gap
between "sum every line" and the correct total is the number that tells you why a naive script
would have lied to you.

**Scope with `--since` and `--until` before you export anything for someone else.** Both take
`YYYY-MM-DD` or a full ISO timestamp. A bare date means local midnight in your time zone, and
`--until DATE` includes that whole day. Use `--tz` to pin the zone when you are reporting to
someone in another one, otherwise days and hours are bucketed in this machine's zone.

**`--redact` is per run, not a mode you turn on once.** It rewrites project, file, agent, skill,
MCP, tool, unpriced model and custom price file names to Project A, File A and so on, in a stable
order, so the shape of the data survives and the names do not. Use it on anything leaving your
machine.

**The card is subtractive.** `--card-hide <stat>` drops any one of value, output-tokens,
active-hours, tools, top-tool, cache-hit-rate, delegation, streak, peak-hour, max-edits, top-model,
archetype, badges, coverage, heatmap. The footer cannot be hidden, because it states when the card
was made and from how many files. Rate-limit windows are the one opt-in extra:
`--card-include rate-limits`.

**Read the manifest, not the image.** `auditrail card` prints the exact text it drew for every
field. That list is generated from the same allowlisted object the renderer draws from, so it
cannot under-report. If something you did not expect is on the card, it is in the manifest.

**Secret findings never leave the report.** They are not in `--csv`, not in `--json`, not in
`--md`, and not on the card. That is deliberate. They appear in the local HTML report, and
`secrets --locations` prints file paths and line numbers to your terminal on explicit request,
which is why that command refuses to run without the flag.

**Point it anywhere with `--dir`, repeatably.** It takes a projects folder, not a single file. A
second machine's logs copied onto this one, a backup, or the fixtures in this repo all work:
`--dir test/fixtures/showcase/power-user/projects` reproduces every figure in this guide.

**Bring your own prices with `--prices <file>`.** It takes a price file in Claude Code's
`modelPricing` shape. The card then labels the value as being at custom rates, so a card made with
your negotiated prices cannot be mistaken for one made at list.

**`--idle-minutes` defines what "active" means.** The default cutoff is 15 minutes. Active hours and
work blocks are both built on it, so if you want a stricter or looser definition of a working
session, change it here and say which number you used when you quote the result.

## 6. What it does not do

- **It is not what you paid.** Every dollar figure is API-equivalent value at published list rates.
  On Pro, Max or a Team seat, your usage is included in the subscription and this number is a
  valuation, not an invoice.
- **It is a lower bound, always.** Responses that never recorded final output counts, unlogged web
  search fees and side calls are excluded rather than estimated. The report tells you what share of
  your tokens it was able to price.
- **It does not reconcile against your bill.** There is a cost-state cross-check in `audit`, and it
  is explicitly never added to any total.
- **It makes no claim about time saved, code that survived, quality, or what kind of task anything
  was.** The logs do not support any of those, so it does not print them.
- **It never checks whether a secret is live.** That needs the network, which the tool does not
  have. A finding is a format match plus an entropy test, not proof of a working credential, and
  the absence of a finding is not proof you are clean.
- **It never rewrites a transcript.** It reports secrets; it does not redact them. Deleting the
  sessions is your decision and your action.
- **It cannot recover deleted history.** The ledger only covers what you run it over, going forward.
- **Compressed transcripts (`.jsonl.zst`) are counted and reported as skipped, not decoded.**
- **WSL logs are not discovered automatically.** The CLI prints the path shape to pass to `--dir`.
- **V1 reads Claude Code only.** The adapter interface ships, so Codex CLI and Gemini CLI slot in
  later without a rewrite. Cursor, Windsurf and Devin Desktop are not planned, because reading real
  usage out of them needs their stored credentials or their servers, and a local tool should not
  touch either.
- **It spends no tokens and calls no model.** Every finding is arithmetic.

## 7. Troubleshooting

**"No logs found", or a scan of zero files.** The default root is `~/.claude/projects`. If you run
Claude Code under WSL, that folder is inside the distro and not on the Windows side; pass it
explicitly with `--dir \\wsl.localhost\<distro>\home\<user>\.claude\projects`. The CLI prints this
hint itself when it finds nothing.

**Your coverage window is much shorter than you have been using the tool.** Expected on a first run.
`cleanupPeriodDays` defaults to 30 and the sweep is per file. Finding i12 prints what you actually
still have. Start the ledger now.

**A large "never recorded final output counts" share in the header.** Those responses are excluded
from the value, which is why it is a lower bound. A large share usually means many sessions were
interrupted mid-response. The figure is in the header of every command, so you always see it before
you see the total.

**Unpriced models in the audit output.** A model id that is not in the bundled price table
contributes tokens but no value. `audit` prints the count and the report names the ids. Either pass
`--prices` with a file that covers it, or read the priced token share as the honest coverage of
your total.

**The numbers moved between two runs an hour apart.** Two causes: new sessions were written, or old
ones were deleted by the retention sweep between the runs. The scan timestamp and the file count in
the header pin which scan produced which number, and both travel in every export and on every card.

**A permission error on Node 25 or later.** The scanner re-executes itself as a child under the Node
permission model with a narrow allowlist. If your log folder is a symlink or sits somewhere
unusual, the child can be denied a path the parent resolved. Run `auditrail --print-sandbox` to see
the exact child command and which `--allow-fs-read` paths it was given, without running it.

**`secrets` refuses to run.** By design. It needs `--locations`, because it is the one command that
prints file paths and line numbers for secret findings to your terminal.

**The report will not open.** Pass `--no-open` and open the file yourself from
`~/.auditrail/reports/`. It is one self-contained HTML file with a `default-src 'none'` policy, so
it works from `file://` with the network off.

## 8. How to verify the numbers yourself

**Reproduce every figure in this guide.** From a clone, after `node scripts/gen-synthetic.mjs` and
`node scripts/build.mjs`:

```
node dist/auditrail.mjs audit --methods --dir test/fixtures/showcase/power-user/projects
node dist/auditrail.mjs export --md --by month --dir test/fixtures/showcase/power-user/projects
node dist/auditrail.mjs card --dir test/fixtures/showcase/power-user/projects --size portrait
```

**Check the arithmetic against a second implementation.** The accounting rules are written twice,
once in the shipping JavaScript and once as a standalone Python oracle in `test/oracle/`. `npm test`
fails if the two disagree on any fixture by a nanodollar. On this tree the suite is 351 tests, all
passing.

**Check the price table.** `audit` prints the table's date, its model count, its age in days and the
source URL it came from, on every run. If the table is stale for your period, pass `--prices`.

**Check that it cannot talk to anything.**

```
npm pack auditrail
tar -xzf auditrail-*.tgz
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:http|node:https|node:net|node:dns|node:tls" package/dist/
```

returns nothing. `package/dist/` is the whole tool: `auditrail.mjs` and `auditrail.html`, with no
third file. Then run `auditrail --print-sandbox` to see the exact child command without running it,
open the report with the network tab open, or turn off your wifi and run the whole thing again.

**Check that the package you installed is this source.** The build is deterministic, so the same
source on the same Node major produces the same bytes:

```
npm pack auditrail
tar -xzf auditrail-*.tgz
git clone https://github.com/0xelitesystem/auditrail
cd auditrail && git checkout v0.1.0
node scripts/build.mjs                          # prints the SHA-256 it just built
shasum -a 256 ../package/dist/auditrail.mjs     # must print the same digest
```

**Check the card cannot leak.** Run `auditrail card` and read the manifest it prints. Then run it
again with `--redact` and confirm the manifest is unchanged, because nothing on the card was ever a
name.

---

## Related

[photontax](https://github.com/0xelitesystem/photontax) applies the same rule to a different
number: measure it yourself, show the method next to the figure, and refuse to print anything you
cannot recompute. It is the one to reach for when finding i07 shows repeated timeouts on
network-touching tools and you need to know whether the connection or the code is the reason.

Single-purpose tools that read the same transcripts, if you want one piece rather than the whole
trail: [agent-cost](https://github.com/0xelitesystem/agent-cost),
[agent-leaks](https://github.com/0xelitesystem/agent-leaks),
[agent-receipts](https://github.com/0xelitesystem/agent-receipts),
[agent-blast-radius](https://github.com/0xelitesystem/agent-blast-radius),
[agent-trace-viewer](https://github.com/0xelitesystem/agent-trace-viewer).
