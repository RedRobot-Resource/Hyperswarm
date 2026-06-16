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

// ---------- colors / palette (Nothing dot-matrix x iOS) ----------
const C = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = C('90');
const grey = C('38;5;245');       // iOS secondary label
const faint = C('38;5;240');      // hairline
const RED = C('38;5;196');        // Nothing signature
const GOOD = C('38;5;78');        // soft green
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cols = () => process.stdout.columns || 80;
const hide = () => process.stdout.write('\x1b[?25l');
const show = () => process.stdout.write('\x1b[?25h');
function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const w of para.split(/\s+/)) {
      if (line && (line.length + 1 + w.length) > width) { out.push(line); line = w; }
      else line = line ? line + ' ' + w : w;
    }
    if (line) out.push(line);
  }
  return out;
}
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

// ---------- swarm UI ----------
const dotOf = (a) => C(a.color)('●');                 // colored bullet
const BRAILLE = '⠁⠂⠄⡀⢀⠠⠐⠈'.split(''); // buzzing particle
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');

// shimmering swarm field: dots flicker, the brightest carry an agent's color
function shimmer(width, frame) {
  let s = '';
  for (let i = 0; i < width; i++) {
    const v = (Math.sin(frame * 0.35 + i * 0.5) + Math.sin(frame * 0.13 + i * 1.7)) / 2;
    const n = (v + 1) / 2;
    if (n > 0.86) s += C(AGENTS[(i + frame) % AGENTS.length].color)('●');
    else if (n > 0.62) s += grey('•');
    else if (n > 0.42) s += faint('·');
    else s += ' ';
  }
  return s;
}

function agentRow(st, frame) {
  const a = st.agent, paint = C(a.color);
  const name = paint(a.name.toLowerCase().padEnd(7));
  const t = (((st.dt || (Date.now() - st.t0)) / 1000).toFixed(1) + 's').padStart(5);
  if (st.status === 'done') {
    return `  ${dotOf(a)} ${name}  ${paint('▰▰▰▰▰▰▰▰')}  ${GOOD('ready ✓')}  ${grey(t)}`;
  }
  const trail = Array.from({ length: 8 }, (_, i) => BRAILLE[(frame + i * 2) % BRAILLE.length]).join('');
  return `  ${dotOf(a)} ${name}  ${paint(trail)}  ${grey('swarming')}  ${grey(t)}`;
}

// live panel that updates in place while all agents work concurrently
function livePanel(states) {
  const PH = states.length + 4; // header, blank, rows..., blank, footer
  let first = true, frame = 0;
  function draw(finalize = false) {
    const f = frame++;
    const done = states.filter(s => s.status === 'done').length;
    const foot = finalize && done === states.length
      ? `  ${faint('─'.repeat(10))} ${grey(`swarm settled · ${done}/${states.length} replied`)}`
      : `  ${grey('swarming ' + states.length + ' minds')}${grey('.'.repeat(f % 4))}`;
    const lines = [`  ${shimmer(30, f)}`, '', ...states.map(s => agentRow(s, f)), '', foot];
    if (!first) process.stdout.write(`\x1b[${PH}A`);
    for (const l of lines) process.stdout.write('\x1b[2K' + l + '\n');
    first = false;
  }
  return { draw };
}

// iOS-clean answer card: colored bullet + name, hairline rule, wrapped body
function printCard(res, color) {
  const paint = C(color), bar = paint('│');
  const w = Math.min(cols() - 6, 96);
  const t = res.dt ? grey('  ·  ' + (res.dt / 1000).toFixed(1) + 's') : '';
  console.log(`  ${paint('●')} ${paint(bold(res.name.toLowerCase()))}${t}`);
  for (const l of wrap(res.text, w)) console.log(`  ${bar}  ${l}`);
  console.log('');
}

// single-line spinner for relay / solo
function miniSpin(a) {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${dotOf(a)} ${grey(a.name.toLowerCase() + ' ' + SPIN[i++ % SPIN.length] + ' thinking')}   `);
  }, 90);
  return () => { clearInterval(id); process.stdout.write('\r\x1b[2K'); };
}

// boot: a swarm of particles converges, then the dot-matrix wordmark settles in
async function boot() {
  if (ONCE) { logo(); return; }
  hide();
  const W = 38, H = 5, N = 46;
  const P = Array.from({ length: N }, () => ({
    sx: Math.random() * W, sy: Math.random() * H,
    tx: W / 2 + (Math.random() - 0.5) * W * 0.92, ty: Math.random() * H,
    c: AGENTS[Math.floor(Math.random() * AGENTS.length)].color,
  }));
  const F = 16;
  for (let f = 0; f <= F; f++) {
    const p = f / F, e = p * p * (3 - 2 * p); // smoothstep
    const grid = Array.from({ length: H }, () => Array(W).fill(null));
    for (const pt of P) {
      const x = Math.round(pt.sx + (pt.tx - pt.sx) * e);
      const y = Math.round(pt.sy + (pt.ty - pt.sy) * e);
      if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = { ch: f < F ? '·•●'[Math.min(2, Math.floor(p * 3))] : '●', c: pt.c };
    }
    const lines = grid.map(row => '  ' + row.map(c => c ? C(c.c)(c.ch) : ' ').join(''));
    if (f) process.stdout.write(`\x1b[${H}A`);
    for (const l of lines) process.stdout.write('\x1b[2K' + l + '\n');
    await sleep(48);
  }
  show();
  logo();
}

function logo() {
  console.log('');
  console.log('  ' + bold('H Y P E R S W A R M'));
  console.log('  ' + grey('four minds. one terminal.'));
  console.log('  ' + AGENTS.map(a => dotOf(a) + grey(' ' + a.name.toLowerCase())).join('   '));
  console.log('  ' + grey('permissions: ') + (SKIP ? RED('skipped') : grey('guarded')) + grey('   ·   /help'));
  console.log('');
}

function help() {
  logo();
  console.log(grey('  ask anything — the swarm replies concurrently.'));
  console.log(grey('  /relay <q>          reply in turn, each sees the last'));
  console.log(grey('  /solo <agent> <q>   ask just one'));
  console.log(grey('  /swarm  /relay      set default mode   ·   /clear  /help  /exit'));
  console.log('');
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

function swarmPrompt(agent, user) {
  const others = NAMES.filter(n => n !== agent.name).join(', ');
  return [
    `You are ${agent.name}, part of a four-AI swarm in a shared terminal (alongside ${others}).`,
    `All four of you are answering THIS prompt at the same time, so give your own best, distinctive take - don't wait for or defer to the others.`,
    `Be concise and direct. No preamble, no sign-off. Speak in first person as ${agent.name}.`,
    history.length ? `\nRecent conversation (context):\n${histText()}\n` : ``,
    `\nUser request:\n${user}\n\nYour response as ${agent.name}:`,
  ].join('\n');
}

