# Hyperswarm

Five AI CLIs — **Codex**, **Gemini**, **Grok**, **Claude**, **Vibe** — as one **AI engineering team** in
your terminal. It works like Perplexity-in-a-terminal: **ask anything and an orchestrator routes your
question to the single best engineer**, who answers (and can build — writing files and running commands
in your working directory). Want the whole room? `/team` opens a group discussion. Rendered as a live
timeline with a Nothing × iOS thinking panel.

```
  ● you  fix the off-by-one in parse.js and add a test

  ◇ orchestrator routed to ● codex  ·  code
     best match for code: writing & running code, debugging, refactors, shell/file work
  ● codex  · code
  │  Fixed the loop bound in parse.js:42 and added parse.test.js. Tests pass (3/3).
  └─ answered by codex · 6.1s

  ● you  /team should we add caching to the API layer or is it premature?
  ● claude  Premature unless we have numbers. Caching trades correctness for speed...
  ● gemini  Agree — let's profile the hot endpoints first.
```

**The orchestrator** scores your question against each engineer's lane (code → Codex, reasoning →
Claude, research → Gemini, real-time/math → Grok, quick → Vibe) and routes to the best fit — instantly,
with no extra model call (the "fast engine": one answer, not a five-way fan-out). Toggle `/smart` to let
the fastest engineer pick the specialist instead, or `/route <agent>` to force one.

**Tools are ON by default** — agents can read/write files and run commands in the working directory.
Run with `--safe` for a read-only/guarded session.

## Install (one line)

```powershell
irm https://raw.githubusercontent.com/RedRobot-Resource/Hyperswarm/main/install.ps1 | iex
```

This installs the orchestrator to `~/Hyperswarm` and a `Hyperswarm` command to `~/.local/bin`.
Requires Node.js and the CLIs on PATH (`claude`, `codex`, `gemini`, `grok`, `vibe`). Missing ones are
simply skipped — the orchestrator only routes to engineers that are installed and authorized.

## Use

```powershell
Hyperswarm          # opens a new terminal window; tools ON, starts in your home dir
Hyperswarm --safe   # read-only/guarded session (no file changes or commands)
```

### First run / setup
On a new computer Hyperswarm shows a **setup screen** that detects each CLI and pings it to verify it's
authorized, with a login hint for any that aren't. Re-run anytime with `/setup`. Authorization results
are remembered in `~/.hyperswarm/config.json` (along with your theme, rounds, and disabled agents).

### In-session commands
| command | what it does |
|---|---|
| `<question>` | **orchestrator** routes it to the best engineer, who answers |
| `/route <agent> <q>` | force one engineer to answer |
| `/smart` | toggle smart routing (an engineer picks the specialist) vs instant heuristic |
| `/team <message>` | discuss with the whole team for `rounds` rounds; they react to each other |
| `/quick <q>` | quick opinion poll, everyone answers once (live swarm panel) |
| `@<agent> <msg>` | direct a message to one engineer (they build it) |
| `/solo <agent> <task>` | hand the task to one engineer — they build it (writes files, runs commands) |
| `/build <task>` | team plans the approach, then one engineer implements it |
| `/skill <name> [args]` | run a skill (`review`, `test`, `scaffold`, `fix`, `commit`, …) · `/skills` to list |
| `/skill-add <name> <tmpl>` | save your own skill (use `{args}`) |
| `/agents` · `/agent on\|off <name>` | roster: who's in the room |
| `/setup` · `/status` | re-authorize · show dir/tools/route/theme/agents |
| `/theme <name>` | `aurora` · `mono` · `neon` · `ember` |
| `/cd <path>` · `/pwd` | set / show the working directory |
| `/rounds 1-5` · `/save [file]` · `/retry` | team-chat depth · export transcript · re-run last message |
| `/clear` · `/help` · `/exit` | reset chat · help · quit |

Tab-completes commands, agent names, skills, and themes.

## How it works
`hyperswarm.mjs` spawns each CLI headless in the working directory with a shared transcript:
`claude -p`, `codex exec -o`, `gemini -p` (via its bundled `gemini.js`), `grok --prompt-file`,
`vibe -p`. **By default the orchestrator routes** — it scores your question against each engineer's lane
and sends it to one engineer (instant, no extra model call), so you get a single fast answer instead of
a five-way fan-out. `/smart` instead asks the fastest engineer to name the specialist. `/team` runs the
group chat: everyone concurrent per round, reacting across rounds; an agent replies `(pass)` to stay
silent, and a fully-silent round ends it. **Building goes through `/solo` / `@agent`** so one engineer
owns the files (no clobbering). With tools ON each CLI runs with its bypass flag (auto-approve), so
nothing blocks waiting for a prompt. The installer embeds the orchestrator as base64 so the Unicode art
survives byte-exact.

> Tools ON means agents can modify files and run commands in the working dir — use `/cd` to point them
> at the right project, or `--safe` for a read-only session. Each message fans out to up to `rounds × 4`
> model calls.
With `--dangerously-skip-permissions` it adds each tool's bypass flag
(`--dangerously-bypass-approvals-and-sandbox`, `--approval-mode yolo`, `--always-approve`,
`--dangerously-skip-permissions`); otherwise the agents run read-only/guarded.
