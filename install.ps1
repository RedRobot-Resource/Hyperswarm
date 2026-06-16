# Hyperswarm installer (self-contained). Installs the orchestrator + the `Hyperswarm` command.
# One-liner (this or any future machine):
#   irm https://raw.githubusercontent.com/RedRobot-Resource/Hyperswarm/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
Write-Host "`n  Installing Hyperswarm..." -ForegroundColor Cyan
$home0  = $env:USERPROFILE
$appDir = Join-Path $home0 'Hyperswarm'
$binDir = Join-Path $home0 '.local\bin'
New-Item -ItemType Directory -Force -Path $appDir, $binDir | Out-Null
$dstMjs = Join-Path $appDir 'hyperswarm.mjs'

# --- check the four CLIs + node are present ---
foreach ($t in 'node','claude','codex','gemini','grok') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
    Write-Host "  ! '$t' not found on PATH - install it so the swarm can call it." -ForegroundColor Yellow
  }
}

# --- write the orchestrator (literal, single-quoted here-string) ---
$mjs = @'
#!/usr/bin/env node
// Hyperswarm - 4 AI CLIs (Codex, Gemini, Grok, Claude) collaborating in one terminal.
// They see each other's answers and reply by name, color-coded. They can also work solo/parallel.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------- flags ----------
const RAW = (process.argv.slice(2).join(' ') + ' ' + (process.env.HYPERSWARM_ARGS || '')).toLowerCase();
const SKIP = RAW.includes('--dangerously-skip-permissions') || RAW.includes('--yolo');
const ONCE_IDX = process.argv.indexOf('--once');
const ONCE = ONCE_IDX !== -1 ? process.argv.slice(ONCE_IDX + 1).join(' ') : null;

// ---------- colors ----------
const C = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = C('90'), bold = (s) => `\x1b[1m${s}\x1b[0m`;
const TMP = mkdtempSync(join(tmpdir(), 'hyperswarm-'));

