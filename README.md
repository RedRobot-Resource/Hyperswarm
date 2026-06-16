# Hyperswarm

Four AI CLIs — **Codex**, **Gemini**, **Grok**, **Claude** — collaborating in one terminal.
Ask a question and they answer in turn, each one color-coded and stating its name, building on
(or correcting) what the others just said. They can also work independently.

```
you > how should we split a 1000-page scanned PDF into per-patient packets?

Codex  > I'd OCR, detect patient-boundary pages, validate ranges, export encrypted packets.
Gemini > Building on Codex, split whenever a new Medical Record Number appears in the header.
Grok   > Cluster pages by matching patient IDs and queue ambiguous boundaries for review.
Claude > Page-stream segmentation beats per-page MRN matching; carry the last ID forward...
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
| `<question>` | collab round — all four answer in turn, seeing each other |
| `/parallel <q>` | all four answer at once, independently |
| `/solo <agent> <q>` | ask just one (e.g. `/solo grok ...`) |
| `/collab` / `/parallel` | switch the default mode |
| `/clear` | wipe shared conversation history |
| `/help` | show the banner again |
| `/exit` | quit |

## How it works
`hyperswarm.mjs` spawns each CLI headless and pipes a shared transcript between them:
`claude -p`, `codex exec -o`, `gemini -p` (via its bundled `gemini.js`), `grok --prompt-file`.
With `--dangerously-skip-permissions` it adds each tool's bypass flag
(`--dangerously-bypass-approvals-and-sandbox`, `--approval-mode yolo`, `--always-approve`,
`--dangerously-skip-permissions`); otherwise the agents run read-only/guarded.
