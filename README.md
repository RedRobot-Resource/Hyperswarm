# Hyperswarm

Four AI CLIs — **Codex**, **Gemini**, **Grok**, **Claude** — swarming in one terminal.
Ask a question and all four answer **concurrently**, color-coded and name-tagged, revealed in the
order they finish. A live dot-matrix swarm panel (Nothing × iOS vibes) animates while they think.

```
  ● codex    ▰▰▰▰▰▰▰▰  ready ✓   6.2s
  ● gemini   ⢀⠐⠁⠄⢀⠐⠁⠄  swarming  10.4s
  ● grok     ▰▰▰▰▰▰▰▰  ready ✓   4.8s
  ● claude   ▰▰▰▰▰▰▰▰  ready ✓   6.7s
  ────────── swarm settled · 4/4 replied

  ● grok    ·  4.8s
  │  A terminal UI feels premium when every keystroke gets an instant, predictable response...
```

## Install (one line)

```powershell
irm https://raw.githubusercontent.com/RedRobot-Resource/Hyperswarm/main/install.ps1 | iex
```

This installs the orchestrator to `~/Hyperswarm` and a `Hyperswarm` command to `~/.local/bin`.
Requires Node.js and the four CLIs on PATH (`claude`, `codex`, `gemini`, `grok`).

## Use

```powershell
Hyperswarm                                  # opens a new terminal window, guarded permissions
Hyperswarm --dangerously-skip-permissions   # same, but every CLI runs with approvals skipped
```

### In-session commands
| command | what it does |
|---|---|
| `<question>` | **swarm round** — all four answer concurrently, revealed as they finish |
| `/relay <q>` | reply in turn, each one seeing the previous replies |
| `/solo <agent> <q>` | ask just one (e.g. `/solo grok ...`) |
| `/swarm` / `/relay` | switch the default mode |
| `/clear` | wipe shared conversation history |
| `/help` | show the wordmark + commands |
| `/exit` | quit |

## How it works
`hyperswarm.mjs` spawns each CLI headless and (in swarm mode) runs them concurrently with a shared
history: `claude -p`, `codex exec -o`, `gemini -p` (via its bundled `gemini.js`), `grok --prompt-file`.
The installer embeds the orchestrator as base64 so the Unicode swarm art survives byte-exact.
With `--dangerously-skip-permissions` it adds each tool's bypass flag
(`--dangerously-bypass-approvals-and-sandbox`, `--approval-mode yolo`, `--always-approve`,
`--dangerously-skip-permissions`); otherwise the agents run read-only/guarded.