// ---------- resolve CLIs on PATH (no shell, so prompts never get re-parsed) ----------
function which(name) {
  const exts = ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')];
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { if (statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
const NODE = process.execPath;
function geminiEntry() {
  const shim = which('gemini');
  if (shim) {
    const js = join(dirname(shim), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    try { if (statSync(js).isFile()) return js; } catch {}
  }
  return null;
}
const PATHS = { codex: which('codex'), claude: which('claude'), grok: which('grok'), geminiJs: geminiEntry(), gemini: which('gemini') };

// ---------- agent definitions ----------
// build(promptText) -> { cmd, args, stdin, outFile, shell } for spawning.
const AGENTS = [
  {
    name: 'Codex',  color: '36', // cyan
    build: (txt) => {
      const out = join(TMP, 'codex-out.txt');
      const args = ['exec', '--skip-git-repo-check', '--color', 'never', '-o', out];
      if (SKIP) args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('-s', 'read-only');
      return { cmd: PATHS.codex || 'codex', args, stdin: txt, outFile: out, shell: !PATHS.codex };
    },
  },
  {
    name: 'Gemini', color: '94', // bright blue
    build: (txt) => {
      // Gemini rejects -p combined with stdin, so pass the whole prompt as the -p value (no shell = no quoting issues).
      const tail = ['-p', txt, '-o', 'text', '--approval-mode', SKIP ? 'yolo' : 'default'];
      if (PATHS.geminiJs) return { cmd: NODE, args: [PATHS.geminiJs, ...tail], stdin: null, shell: false };
      return { cmd: PATHS.gemini || 'gemini', args: tail, stdin: null, shell: true };
    },
  },
  {
    name: 'Grok',   color: '32', // green
    build: (txt) => {
      const pf = join(TMP, 'grok-in.txt');
      writeFileSync(pf, txt, 'utf8');
      const args = ['--prompt-file', pf];
      if (SKIP) args.push('--always-approve');
      return { cmd: PATHS.grok || 'grok', args, stdin: null, shell: !PATHS.grok };
    },
  },
  {
    name: 'Claude', color: '38;5;208', // orange
    build: (txt) => {
      const args = ['-p', '--output-format', 'text'];
      if (SKIP) args.push('--dangerously-skip-permissions');
      return { cmd: PATHS.claude || 'claude', args, stdin: txt, shell: !PATHS.claude };
    },
  },
];
const NAMES = AGENTS.map(a => a.name);

// ---------- spawn one agent ----------
function runAgent(agent, promptText) {
  return new Promise((resolve) => {
    const spec = agent.build(promptText);
    const child = spawn(spec.cmd, spec.args, { shell: !!spec.shell, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 240000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    if (spec.stdin != null) { child.stdin.write(spec.stdin); child.stdin.end(); }
    else { try { child.stdin.end(); } catch {} }
    child.on('error', e => { clearTimeout(timer); resolve({ name: agent.name, text: `(failed to launch: ${e.message})`, ok: false }); });
    child.on('close', () => {
      clearTimeout(timer);
      let text = out;
      if (spec.outFile) { try { const f = readFileSync(spec.outFile, 'utf8').trim(); if (f) text = f; } catch {} }
      text = clean(text);
      if (!text) text = clean(err) || '(no response)';
      resolve({ name: agent.name, text, ok: true });
    });
  });
}

function clean(s) {
  return (s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // strip ANSI color codes
    .replace(/\r/g, '')
    .trim();
}

// ---------- pretty print ----------
function printAgent({ name, text }, color) {
  const paint = C(color);
  const head = paint(bold(`${name} > `));
  const pad = ' '.repeat(name.length + 3);
  const lines = text.split('\n');
  process.stdout.write(head + paint(lines[0] || '') + '\n');
  for (const l of lines.slice(1)) process.stdout.write(paint(pad + l) + '\n');
  process.stdout.write('\n');
}

function spinner(label) {
  const f = '|/-\\'.split('');
  let i = 0;
  const id = setInterval(() => { process.stdout.write(`\r${dim(f[i++ % f.length] + ' ' + label + '...')}   `); }, 120);
  return () => { clearInterval(id); process.stdout.write('\r' + ' '.repeat(label.length + 8) + '\r'); };
}

// ---------- prompts ----------
const history = [];
function histText() {
  return history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n\n');
}
function collabPrompt(agent, user, transcript) {
  const others = NAMES.filter(n => n !== agent.name).join(', ');
  return [
    `You are ${agent.name}, one of four AI CLIs collaborating live in a shared terminal called Hyperswarm. The others are ${others}.`,
    `Rules:`,
    `- Be concise and direct. No preamble, no sign-off.`,
    `- Speak in first person as ${agent.name}.`,
    transcript ? `- Teammates already responded below. Build on, correct, or add to them - do NOT repeat what they said.` : `- You are first to respond this round; give a strong useful answer the others can build on.`,
    ``,
    `User request:`,
    user,
    ``,
    transcript ? `Teammates' responses so far this round:\n${transcript}\n` : ``,
    history.length ? `Recent conversation (context):\n${histText()}\n` : ``,
    `Your response as ${agent.name}:`,
  ].join('\n');
}
function soloPrompt(agent, user) {
  return [
    `You are ${agent.name}. Answer the user directly and concisely. Speak in first person as ${agent.name}.`,
    history.length ? `\nRecent conversation (context):\n${histText()}\n` : ``,
    `\nUser request:\n${user}\n\nYour response:`,
  ].join('\n');
}

// ---------- rounds ----------
async function collabRound(user) {
  history.push({ role: 'User', text: user });
  let transcript = '';
  for (const agent of AGENTS) {
    const stop = spinner(`${agent.name} is thinking`);
    const res = await runAgent(agent, collabPrompt(agent, user, transcript));
    stop();
    printAgent(res, agent.color);
    transcript += `${res.name}: ${res.text}\n\n`;
    history.push({ role: res.name, text: res.text });
  }
}
async function parallelRound(user) {
  history.push({ role: 'User', text: user });
  const stop = spinner('All four working independently');
  const results = await Promise.all(AGENTS.map(a => runAgent(a, soloPrompt(a, user))));
  stop();
  for (let i = 0; i < results.length; i++) { printAgent(results[i], AGENTS[i].color); history.push({ role: results[i].name, text: results[i].text }); }
}
async function soloRound(name, user) {
  const agent = AGENTS.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!agent) { console.log(dim(`Unknown agent "${name}". Try: ${NAMES.join(', ')}`)); return; }
  history.push({ role: 'User', text: user });
  const stop = spinner(`${agent.name} is thinking`);
  const res = await runAgent(agent, soloPrompt(agent, user));
  stop();
  printAgent(res, agent.color);
  history.push({ role: res.name, text: res.text });
}

// ---------- banner ----------
function banner() {
  const tag = AGENTS.map(a => C(a.color)(bold(a.name))).join(dim(' | '));
  console.log('');
  console.log(bold('  HYPERSWARM') + dim('  -  four minds, one terminal'));
  console.log('  ' + tag);
  console.log(dim(`  mode: collab   permissions: ${SKIP ? '\x1b[31mSKIPPED (dangerous)\x1b[0m\x1b[90m' : 'guarded'}`));
  console.log(dim('  commands: /parallel <q>  /solo <agent> <q>  /collab  /clear  /help  /exit'));
  console.log('');
}

// ---------- main loop ----------
let mode = 'collab';
async function handle(line) {
  const t = line.trim();
  if (!t) return;
  if (t === '/exit' || t === '/quit') { cleanup(); process.exit(0); }
  if (t === '/help') { banner(); return; }
  if (t === '/clear') { history.length = 0; console.log(dim('  history cleared.\n')); return; }
  if (t === '/collab') { mode = 'collab'; console.log(dim('  mode: collab (they reply to each other in turn)\n')); return; }
  if (t === '/parallel') { mode = 'parallel'; console.log(dim('  mode: parallel (all answer independently at once)\n')); return; }
  if (t.startsWith('/parallel ')) { await parallelRound(t.slice(10).trim()); return; }
  if (t.startsWith('/solo ')) {
    const rest = t.slice(6).trim(); const sp = rest.indexOf(' ');
    if (sp === -1) { console.log(dim(`  usage: /solo <agent> <question>`)); return; }
    await soloRound(rest.slice(0, sp), rest.slice(sp + 1)); return;
  }
  if (mode === 'parallel') await parallelRound(t); else await collabRound(t);
}

function cleanup() { try { rmSync(TMP, { recursive: true, force: true }); } catch {} }

async function main() {
  if (ONCE) { banner(); await collabRound(ONCE); cleanup(); process.exit(0); }
  banner();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: bold('\x1b[35myou >\x1b[0m ') });
  rl.prompt();
  rl.on('line', async (line) => { await handle(line); rl.prompt(); });
  rl.on('close', () => { cleanup(); process.exit(0); });
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
main();

'@
Set-Content -Path $dstMjs -Value $mjs -Encoding ascii

# --- write the launcher: opens a NEW terminal window running the swarm ---
$cmd = @"
@echo off
setlocal
set "HYPERSWARM_ARGS=%*"
where wt >nul 2>nul
if %errorlevel%==0 (
  start "" wt -w new --title Hyperswarm cmd /k node "$dstMjs"
) else (
  start "Hyperswarm" cmd /k node "$dstMjs"
)
endlocal
"@
Set-Content -Path (Join-Path $binDir 'Hyperswarm.cmd') -Value $cmd -Encoding ascii

# --- ensure ~/.local/bin is on PATH ---
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  $env:Path += ";$binDir"
  Write-Host "  Added $binDir to PATH (restart shells to pick it up)." -ForegroundColor DarkGray
}
Write-Host "`n  Hyperswarm installed." -ForegroundColor Green
Write-Host "  Run:  Hyperswarm" -ForegroundColor White
Write-Host "  Or :  Hyperswarm --dangerously-skip-permissions`n" -ForegroundColor White