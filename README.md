# Auditrail

The audit trail your coding agents already wrote, priced at list, ranked by what to fix, and scanned for leaked secrets, entirely on your own machine. It reads the session logs that are already there and tells you what the work was worth, where the money went, and what to change. No account, no API key, no network call.

![The Auditrail share card, marked DEMO DATA, NOT REAL USAGE: archetype The Conductor, coverage Mar 2 to Aug 30 2026, 156 active days, at least $4.0K API-equivalent value at list price, 225 hours with your agent, 5.1K agent actions, 61 days in a row, 34% of the work done by subagents, and a weekday by hour heatmap with the busiest hour at 9 PM.](docs/media/auditrail-card.png)

*Synthetic demo data, which is why the image itself says so. This card was generated from a seeded fake persona that ships with the repo (`test/fixtures/showcase/power-user`), not from anyone's real sessions. The marker is drawn only for this project's own showcase images (`card --demo-mark`); your card never carries it. Yours is built from your own logs and never leaves your machine.*

**[Open the live demo](https://0xelitesystem.github.io/auditrail/)** to see the full report with nothing installed. It is one HTML file with the same synthetic data inside it.

<!-- Hero GIF slot: drop docs/media/auditrail.gif here once it is recorded. -->


## Install

```
npx auditrail
```

It reads `~/.claude/projects`, writes one self-contained HTML file, and opens it in your browser.
It takes a few seconds, spends zero tokens, and calls no model.
Nothing is uploaded, and there is nothing to sign up for.

`pnpm dlx auditrail` and `bunx auditrail` work too. Node 22 or later. Zero runtime dependencies.

## Use

Run it with no arguments. It scans `~/.claude/projects`, writes one self-contained HTML file to
`~/.auditrail/reports/`, and opens it in your browser. That is the whole loop, and for most people
it is the only step. Read the fix list, change one thing, run it again next week.

The other five commands work off the same scan and write something different:

```
auditrail                                  # the full HTML report, then opens it
auditrail card --size portrait             # one PNG share card, plus a manifest of the fields in it
auditrail audit --methods                  # receipts to the terminal: files, lines, dedup, prices
auditrail export --csv --by project        # a file for a spreadsheet or an invoice
auditrail remember                         # update the numbers-only ledger
auditrail secrets --locations              # which files hold each finding, terminal only
```

Flags worth knowing: `--out <file>` to choose where a file lands, `--no-open` to skip the browser,
`--dir <path>` to scan a projects folder somewhere else (a copied WSL folder, for example),
`--since` and `--until` to bound the window, `--redact` for share-safe project names, `--prices
<file>` for your own rates, and `--plan-price` to print the multiple against what you actually pay.
`auditrail --help` lists all of them.

Two of these are worth putting on a schedule. `auditrail remember` keeps your history once the
transcripts are deleted, and it only ever stores counts. `auditrail secrets --locations` is the one
to run before you share a machine or a backup.

## Why this exists

Your coding agent already writes a full transcript of every session to your own disk, and nothing
reads it. So you pay a flat subscription with no idea what the work under it was worth, what the
same work would cost at API rates, or which habits are burning most of it. In those same files,
in plain text, are the keys you pasted mid-session and the keys your agent read out of your config
files. And Claude Code deletes transcripts on a timer (`cleanupPeriodDays`, 30 days by default),
so the record is gone before anyone looks at it.

The tools that answer this ask you to upload the logs. Transcripts hold source code, file paths,
client names and credentials, which is the last thing to hand a third party in exchange for a usage
chart. So Auditrail does the arithmetic where the data already is: one file, zero dependencies, no
network permission, MIT licensed, so you can read every line of it before you run it.

## What you get

**You do not know what the AI work is worth.**
You are on a subscription, so the only number you ever see is the monthly charge. Auditrail prices every response in your logs at published API list rates and gives you the API-equivalent value by month, by model and by project. If you type in what you pay, it prints the multiple.
What people do with it: decide between a subscription and an API key, attach a per-project CSV to an internal allocation sheet, or put a defensible number on a client line item. Everything carries the method footnote, so the number can be checked instead of believed.

```
auditrail export --csv --by project
```

**You keep hitting walls and do not know why.**
The report is a fix list, and every item is arithmetic, not a model opinion. It shows how much of your value is context being re-written after breaks (come back an hour later and the cache write happens again), how much of the work your subagents are doing and what the same tokens would cost at a cheaper model's rates, which local hours your rate-limit windows start in, which tools fail most and where the same failure repeats in a loop, and which files the agent has edited dozens of times.
Each item states the figure, the number of events behind it, and one thing to change.

**Secrets are sitting in your transcripts in plain text.**
Every key you pasted, and every key your agent read out of a file, is on disk in a readable log. Auditrail scans for the common vendor key formats, private key blocks and tokens, and reports the type, a short fingerprint, how many copies exist and the newest date. It never prints the value, never writes it to an export, and never puts it on the card. It never checks whether a key is live, because that would need the network.
What you do next: rotate at the provider, then delete the sessions that hold the copies. `auditrail secrets --locations` prints the files and line numbers to your terminal, on explicit request only.

**Your history is being deleted right now.**
Claude Code deletes transcripts once they are older than `cleanupPeriodDays`, which is 30 days by default (see the Claude Code settings documentation). The sweep is per file, so how much history you actually still have depends on how you work, and it is not something anyone can tell you from the outside. The report measures it: your real coverage window, and how many days are already gone.
The fix is a ledger: `auditrail remember` stores counts and token totals, so a card made months from now still covers the whole run even after the transcripts are gone. What goes in it: per local day and hashed session, tokens by model, file class and hashed project key, plus tool-call counts by built-in name. What never goes in it: prompts, paths, file names, titles, tool inputs, secrets, raw session ids, and any model id that is not in the published price table (a gateway id can carry a cloud account number, so it is hashed). Turn it on now or the data is not there later.

**You want to post the numbers without leaking the job.**
One PNG, landscape or portrait, dark or light. It is drawn from an allowlisted schema, so a project name, a file path, a prompt or a secret cannot reach it even by mistake. Next to the card the tool prints a manifest: the exact list of fields the image contains. There is no hosted share page and no link with your data in it.

```
auditrail card --size portrait --theme dark
```

## Why the numbers are right

One API response is not one line in the log. A single response is written to the transcript several times as it streams and as tool results attach, and the same response can appear in more than one file. Every one of those lines carries the same usage counts. So if you add up every line you see, you count the same tokens over and over.

Auditrail deduplicates globally by response id before it prices anything, keeps the maximum usage per response rather than the first line it saw, reads subagent folders as well as the main session files, and prices 5 minute and 1 hour cache writes at their separate rates.

That matters more than it sounds. Measured against the correct total, in testing:

| Counting method | Effect on the value |
|---|---|
| Add up every usage line | about 2.7x too high |
| Deduplicate, but keep the first line instead of the largest | low on value |
| Read only the top level session files, skip the subagent folders | close to half the value missing |
| Price every cache write at the 5 minute rate | low by around a tenth |

Those are ratios, not a claim about your machine. Run

```
auditrail audit --methods
```

and it prints the same comparison computed on your own logs, along with lines versus responses, the dedup effect, excluded synthetic lines, how many responses never recorded final output counts, the dated price table with its source URL, any model it could not price, and a windowed cross-check against Claude Code's own cost records.

Two things to keep in mind about every dollar figure:

- It is API-equivalent value at list price. If you are on Pro or Max, it is **not** what you paid.
- It is a lower bound. Responses that never recorded final output counts, unlogged web search fees and side calls are left out rather than guessed. The report shows what share of your tokens it was able to price.

The accounting rules are implemented twice: once in the JavaScript that ships, and once in a standalone Python oracle in `test/oracle/`. The suite fails if the two disagree on any fixture by a nanodollar.

## Private by construction

- **No upload, no account, no key, no telemetry, no update check.** There is nothing to sign in to.
- **The report opens offline.** It is one file, and its Content Security Policy is `default-src 'none'` with `connect-src 'none'`.
- **The scanner runs in a sandbox.** The program you launch re-executes itself as a child under the Node permission model, with read access to your log folder, the program itself and a short list of settings files, and write access to exactly one output file. On Node 25 and later there is no `--allow-net`, so the runtime itself refuses sockets and DNS. The CLI prints that status on startup, on the line right after the version, taken from what the runtime actually enforces rather than from a promise in the source.

Check it yourself instead of taking the claim:

```
auditrail --print-sandbox
```

prints the exact child command, flags and all, without running it.

```
npm pack auditrail
tar -xzf auditrail-*.tgz
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:http|node:https|node:net|node:dns|node:tls" package/dist/
```

returns nothing. `package/dist/` is the whole tool: `auditrail.mjs`, the CLI, and `auditrail.html`, the browser app. There is no third file.

Then open the report, press F12, and watch the network tab stay empty while you click through it. Or turn off your wifi and run the whole thing again. It behaves the same.

### On the card, and never on the card

| On the card | Never on the card |
|---|---|
| Archetype and badges | Project, repo, folder or branch names |
| Coverage dates and active days | File names and paths |
| API-equivalent value, rounded down to two significant figures | Prompts, session titles, agent names |
| Hours with your agent, agent actions, longest streak | MCP server, skill or plugin names |
| Share of the work done by subagents | Model ids that are not in the published price table |
| Weekday by hour activity heatmap and busiest hour | Secret findings of any kind |
| Footer: scan date and time, number of files scanned, tool version, price table date | |

Rate-limit windows are opt in (`--card-include rate-limits`). Any stat can be dropped with `--card-hide <stat>`, except the footer, which always states when the card was made and from how many files.

`auditrail card` prints the manifest under the file path: the exact list of fields the image contains, with the exact text drawn for each. That list is generated from the same allowlisted object the renderer draws from, so it cannot under-report.

## Supported agents

**V1: Claude Code.** Verified against real logs across Claude Code 2.1.x, with Claude Code's own cost records used as an independent cross-check.

**Next: Codex CLI and Gemini CLI.** The adapter interface ships in V1, so these slot in without a rewrite. Both formats are already specified in upstream source; what they need is fixtures that cover the known traps.

**Not planned: Cursor, Windsurf, Devin Desktop.** Reading real usage out of these needs their stored credentials or their servers. A local tool should not touch either.

Adapter pull requests are welcome with synthetic fixtures. Never send a real transcript.

## Limitations

- Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days by default), so a first run usually covers far less than a year. The report prints your measured coverage instead of guessing at it. Nothing can recover what is already deleted; that is what the ledger is for, going forward.
- Every figure is API-equivalent value at list price. It is never what you paid, and it is not an invoice reconciliation.
- It is a lower bound. Responses with no final output counts, web search fees and unlogged side calls are excluded, not estimated.
- No claims about time saved, code that survived, quality, or what kind of task anything was. The logs do not support them.
- Compressed transcripts (`.jsonl.zst`) are counted and reported as skipped, not decoded.
- Windows Subsystem for Linux logs are not discovered automatically. The CLI prints a hint with the path to pass.