// ---------- rounds ----------
// swarm: all four run concurrently; answers revealed in the order they FINISH (not a fixed order)
async function swarmRound(user) {
  history.push({ role: 'User', text: user });
  const states = AGENTS.map(a => ({ agent: a, status: 'thinking', t0: Date.now(), dt: 0, res: null, order: 0 }));
  const panel = livePanel(states);
  hide(); panel.draw();
  const anim = setInterval(() => panel.draw(), 80);
  let order = 0;
  await Promise.all(states.map(st =>
    runAgent(st.agent, swarmPrompt(st.agent, user)).then(res => {
      st.status = 'done'; st.dt = Date.now() - st.t0; st.res = { ...res, dt: st.dt }; st.order = ++order;
    })
  ));
  clearInterval(anim); panel.draw(true); show();
  console.log('');
  for (const st of [...states].sort((a, b) => a.order - b.order)) {
    printCard(st.res, st.agent.color);
    history.push({ role: st.res.name, text: st.res.text });
  }
}
// relay: sequential, each sees the prior replies this round
async function relayRound(user) {
  history.push({ role: 'User', text: user });
  let transcript = '';
  for (const a of AGENTS) {
    const t0 = Date.now(); hide(); const stop = miniSpin(a);
    const res = await runAgent(a, collabPrompt(a, user, transcript));
    stop(); show(); res.dt = Date.now() - t0;
    printCard(res, a.color);
    transcript += `${res.name}: ${res.text}\n\n`;
    history.push({ role: res.name, text: res.text });
  }
}
async function soloRound(name, user) {
  const agent = AGENTS.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!agent) { console.log(grey(`  unknown agent "${name}". try: ${NAMES.map(n => n.toLowerCase()).join(', ')}`) + '\n'); return; }
  history.push({ role: 'User', text: user });
  const t0 = Date.now(); hide(); const stop = miniSpin(agent);
  const res = await runAgent(agent, soloPrompt(agent, user));
  stop(); show(); res.dt = Date.now() - t0;
  printCard(res, agent.color);
  history.push({ role: res.name, text: res.text });
}

// ---------- main loop ----------
let mode = 'swarm';
async function handle(line) {
  const t = line.trim();
  if (!t) return;
  if (t === '/exit' || t === '/quit') { cleanup(); process.exit(0); }
  if (t === '/help') { help(); return; }
  if (t === '/clear') { history.length = 0; console.log(grey('  history cleared.') + '\n'); return; }
  if (t === '/swarm') { mode = 'swarm'; console.log(grey('  mode: swarm - all reply at once.') + '\n'); return; }
  if (t === '/relay') { mode = 'relay'; console.log(grey('  mode: relay - reply in turn, each sees the last.') + '\n'); return; }
  if (t.startsWith('/swarm ')) { await swarmRound(t.slice(7).trim()); return; }
  if (t.startsWith('/relay ')) { await relayRound(t.slice(7).trim()); return; }
  if (t.startsWith('/solo ')) {
    const rest = t.slice(6).trim(); const sp = rest.indexOf(' ');
    if (sp === -1) { console.log(grey(`  usage: /solo <agent> <question>`) + '\n'); return; }
    await soloRound(rest.slice(0, sp), rest.slice(sp + 1)); return;
  }
  if (mode === 'relay') await relayRound(t); else await swarmRound(t);
}

function cleanup() { show(); try { rmSync(TMP, { recursive: true, force: true }); } catch {} }

async function main() {
  if (ONCE) { await boot(); await swarmRound(ONCE); cleanup(); process.exit(0); }
  await boot();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: RED('  ● ') });
  rl.prompt();
  rl.on('line', async (line) => { await handle(line); rl.prompt(); });
  rl.on('close', () => { cleanup(); process.exit(0); });
}
process.on('SIGINT', () => { process.stdout.write('\n'); cleanup(); process.exit(0); });
main();
