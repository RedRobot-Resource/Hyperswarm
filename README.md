# Hyperswarm

Four AI CLIs — **Codex**, **Gemini**, **Grok**, **Claude** — as one **AI engineering team** in your
terminal. Discuss a problem with the team, then hand the work to one of them and they actually build it
— writing files and running commands in your working directory. Rendered as a live timeline with a
Nothing × iOS thinking panel.

```
  ● you  should we add caching to the API layer or is it premature?

  ● claude  Premature unless we have numbers. Caching trades correctness for speed...
  ● codex   I'd hold off unless we have a concrete repeated-call path or measured latency.
  ● gemini  Agree it's premature — let's profile the hot endpoints first.

  ● you  /solo codex scaffold a fastify server with a /health route in ./api
  ● codex  created api/server.js, api/package.json, added a /health route. run: npm i && node server.js
```

**Tools are ON by default** — agents can read/write files and run commands in the working directory.
Run with `--safe` for a read-only/guarded session.

## Install (one line)

```powershell
irm https://raw.githubusercontent.com/RedRobot-Resource/Hyperswarm/main/install.ps1 | iex
```

This installs the orchestrator to `~/Hyperswarm` and a `Hyperswarm` command to `~/.local/bin`.
Requires Node.js and the four CLIs on PATH (`claude`, `codex`, `gemini`, `grok`).

## Use

```powershell
Hyperswarm          # opens a new terminal window; tools ON, starts in your home dir
Hyperswarm --safe   # read-only/guarded session (no file changes or commands)
```

### In-session commands
| command | what it does |
|---|---|
| `<message>` | **team chat** — discuss with the swarm for `rounds` rounds; they react to each other |
| `/solo <agent> <task>` | hand the task to one engineer — they build it (writes files, runs commands) |
| `/quick <q>` | quick opinion poll, everyone answers once (live swarm panel + cards) |
| `/cd <path>` · `/pwd` | set / show the working directory |
| `/rounds 1-5` | reply rounds per message (default 2) |
| `/clear` · `/help` · `/exit` | reset chat · help · quit |

## How it works
`hyperswarm.mjs` spawns each CLI headless in the working directory with a shared transcript:
`claude -p`, `codex exec -o`, `gemini -p` (via its bundled `gemini.js`), `grok --prompt-file`. The
team chat runs the four concurrently per round, then the next round lets them react; an agent replies
`(pass)` to stay silent, and a fully-silent round ends it. **Discussion is concurrent; building goes
through `/solo`** so one engineer owns the files (no four-way clobbering). With tools ON each CLI runs
with its bypass flag (auto-approve), so nothing blocks waiting for a prompt. The installer embeds the
orchestrator as base64 so the Unicode art survives byte-exact.

> Tools ON means agents can modify files and run commands in the working dir — use `/cd` to point them
> at the right project, or `--safe` for a read-only session. Each message fans out to up to `rounds × 4`
> model calls.
With `--dangerously-skip-permissions` it adds each tool's bypass flag
(`--dangerously-bypass-approvals-and-sandbox`, `--approval-mode yolo`, `--always-approve`,
`--dangerously-skip-permissions`); otherwise the agents run read-only/guarded.