## FAQ

**Why does this differ from `/usage`?**
Different question. `/usage` shows your plan consumption. This prices what the same work would have cost at API list rates, which is a different number with a different purpose.

**Why is it a lower bound?**
Some responses never record final output counts, and some calls are never logged with usage at all. Those are left out rather than guessed at.

**Does it send anything anywhere?**
No. There is no network code in the bundle, and on Node 25 and later the scanner runs with sockets denied by the runtime. See "Private by construction" for the commands that let you check that yourself.

**Does it spend tokens or call a model?**
No. Every insight is arithmetic over your logs.

**Why not one big "total tokens" number?**
Output tokens, fresh input and cache reads are priced very differently. Adding them into one figure hides the thing you would act on.

**Can I use my own prices?**
Yes. `--prices <file>` takes a price file in Claude Code's `modelPricing` shape. The card then labels the value as being at custom rates.

**Is my data in the share card?**
Only the fields in the table above, the footer included. The card is built from an allowlist, `auditrail card` prints the manifest of exactly what the image contains next to the file path, and a test in the suite fails if a project name, a path, a prompt or a secret can reach it.

## Privacy

Everything runs on your machine. Auditrail reads the log files your coding agent already keeps, holds the results in memory, and writes one HTML file to a folder you choose. Nothing is uploaded, nothing is sent to any server, there is no account, no key, no telemetry and no update check. The report file itself has no network permissions. The share card is built from an allowlisted field list that cannot contain a project name, a path, a prompt or a secret. Secret findings are shown as a type and a fingerprint, never as the value, and they never appear in any export or on the card.

