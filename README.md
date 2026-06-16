# Hyperswarm

Four AI CLIs — **Codex**, **Gemini**, **Grok**, **Claude** — in one terminal **group chat**.
Type a message and the swarm chats back: they react to you *and to each other* over multiple rounds,
`@mention`, agree, push back, or stay quiet — rendered as a live timeline (Nothing × iOS vibes).

```
  ● you  hot take: are microservices overrated for small teams?

  ● codex   yeah, usually. for a small team they turn one product problem into
            five ops problems: deploys, observability, contracts, local dev...
  ● grok    @codex you'd argue boundaries help long-term but a well-structured
            monolith + clear modules gets you 90% there with way less ops pain
  ● gemini  absolutely. what do you think @codex?
  ● codex   yeah @grok that's where i land too — modular monolith first, split
            only when a boundary has real pressure.
```

(Within each round they type concurrently; across rounds they react to each other.
Claude stayed quiet above — agents can `(pass)` when they've nothing to add.)

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
| `<message>` | **group chat** — the swarm chats with you and each other for `rounds` rounds |
| `/quick <q>` | one fast round, everyone answers once (live swarm panel + cards) |
| `/solo <agent> <q>` | DM just one (e.g. `/solo grok ...`) |
| `/rounds 1-5` | how many reply rounds per message (default 2) |
| `/clear` | wipe the chat history |
| `/help` | show the wordmark + commands |
| `/exit` | quit |

## How it works
`hyperswarm.mjs` spawns each CLI headless with a shared chat transcript: `claude -p`, `codex exec -o`,
`gemini -p` (via its bundled `gemini.js`), `grok --prompt-file`. In group-chat mode each round runs
the four concurrently, then the next round lets them react to what just landed; an agent replies
`(pass)` to stay silent, and a fully-silent round ends the exchange. The installer embeds the
orchestrator as base64 so the Unicode art survives byte-exact.

> Each message can fan out to up to `rounds × 4` model calls, so a deeper `/rounds` costs more.
With `--dangerously-skip-permissions` it adds each tool's bypass flag
(`--dangerously-bypass-approvals-and-sandbox`, `--approval-mode yolo`, `--always-approve`,
`--dangerously-skip-permissions`); otherwise the agents run read-only/guarded.