## Run locally

```
git clone https://github.com/0xelitesystem/auditrail
cd auditrail
node scripts/gen-synthetic.mjs      # build the synthetic fixtures
node scripts/build.mjs              # build dist/auditrail.mjs and dist/auditrail.html
node dist/auditrail.mjs         # run it
```

To see the demo without scanning anything, open `docs/index.html` in a browser. It works from `file://` with the network off.

## Build

One file in, one file out, no bundler and no dependencies. `node scripts/build.mjs` inlines the sources into `dist/auditrail.mjs` (the CLI) and `dist/auditrail.html` (the browser app), prints the byte count and the SHA-256, and fails if the bundle grows past its size gate. `node scripts/make-demo.mjs` rebuilds `docs/index.html` and the showcase card images from the synthetic fixture. `npm test` runs the suite with `node --test` and no test framework.

The build is deterministic: the same source on the same Node produces the same bytes. So you can check that the package you installed is this tree, without trusting a number printed in a readme:

```
npm pack auditrail
tar -xzf auditrail-*.tgz
git clone https://github.com/0xelitesystem/auditrail
cd auditrail && git checkout v0.1.0      # the tag matching the version you installed
node scripts/build.mjs                       # prints the SHA-256 it just built
shasum -a 256 ../package/dist/auditrail.mjs   # must print the same digest
```

The two digests are equal, on the same Node major. A digest pinned in prose here would only tell you what this file says about itself; rebuilding tells you what the bytes are.

## Related tools

Other things in this catalog that read the same transcripts, if you want one piece rather than the whole trail:

- [agent-cost](https://github.com/0xelitesystem/agent-cost) - retrospective token and cost forensics for a single session, with runaway-loop detection.
- [agent-leaks](https://github.com/0xelitesystem/agent-leaks) - scan and redact leaked secrets sitting in your agent transcripts, which is the finding this tool only reports.
- [agent-receipts](https://github.com/0xelitesystem/agent-receipts) - audit what your coding agent claimed against what it actually did.
- [agent-blast-radius](https://github.com/0xelitesystem/agent-blast-radius) - reconstruct every irreversible action an agent took in a session.
- [agent-trace-viewer](https://github.com/0xelitesystem/agent-trace-viewer) - visualize agent tool-call traces as a flame graph.

## License

MIT. Copyright (c) 2026 0xelitesystem. See [LICENSE](LICENSE).

## Third-party notices

Auditrail has zero runtime dependencies. One third-party item is bundled into `dist/`:

- **Inter typeface.** Copyright holder, copied verbatim from the Inter release's `LICENSE.txt`: `Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)`. Licensed under the SIL Open Font License, Version 1.1. Source: https://github.com/rsms/inter (release v4.1, files `extras/ttf/Inter-Regular.ttf` and `extras/ttf/Inter-SemiBold.ttf`). What was taken: the glyph outlines, pre-rasterized at build time by `scripts/build-glyphs.mjs` into a bitmap atlas that draws the text on the share card. The atlas is a derived form of the Font Software and stays under the OFL 1.1, not under the MIT license. The full license text is in [NOTICE](NOTICE).

Everything else is original. The Claude Code log format, the accounting rules and the pricing behaviour were measured empirically from log files and from published documentation. No code is reproduced here.

Auditrail is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic, or by any other company whose products it reads or whose names appear in it. All product names and trademarks are the property of their respective owners. The same statement is carried inside every artifact this project ships, so it travels with a report file that is forwarded on its own.

Built by [0xelitesystem](https://elitesystem.ai/).
