#!/usr/bin/env node
// Hyperswarm - an AI engineering team (Codex, Gemini, Grok, Claude) in one terminal.
// Discuss with the team, then hand work to one engineer who actually builds it (files + commands).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

// ---------- flags ----------
const RAW = (process.argv.slice(2).join(' ') + ' ' + (process.env.HYPERSWARM_ARGS || '')).toLowerCase();
const SAFE = RAW.includes('--safe') || RAW.includes('--no-tools');
const SKIP = !SAFE;                 // tools ON by default (agents edit files / run commands); --safe = read-only
const ONCE_IDX = process.argv.indexOf('--once');
const ONCE = ONCE_IDX !== -1 ? process.argv.slice(ONCE_IDX + 1).join(' ') : null;
let cwd = process.cwd() || homedir();

// ---------- Phase 2: persistent config (~/.hyperswarm/config.json) ----------
const CFG_DIR = join(homedir(), '.hyperswarm');
const CFG_FILE = join(CFG_DIR, 'config.json');
const config = { setupDone: false, rounds: 2, theme: 'aurora', disabled: [], skills: {}, lastCwd: null, smart: false, defaultAgent: 'Claude' };
function loadConfig() { try { Object.assign(config, JSON.parse(readFileSync(CFG_FILE, 'utf8'))); } catch {} }
function saveConfig() { try { mkdirSync(CFG_DIR, { recursive: true }); config.lastCwd = cwd; writeFileSync(CFG_FILE, JSON.stringify(config, null, 2)); } catch {} }
loadConfig();
if (config.lastCwd) { try { if (statSync(config.lastCwd).isDirectory()) cwd = config.lastCwd; } catch {} }
let rounds = Math.min(5, Math.max(1, config.rounds || 2));
const authState = {};   // name -> { ok, dt }
if (config.auth) Object.assign(authState, config.auth);   // remember last authorization across sessions

// ---------- Phase 9: themes + color helpers ----------
const C = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = C('90'), grey = C('38;5;245'), faint = C('38;5;240'), GOOD = C('38;5;78');
const THEMES = {
  aurora: { codex: '38;5;44',    gemini: '38;5;111',   grok: '38;5;78',    claude: '38;5;215',  vibe: '38;5;205',  orch: '38;5;141',  accent: '38;5;205' },
  mono:   { codex: '38;5;252',   gemini: '38;5;246',   grok: '38;5;255',   claude: '38;5;240',  vibe: '38;5;248',  orch: '38;5;250',  accent: '38;5;160' },
  neon:   { codex: '38;5;51',    gemini: '38;5;201',   grok: '38;5;46',    claude: '38;5;214',  vibe: '38;5;198',  orch: '38;5;99',   accent: '38;5;201' },
  ember:  { codex: '38;5;214',   gemini: '38;5;203',   grok: '38;5;179',   claude: '38;5;167',  vibe: '38;5;211',  orch: '38;5;222',  accent: '38;5;202' },
};
const pal = () => THEMES[config.theme] || THEMES.aurora;
const aColor = (a) => pal()[a.key];
const accent = (s) => C(pal().accent)(s);
const orch = (s) => C(pal().orch)(s);

// ---------- base helpers ----------
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
function clean(s) { return (s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim(); }
function usableErr(err) {
  return clean(err).split('\n').filter(l => l.trim() &&
    !/^Warning:/i.test(l) && !/256-color/i.test(l) && !/Ripgrep is not available/i.test(l) &&
    !/Falling back to/i.test(l) && !/DeprecationWarning|ExperimentalWarning|\(node:|--trace-/i.test(l)
  ).join('\n').trim();
}
function stripPass(t) {
  const s = String(t || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s || /^\(?\s*pass\s*\)?\.?$/i.test(s)) return '';
  return s;
}
const isBad = (t) => /^\((no response|failed to launch)/.test(t || '');
// A response that's really a CLI crash / auth failure, not an answer (so the orchestrator can reroute).
const FAIL_SIGS = [
  /IneligibleTierError|throwIneligible|_doSetupUser/i, /\/bundle\/chunk-/i, /\n\s+at\s+\S+/, // stack dumps
  /Error authenticating/i, /unexpected critical error/i, /please migrate to/i,
  /\bnot (logged in|authenticated)\b/i, /please (run\s+\S+\s+)?(log ?in|sign ?in)/i,
  /(missing|no|invalid)\b.{0,12}\bapi key/i, /is not recognized as an internal/i, /command not found/i,
  /EADDRINUSE|ECONNREFUSED|ENOTFOUND/i,
];
function looksFailed(t) { const s = clean(t); return !s || FAIL_SIGS.some(re => re.test(s)); }
const TMP = mkdtempSync(join(tmpdir(), 'hyperswarm-'));

// ---------- resolve CLIs on PATH (no shell, so prompts never get re-parsed) ----------
function which(name) {
  const exts = ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')];
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    for (const ext of exts) { const p = join(dir, name + ext); try { if (statSync(p).isFile()) return p; } catch {} }
  }
  return null;
}
const NODE = process.execPath;
function geminiEntry() {
  const shim = which('gemini');
  if (shim) { const js = join(dirname(shim), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'); try { if (statSync(js).isFile()) return js; } catch {} }
  return null;
}
const PATHS = { codex: which('codex'), claude: which('claude'), grok: which('grok'), geminiJs: geminiEntry(), gemini: which('gemini'), vibe: which('vibe') };

// ---------- agents ----------
const AGENTS = [
  { name: 'Codex', key: 'codex',
    build: (txt) => {
      const out = join(TMP, 'codex-out.txt');
      const args = ['exec', '--skip-git-repo-check', '--color', 'never', '-o', out];
      if (SKIP) args.push('--dangerously-bypass-approvals-and-sandbox'); else args.push('-s', 'read-only');
      return { cmd: PATHS.codex || 'codex', args, stdin: txt, outFile: out, shell: !PATHS.codex };
    } },
  { name: 'Gemini', key: 'gemini',
    build: (txt) => {
      const tail = ['-p', txt, '-o', 'text', '--approval-mode', SKIP ? 'yolo' : 'default'];
      if (PATHS.geminiJs) return { cmd: NODE, args: [PATHS.geminiJs, ...tail], stdin: null, shell: false };
      return { cmd: PATHS.gemini || 'gemini', args: tail, stdin: null, shell: true };
    } },
  { name: 'Grok', key: 'grok',
    build: (txt) => {
      const pf = join(TMP, 'grok-in.txt'); writeFileSync(pf, txt, 'utf8');
      const args = ['--prompt-file', pf]; if (SKIP) args.push('--always-approve');
      return { cmd: PATHS.grok || 'grok', args, stdin: null, shell: !PATHS.grok };
    } },
  { name: 'Claude', key: 'claude',
    build: (txt) => {
      const args = ['-p', '--output-format', 'text']; if (SKIP) args.push('--dangerously-skip-permissions');
      return { cmd: PATHS.claude || 'claude', args, stdin: txt, shell: !PATHS.claude };
    } },
  { name: 'Vibe', key: 'vibe',
    build: (txt) => {
      const args = ['-p', txt, '--output', 'text', '--trust', '--workdir', cwd];
      if (SKIP) args.push('--yolo');
      return { cmd: PATHS.vibe || 'vibe', args, stdin: null, shell: !PATHS.vibe };
    } },
];
const NAMES = AGENTS.map(a => a.name);
const findAgent = (n) => AGENTS.find(a => a.name.toLowerCase() === String(n).toLowerCase());
const installed = (a) => a.key === 'gemini' ? !!(PATHS.geminiJs || PATHS.gemini) : !!PATHS[a.key];
const activeAgents = () => AGENTS.filter(a => !config.disabled.includes(a.name) && installed(a) && authState[a.name]?.ok !== false);

// ---------- spawn one agent ----------
function runAgent(agent, promptText, signal, timeout = 600000) {
  return new Promise((resolve2) => {
    const spec = agent.build(promptText);
    const child = spawn(spec.cmd, spec.args, { shell: !!spec.shell, windowsHide: true, cwd });
    let out = '', err = '', settled = false;
    const kill = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(kill, timeout);
    const onAbort = kill;
    if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const done = (text, ok) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) try { signal.removeEventListener('abort', onAbort); } catch {} resolve2({ name: agent.name, text, ok }); };
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    if (spec.stdin != null) { try { child.stdin.write(spec.stdin); child.stdin.end(); } catch {} } else { try { child.stdin.end(); } catch {} }
    child.on('error', e => done(`(failed to launch: ${e.message})`, false));
    child.on('close', () => {
      let text = out;
      if (spec.outFile) { try { const f = readFileSync(spec.outFile, 'utf8').trim(); if (f) text = f; } catch {} }
      text = clean(text);
      if (!text) text = usableErr(err) || '(no response)';
      done(text, true);
    });
  });
}
// Phase 10: ask = runAgent + one auto-retry on empty/failed, with timing
async function ask(agent, prompt, opts = {}) {
  const { signal, timeout = 600000, retry = true } = opts;
  const t0 = Date.now();
  let res = await runAgent(agent, prompt, signal, timeout);
  if (retry && !(signal && signal.aborted) && isBad(res.text)) res = await runAgent(agent, prompt, signal, timeout);
  res.dt = Date.now() - t0;
  if (!isBad(res.text)) authState[agent.name] = { ok: true, dt: res.dt };
  return res;
}

// ---------- swarm UI ----------
const dotOf = (a) => C(aColor(a))('●');
const BRAILLE = '⠁⠂⠄⡀⢀⠠⠐⠈'.split('');
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
function shimmer(width, frame) {
  let s = '';
  for (let i = 0; i < width; i++) {
    const v = (Math.sin(frame * 0.35 + i * 0.5) + Math.sin(frame * 0.13 + i * 1.7)) / 2, n = (v + 1) / 2;
    if (n > 0.86) s += C(aColor(AGENTS[(i + frame) % AGENTS.length]))('●');
    else if (n > 0.62) s += grey('•'); else if (n > 0.42) s += faint('·'); else s += ' ';
  }
  return s;
}
function agentRow(st, frame) {
  const a = st.agent, paint = C(aColor(a));
  const name = paint(a.name.toLowerCase().padEnd(7));
  const t = (((st.dt || (Date.now() - st.t0)) / 1000).toFixed(1) + 's').padStart(5);
  if (st.status === 'done') return `  ${dotOf(a)} ${name}  ${paint('▰▰▰▰▰▰▰▰')}  ${GOOD('ready ✓')}  ${grey(t)}`;
  const trail = Array.from({ length: 8 }, (_, i) => BRAILLE[(frame + i * 2) % BRAILLE.length]).join('');
  return `  ${dotOf(a)} ${name}  ${paint(trail)}  ${grey('swarming')}  ${grey(t)}`;
}
function livePanel(states) {
  const PH = states.length + 4; let first = true, frame = 0;
  function draw(finalize = false) {
    const f = frame++; const done = states.filter(s => s.status === 'done').length;
    const foot = finalize && done === states.length
      ? `  ${faint('─'.repeat(10))} ${grey(`settled · ${done}/${states.length} replied`)}`
      : `  ${grey('working ' + states.length)}${grey('.'.repeat(f % 4))}`;
    const lines = [`  ${shimmer(30, f)}`, '', ...states.map(s => agentRow(s, f)), '', foot];
    if (!first) process.stdout.write(`\x1b[${PH}A`);
    for (const l of lines) process.stdout.write('\x1b[2K' + l + '\n');
    first = false;
  }
  return { draw };
}
function printCard(res, color) {
  const paint = C(color), bar = paint('│');
  const w = Math.min(cols() - 6, 96);
  const t = res.dt ? grey('  ·  ' + (res.dt / 1000).toFixed(1) + 's') : '';
  console.log(`  ${paint('●')} ${paint(bold(res.name.toLowerCase()))}${t}`);
  for (const l of wrap(res.text, w)) console.log(`  ${bar}  ${l}`);
  console.log('');
}
function chatLines(agent, text) {
  const paint = C(aColor(agent));
  const label = ('● ' + agent.name.toLowerCase()).padEnd(9);
  const indent = ' '.repeat(2 + label.length + 1);
  const wrapped = wrap(text, Math.min(cols() - indent.length, 88));
  const out = ['  ' + paint(label) + ' ' + (wrapped[0] || '')];
  for (const l of wrapped.slice(1)) out.push(indent + l);
  out.push('');
  return out;
}
function typingGlyphs(typing, frame) {
  const parts = AGENTS.filter(a => typing.has(a.name)).map(a => {
    const tr = Array.from({ length: 4 }, (_, i) => BRAILLE[(frame + i * 2 + a.name.length) % BRAILLE.length]).join('');
    return `${dotOf(a)} ${C(aColor(a))(a.name.toLowerCase())} ${C(aColor(a))(tr)}`;
  });
  return parts.length ? '  ' + parts.join('   ') : '';
}
function thinkingStage(getTyping) {
  const W = Math.min((cols() || 80) - 4, 44), H = 3;
  let drawn = false, frame = 0;
  const w = (s) => process.stdout.write(s);
  function lines() {
    const shim = '  ' + shimmer(W, frame);
    const glyphs = typingGlyphs(getTyping(), frame) || ('  ' + faint('· · ·'));
    const txt = ' swarm thinking ', dash = Math.max(0, W - txt.length), l = (dash / 2) | 0;
    const label = '  ' + faint('┄'.repeat(l)) + grey(txt) + faint('┄'.repeat(dash - l));
    return [shim, glyphs, label];
  }
  function draw() { if (drawn) w(`\x1b[${H}A`); w('\x1b[0J'); w(lines().join('\n') + '\n'); drawn = true; }
  return {
    start() { hide(); draw(); }, tick() { frame++; draw(); },
    above(ls) { if (drawn) { w(`\x1b[${H}A`); drawn = false; } w('\x1b[0J'); for (const x of ls) w(x + '\n'); draw(); },
    stop() { if (drawn) { w(`\x1b[${H}A`); drawn = false; } w('\x1b[0J'); show(); },
  };
}
function miniSpin(a) {
  let i = 0;
  const id = setInterval(() => process.stdout.write(`\r  ${dotOf(a)} ${grey(a.name.toLowerCase() + ' ' + SPIN[i++ % SPIN.length] + ' working')}   `), 90);
  return () => { clearInterval(id); process.stdout.write('\r\x1b[2K'); };
}
async function boot() {
  if (ONCE) { logo(); return; }
  hide();
  const W = 38, H = 5, N = 46;
  const P = Array.from({ length: N }, () => ({ sx: Math.random() * W, sy: Math.random() * H, tx: W / 2 + (Math.random() - 0.5) * W * 0.92, ty: Math.random() * H, c: aColor(AGENTS[Math.floor(Math.random() * AGENTS.length)]) }));
  const F = 16;
  for (let f = 0; f <= F; f++) {
    const p = f / F, e = p * p * (3 - 2 * p);
    const grid = Array.from({ length: H }, () => Array(W).fill(null));
    for (const pt of P) { const x = Math.round(pt.sx + (pt.tx - pt.sx) * e), y = Math.round(pt.sy + (pt.ty - pt.sy) * e); if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = { ch: f < F ? '·•●'[Math.min(2, Math.floor(p * 3))] : '●', c: pt.c }; }
    const lines = grid.map(row => '  ' + row.map(c => c ? C(c.c)(c.ch) : ' ').join(''));
    if (f) process.stdout.write(`\x1b[${H}A`);
    for (const l of lines) process.stdout.write('\x1b[2K' + l + '\n');
    await sleep(48);
  }
  show(); logo();
}
function logo() {
  console.log('');
  console.log('  ' + bold('H Y P E R S W A R M'));
  console.log('  ' + grey('ask anything - an orchestrator routes it to the right engineer.'));
  console.log('  ' + AGENTS.map(a => dotOf(a) + grey(' ' + a.name.toLowerCase())).join('   '));
  console.log('  ' + grey('tools: ') + (SKIP ? GOOD('ON') + grey(' (edits files & runs commands)') : grey('off  (--safe)')) + grey('   route: ') + (config.smart ? orch('smart') : grey('fast')) + grey('   theme: ' + config.theme));
  console.log('  ' + grey('dir:   ') + grey(cwd));
  console.log('  ' + grey('just type a question  ·  /team to discuss with everyone  ·  /help'));
  console.log('');
}
function help() {
  logo();
  console.log(grey('  the orchestrator reads your question and routes it to the best engineer.'));
  console.log(grey('  <question>            orchestrator picks the right engineer & answers'));
  console.log(grey('  /route <agent> <q>    force one engineer to answer'));
  console.log(grey('  /smart                toggle smart routing (an engineer picks) vs fast'));
  console.log(grey('  /team <message>       discuss it with the whole team (group chat)'));
  console.log(grey('  /quick <q>            quick poll - everyone answers once'));
  console.log(grey('  @<agent> <message>    direct it to one engineer (they build it)'));
  console.log(grey('  /solo <agent> <task>  assign to one - they build it (files, commands)'));
  console.log(grey('  /build <task>         team plans, then one engineer implements'));
  console.log(grey('  /skill <name> [args]  run a skill   ·   /skills to list'));
  console.log(grey('  /agents  /agent on|off <name>   /status   /setup'));
  console.log(grey('  /cd <path>  /pwd   /theme <name>   /rounds 1-5   /save [file]'));
  console.log(grey('  /retry   /clear   /help   /exit'));
  console.log('');
}

// ---------- prompts ----------
const history = [];
let lastUser = null;
const histText = () => history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n\n');
const transcriptText = (limit = 26) => history.slice(-limit).map(h => `${h.role === 'User' ? 'You' : h.role}: ${h.text}`).join('\n');
function chatPrompt(agent) {
  return [
    `This is a work chat for a small engineering team in a terminal. Members: "You" (the human lead) and ${NAMES.length} AI engineers - ${NAMES.join(', ')}. You are ${agent.name}.`,
    `Communicate like a focused, professional coworker: concise and substantive, no small talk, jokes, or filler. Disagreement is fine - back it with reasoning.`,
    `React to the latest messages: build on a point, flag a risk, or add what's missing. Address a teammate by name when replying to them. Don't repeat what's been said; if you have nothing to add, reply exactly: (pass)`,
    `You have full tool access - read/write files and run commands in the working directory (${cwd}). When the user asks for real work, coordinate: state what you'll take, don't duplicate a teammate's task, prefer one owner per file. For a sizable build, expect the user to hand it to one engineer via /solo or /build.`,
    `No preamble, no sign-off. Output only your message as ${agent.name}.`,
    ``, `Conversation so far:`, transcriptText(), ``, `${agent.name}:`,
  ].join('\n');
}
function soloPrompt(agent, user) {
  return [
    `You are ${agent.name}, an AI engineer with full tool access - read/write files and run commands in the working directory: ${cwd}.`,
    `The human has assigned this task to you. Actually carry it out: create or edit the files and run the commands needed, then briefly report what you did and how to use it.`,
    history.length ? `\nTeam conversation so far (context):\n${histText()}\n` : ``,
    `\nTask:\n${user}\n\nGo:`,
  ].join('\n');
}
function swarmPrompt(agent, user) {
  const others = NAMES.filter(n => n !== agent.name).join(', ');
  return [
    `You are ${agent.name}, one of several AI engineers giving a quick take in a shared terminal (alongside ${others}).`,
    `Everyone answers at once, so give your own best, distinctive take - don't defer to the others.`,
    `This is a quick opinion poll: answer from your own knowledge; do NOT run commands or change files here (use /solo for actual work).`,
    `Be concise and professional. No preamble, no sign-off. Speak in first person as ${agent.name}.`,
    history.length ? `\nRecent conversation (context):\n${histText()}\n` : ``,
    `\nUser request:\n${user}\n\nYour response as ${agent.name}:`,
  ].join('\n');
}

// ---------- orchestrator (router) ----------
// Each engineer's lane. The orchestrator reads the question and routes it to the best fit.
const SPECIALTY = {
  Codex:  { cat: 'code',     blurb: 'writing & running code, debugging, refactors, shell/file work' },
  Claude: { cat: 'reasoning', blurb: 'deep reasoning, architecture, analysis, long-form writing' },
  Gemini: { cat: 'research',  blurb: 'research, summaries, comparisons, broad factual questions' },
  Grok:   { cat: 'realtime',  blurb: 'current events, real-time info, math/logic, blunt takes' },
  Vibe:   { cat: 'quick',     blurb: 'fast general answers and lightweight coding help' },
};
// Heuristic signals - zero-latency routing (the "fast engine": one call, no fan-out).
const ROUTE_SIGNALS = {
  Codex:  [/\bcode\b/i, /\bbug\b/i, /\berror\b/i, /stack ?trace/i, /\brefactor\b/i, /\bimplement\b/i, /\bfunction\b/i, /\bcompile\b/i, /\bbuild\b/i, /\bscript\b/i, /\bregex\b/i, /\bnpm\b/i, /\bgit\b/i, /\btests?\b/i, /\bdebug\b/i, /\bclass\b/i, /\binstall\b/i, /\bdeploy\b/i, /\bdocker\b/i, /\bsql\b/i, /\bapi\b/i, /\bfile\b/i, /\bcommand\b/i, /\brun\b/i],
  Grok:   [/\btoday\b/i, /\bnews\b/i, /\blatest\b/i, /\bcurrent(ly)?\b/i, /right now/i, /\bhappening\b/i, /\bprice\b/i, /\bstock\b/i, /\b202[5-9]\b/i, /\bscore\b/i, /\belection\b/i, /\bweather\b/i, /who won/i, /\bcalculate\b/i, /\bmath\b/i],
  Gemini: [/\bresearch\b/i, /\bsummar/i, /\boverview\b/i, /\bcompare\b/i, /\bhistory\b/i, /who is\b/i, /what is\b/i, /\bdefine\b/i, /\bdefinition\b/i, /\blist\b/i, /\bexamples?\b/i, /how does\b/i, /\bfacts?\b/i],
  Claude: [/\bwhy\b/i, /\banalyze\b/i, /\banalysis\b/i, /\bdesign\b/i, /\barchitect/i, /trade-?off/i, /\breason/i, /\bwrite\b/i, /\bessay\b/i, /\breview\b/i, /pros and cons/i, /\bstrategy\b/i, /\bplan\b/i, /should i\b/i, /\bcritique\b/i, /\bexplain\b/i],
  Vibe:   [/\bquick(ly)?\b/i, /\bfast\b/i, /\bsimple\b/i, /\btl;?dr\b/i, /\bbrief/i, /one[- ]liner/i, /\bjust\b/i],
};
// Strong, specific signals score +2 so they beat generic openers ("what is", "explain")
// on a tie - e.g. "what is the weather in queens" -> Grok (realtime), not Gemini (research).
const STRONG_SIGNALS = {
  Codex:  [/\berror\b/i, /stack ?trace/i, /\btraceback\b/i, /\bexception\b/i, /\bregex\b/i, /\bcompile\b/i, /\brefactor\b/i],
  Grok:   [/\bweather\b/i, /\bforecast\b/i, /\btemperature\b/i, /\bnews\b/i, /\bstock\b/i, /\bprice\b/i, /\belection\b/i, /right now/i, /\btoday\b/i, /\blatest\b/i, /who won/i],
  Gemini: [/\bresearch\b/i, /\bsummar/i],
  Claude: [/\banalyze\b/i, /\barchitect/i, /trade-?off/i, /\bcritique\b/i, /pros and cons/i],
  Vibe:   [/\btl;?dr\b/i, /one[- ]liner/i],
};
function routeHeuristic(user, agents) {
  const scores = {};
  for (const a of agents) {
    const sig = ROUTE_SIGNALS[a.name] || [], strong = STRONG_SIGNALS[a.name] || [];
    scores[a.name] = sig.reduce((n, re) => n + (re.test(user) ? 1 : 0), 0)
                   + strong.reduce((n, re) => n + (re.test(user) ? 2 : 0), 0);
  }
  const best = agents.slice().sort((x, y) => (scores[y.name] - scores[x.name]))[0];
  const top = scores[best.name] || 0;
  // nothing matched -> fall back to the configured default (or first available)
  let agent = top > 0 ? best : (findAgent(config.defaultAgent) && activeAgents().includes(findAgent(config.defaultAgent)) ? findAgent(config.defaultAgent) : agents[0]);
  if (!activeAgents().includes(agent)) agent = agents[0];
  const sp = SPECIALTY[agent.name] || { cat: 'general', blurb: 'general assistance' };
  return { agent, cat: sp.cat, why: top > 0 ? `best match for ${sp.cat}: ${sp.blurb}` : `no strong signal - routed to default (${sp.blurb})`, scores, mode: 'heuristic' };
}
// Optional: let the fastest engineer pick the specialist (one tiny extra call).
async function smartRoute(user, agents) {
  const fastest = agents.slice().sort((x, y) => (authState[x.name]?.dt || 9e9) - (authState[y.name]?.dt || 9e9))[0];
  const roster = agents.map(a => `${a.name} = ${SPECIALTY[a.name].blurb}`).join('\n');
  const prompt = `You are a router. Given a user request and a roster of engineers, reply with ONLY the single best engineer's name (one word, exactly as written), nothing else.\n\nRoster:\n${roster}\n\nRequest: ${user}\n\nBest engineer:`;
  const res = await ask(fastest, prompt, { timeout: 45000, retry: false });
  const pick = agents.find(a => new RegExp(`\\b${a.name}\\b`, 'i').test(res.text)) || agents.find(a => clean(res.text).toLowerCase().includes(a.name.toLowerCase()));
  if (!pick) return { ...routeHeuristic(user, agents), mode: 'smart->fallback' };
  const sp = SPECIALTY[pick.name];
  return { agent: pick, cat: sp.cat, why: `${fastest.name.toLowerCase()} routed this to ${pick.name.toLowerCase()}: ${sp.blurb}`, mode: 'smart' };
}
function routedPrompt(agent, user, r) {
  const sp = SPECIALTY[agent.name] || { blurb: 'general assistance' };
  return [
    `You are ${agent.name}. An orchestrator routed this question to you because it fits your strength: ${sp.blurb}.`,
    `Answer it directly and well - concise but complete, professional, no preamble or sign-off.`,
    SKIP ? `You have full tool access in the working directory (${cwd}). If the task needs real work (create/edit files, run commands), do it and report what you did; otherwise just answer.` : `Read-only session: answer from your knowledge, do not change files.`,
    history.length > 1 ? `\nConversation so far:\n${transcriptText(10)}\n` : ``,
    `\nQuestion:\n${user}\n\n${agent.name}:`,
  ].join('\n');
}
function printRouting(r) {
  console.log('');
  console.log(`  ${orch('◇')} ${orch('orchestrator')} ${grey('routed to')} ${C(aColor(r.agent))('● ' + r.agent.name.toLowerCase())}  ${grey('·')}  ${C(aColor(r.agent))(r.cat)}`);
  console.log(`     ${faint(r.why)}`);
  console.log('');
}
function printAnswer(res, agent, r) {
  const paint = C(aColor(agent)), bar = paint('│');
  const w = Math.min(cols() - 6, 96);
  console.log(`  ${paint('●')} ${paint(bold(agent.name.toLowerCase()))}  ${grey('· ' + r.cat)}`);
  for (const l of wrap(res.text, w)) console.log(`  ${bar}  ${l}`);
  console.log(`  ${faint('└─ answered by ' + agent.name.toLowerCase() + (res.dt ? ' · ' + (res.dt / 1000).toFixed(1) + 's' : ''))}`);
  console.log('');
}
async function routeRound(user) {
  const agents = activeAgents();
  if (!agents.length) return noEngineers();
  lastUser = user; history.push({ role: 'User', text: user });
  let r;
  if (config.smart && agents.length > 1) {
    hide(); let i = 0;
    const sp = setInterval(() => process.stdout.write(`\r  ${orch('◇')} ${grey('orchestrating ' + SPIN[i++ % SPIN.length])}   `), 90);
    r = await smartRoute(user, agents);
    clearInterval(sp); process.stdout.write('\r\x1b[2K'); show();
  } else {
    r = routeHeuristic(user, agents);
  }
  printRouting(r);
  const tried = new Set();
  let res, agent = r.agent;
  for (let attempt = 0; attempt < agents.length; attempt++) {
    tried.add(agent.name);
    hide(); const stop = miniSpin(agent);
    res = await ask(agent, routedPrompt(agent, user, r), {});
    stop(); show();
    if (!(isBad(res.text) || looksFailed(res.text))) break;
    // this engineer crashed / isn't authorized - bench it for the session and reroute to the next best
    authState[agent.name] = { ok: false }; config.auth = authState; saveConfig();
    const remaining = activeAgents().filter(a => !tried.has(a.name));
    if (!remaining.length) { console.log(`  ${faint(agent.name.toLowerCase() + ' is unavailable, and no other engineer is free. try /setup.')}\n`); return; }
    const next = routeHeuristic(user, remaining).agent;
    const sp = SPECIALTY[next.name] || { cat: 'general', blurb: 'general assistance' };
    console.log(`  ${faint(agent.name.toLowerCase() + ' unavailable (not authorized / crashed) - rerouting to ' + next.name.toLowerCase())}\n`);
    r = { agent: next, cat: sp.cat, why: `rerouted: ${agent.name.toLowerCase()} unavailable -> ${sp.blurb}`, mode: 'reroute' };
    printRouting(r); agent = next;
  }
  printAnswer(res, agent, r);
  history.push({ role: res.name, text: res.text });
}

// ---------- rounds ----------
async function swarmRound(user) {
  const agents = activeAgents();
  if (!agents.length) return noEngineers();
  history.push({ role: 'User', text: user });
  const states = agents.map(a => ({ agent: a, status: 'thinking', t0: Date.now(), dt: 0, res: null, order: 0 }));
  const panel = livePanel(states); hide(); panel.draw();
  const anim = setInterval(() => panel.draw(), 80); let order = 0;
  await Promise.all(states.map(st => ask(st.agent, swarmPrompt(st.agent, user)).then(res => { st.status = 'done'; st.dt = Date.now() - st.t0; st.res = { ...res, dt: st.dt }; st.order = ++order; })));
  clearInterval(anim); panel.draw(true); show(); console.log('');
  for (const st of [...states].sort((a, b) => a.order - b.order)) { printCard(st.res, aColor(st.agent)); history.push({ role: st.res.name, text: st.res.text }); }
}
async function chatRound(agents) {
  const typing = new Set(agents.map(a => a.name)); const posted = [];
  const stage = thinkingStage(() => typing); stage.start();
  const anim = setInterval(() => stage.tick(), 110);
  const ac = new AbortController(); let graceArmed = false;
  await Promise.allSettled(agents.map(a => ask(a, chatPrompt(a), { signal: ac.signal }).then(res => {
    typing.delete(a.name);
    const text = stripPass(res.text);
    if (text && !isBad(text)) { stage.above(chatLines(a, text)); history.push({ role: a.name, text }); posted.push(a.name); }
    if (!graceArmed) { graceArmed = true; setTimeout(() => ac.abort(), 120000); }
  })));
  clearInterval(anim); stage.stop();
  return posted;
}
async function converse(userText) {
  if (!activeAgents().length) return noEngineers();
  lastUser = userText; history.push({ role: 'User', text: userText });
  for (let r = 0; r < rounds; r++) { const posted = await chatRound(activeAgents()); if (!posted.length) break; }
  console.log('');
}
async function soloRound(name, user) {
  const agent = findAgent(name);
  if (!agent) { console.log(grey(`  unknown engineer "${name}". try: ${NAMES.map(n => n.toLowerCase()).join(', ')}`) + '\n'); return; }
  history.push({ role: 'User', text: `(to ${agent.name}) ${user}` });
  hide(); const stop = miniSpin(agent);
  const res = await ask(agent, soloPrompt(agent, user), {});
  stop(); show(); printCard(res, aColor(agent));
  history.push({ role: res.name, text: res.text });
}
// Phase 5: team plans, then the best builder implements
function defaultBuilder() {
  const en = activeAgents();
  return en.find(a => a.key === 'codex') || en.find(a => a.key === 'claude') || en[0] || AGENTS[0];
}
async function buildTask(task) {
  if (!activeAgents().length) return noEngineers();
  console.log(grey('  team is planning the approach...') + '\n');
  await swarmRound(`Propose how to approach this in 1-2 sentences each, no code yet.\nTask: ${task}`);
  const b = defaultBuilder();
  console.log(grey(`  ${b.name.toLowerCase()} is implementing...`) + '\n');
  await soloRound(b.name, `Implement this task now, using the team's plan above as guidance. Create/edit files and run commands as needed.\nTask: ${task}`);
}
function noEngineers() { console.log(grey('  no engineers available - run /setup, or enable one with /agent on <name>.') + '\n'); }

// ---------- Phase 4: skills ----------
const SKILLS = {
  review:   { solo: false, desc: 'team reviews code/diff for bugs & fixes', expand: a => `Review ${a || 'the current changes in this directory'} for correctness bugs and concrete improvements. Cite file:line and give the fix.` },
  explain:  { solo: false, desc: 'explain a file / codebase',              expand: a => `Explain ${a || 'this codebase'} concisely - structure, key files, how it runs.` },
  plan:     { solo: false, desc: 'break a goal into a build plan',          expand: a => `Break this into a concrete, ordered build plan with owners: ${a}` },
  scaffold: { solo: true,  desc: 'scaffold a new project/component',        expand: a => `Scaffold ${a}. Create the files and a minimal runnable setup, then report how to run it.` },
  test:     { solo: true,  desc: 'write & run tests',                       expand: a => `Write tests for ${a || 'the recent code'}. Create the test files and run them; report results.` },
  refactor: { solo: true,  desc: 'refactor code (behavior-preserving)',     expand: a => `Refactor ${a}. Make the edits, keep behavior identical; summarize what changed.` },
  fix:      { solo: true,  desc: 'find & fix a bug',                        expand: a => `Find and fix: ${a}. Make the edits and verify it works.` },
  document: { solo: true,  desc: 'write docs / README',                     expand: a => `Write clear documentation for ${a || 'this project'}. Create/update the README and report.` },
  commit:   { solo: true,  desc: 'stage & commit changes',                  expand: a => `Stage and commit the current changes with a clear conventional message${a ? ` about: ${a}` : ''}. Run the git commands and show the result.` },
};
function listSkills() {
  console.log('');
  console.log('  ' + bold('skills') + grey('    /skill <name> [args]'));
  for (const [k, v] of Object.entries(SKILLS)) console.log('  ' + C(pal().codex)(k.padEnd(10)) + grey(v.desc) + (v.solo ? dim('  (solo)') : ''));
  const us = Object.keys(config.skills || {});
  if (us.length) { console.log('  ' + grey('your skills:')); for (const k of us) console.log('  ' + C(pal().grok)(k.padEnd(10)) + grey(config.skills[k])); }
  console.log('  ' + grey('add your own:  /skill-add <name> <template with {args}>'));
  console.log('');
}
async function runSkill(rest) {
  const sp = rest.indexOf(' ');
  const name = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
  const args = sp === -1 ? '' : rest.slice(sp + 1).trim();
  let sk = SKILLS[name], task;
  if (sk) task = sk.expand(args);
  else if (config.skills[name]) { sk = { solo: true }; task = config.skills[name].replace(/\{args\}/g, args); }
  else { console.log(grey(`  unknown skill "${name}". /skills to list.`) + '\n'); return; }
  if (sk.solo) await soloRound(defaultBuilder().name, task); else await converse(task);
}

// ---------- Phase 1: setup / authorization wizard ----------
const LOGIN = { Codex: 'codex login', Gemini: 'gemini   (then choose sign-in / paste API key)', Grok: 'grok   (then complete sign-in)', Claude: 'claude   (then /login)', Vibe: 'vibe --setup   (paste Mistral API key)' };
const INSTALL = { Codex: 'npm i -g @openai/codex', Gemini: 'npm i -g @google/gemini-cli', Grok: 'install the grok CLI (xAI)', Claude: 'npm i -g @anthropic-ai/claude-code', Vibe: 'install the Mistral Vibe CLI' };
async function setupWizard() {
  console.log('');
  console.log('  ' + bold('SETUP') + grey('   -   authorize your engineers on this machine'));
  console.log('');
  for (const a of AGENTS) console.log('  ' + dotOf(a) + ' ' + C(aColor(a))(a.name.toLowerCase().padEnd(8)) + (installed(a) ? grey('found on PATH') : accent('not installed')));
  console.log('');
  let i = 0; hide();
  const sp = setInterval(() => process.stdout.write(`\r  ${dim(SPIN[i++ % SPIN.length] + ' pinging each engineer to verify authorization...')}   `), 90);
  await Promise.all(AGENTS.map(async a => {
    if (!installed(a)) { authState[a.name] = { ok: false }; return; }
    const res = await ask(a, 'Reply with exactly: ok', { timeout: 45000, retry: false });
    authState[a.name] = { ok: !isBad(res.text), dt: res.dt };
  }));
  clearInterval(sp); process.stdout.write('\r\x1b[2K'); show();
  console.log('  ' + bold('results') + '\n');
  for (const a of AGENTS) {
    const st = authState[a.name] || {};
    const mark = !installed(a) ? accent('not installed') : st.ok ? GOOD('authorized ✓') : accent('needs login');
    console.log('  ' + dotOf(a) + ' ' + C(aColor(a))(a.name.toLowerCase().padEnd(8)) + mark + (st.ok && st.dt ? grey('   ' + (st.dt / 1000).toFixed(1) + 's') : ''));
    if (!st.ok) console.log('      ' + grey('-> ') + grey(installed(a) ? 'authorize:  ' + LOGIN[a.name] : 'install:    ' + INSTALL[a.name]));
  }
  config.setupDone = true; config.auth = authState; saveConfig();
  console.log('');
  console.log('  ' + grey('authorize in another terminal, then re-run /setup. disable one with /agent off <name>.'));
  console.log('');
}

// ---------- Phase 3 + 8: roster / status ----------
function agentLine(a) {
  const dis = config.disabled.includes(a.name), st = authState[a.name];
  const state = dis ? dim('disabled') : !installed(a) ? accent('not installed') : st ? (st.ok ? GOOD('ok') : accent('login?')) : grey('untested');
  const lat = st && st.dt ? grey('   ' + (st.dt / 1000).toFixed(1) + 's') : '';
  return '  ' + dotOf(a) + ' ' + C(aColor(a))(a.name.toLowerCase().padEnd(8)) + state + lat;
}
function listAgents() {
  console.log('\n  ' + bold('engineers'));
  for (const a of AGENTS) console.log(agentLine(a));
  console.log('  ' + grey('toggle with  /agent on <name>  /  /agent off <name>') + '\n');
}
function status() {
  console.log('\n  ' + bold('status'));
  console.log('  ' + grey('dir:    ') + grey(cwd));
  console.log('  ' + grey('tools:  ') + (SKIP ? GOOD('ON') : grey('off (--safe)')) + grey('    route: ') + (config.smart ? orch('smart') : grey('fast')) + grey('    theme: ') + grey(config.theme) + grey('    rounds: ') + grey(rounds));
  for (const a of AGENTS) console.log(agentLine(a));
  console.log('');
}
function setAgent(on, name) {
  const a = findAgent(name); if (!a) { console.log(grey('  unknown engineer.') + '\n'); return; }
  config.disabled = config.disabled.filter(n => n !== a.name);
  if (!on) config.disabled.push(a.name);
  saveConfig(); console.log(grey(`  ${a.name.toLowerCase()} ${on ? 'enabled' : 'disabled'}.`) + '\n');
}

// ---------- Phase 7: save transcript ----------
function saveTranscript(file) {
  if (!history.length) { console.log(grey('  nothing to save yet.') + '\n'); return; }
  const p = resolve(cwd, file || 'hyperswarm-chat.md');
  const md = '# Hyperswarm transcript\n\n' + history.map(h => `**${h.role === 'User' ? 'You' : h.role}:** ${h.text}`).join('\n\n') + '\n';
  try { writeFileSync(p, md, 'utf8'); console.log(grey('  saved -> ' + p) + '\n'); } catch (e) { console.log(grey('  save failed: ' + e.message) + '\n'); }
}

// ---------- Phase 6: tab autocomplete ----------
function completer(line) {
  const base = ['/help', '/setup', '/status', '/agents', '/agent on ', '/agent off ', '/skills', '/skill ', '/skill-add ', '/ask ', '/route ', '/smart', '/team ', '/quick ', '/solo ', '/build ', '/cd ', '/pwd', '/rounds ', '/theme ', '/save', '/clear', '/retry', '/exit'];
  const skills = Object.keys({ ...SKILLS, ...config.skills }).map(s => '/skill ' + s + ' ');
  const ats = NAMES.map(n => '@' + n.toLowerCase() + ' ');
  const routes = NAMES.map(n => '/route ' + n.toLowerCase() + ' ');
  const themes = Object.keys(THEMES).map(t => '/theme ' + t);
  const all = [...base, ...skills, ...ats, ...routes, ...themes];
  const hits = all.filter(c => c.startsWith(line));
  return [hits.length ? hits : [], line];
}

// ---------- main loop ----------
async function handle(line) {
  const t = line.trim();
  if (!t) return;
  if (t === '/exit' || t === '/quit') { saveConfig(); cleanup(); process.exit(0); }
  if (t === '/help') return help();
  if (t === '/status') return status();
  if (t === '/setup') return setupWizard();
  if (t === '/agents') return listAgents();
  if (t === '/skills') return listSkills();
  if (t === '/pwd') { console.log(grey('  ' + cwd) + '\n'); return; }
  if (t === '/clear') { history.length = 0; console.log(grey('  chat cleared.') + '\n'); return; }
  if (t === '/retry') { if (lastUser) await routeRound(lastUser); else console.log(grey('  nothing to retry.') + '\n'); return; }
  if (t === '/smart') { config.smart = !config.smart; saveConfig(); console.log(grey(`  smart routing ${config.smart ? 'ON - the fastest engineer picks the specialist' : 'off - instant heuristic routing'}.`) + '\n'); return; }
  if (t === '/save' || t.startsWith('/save ')) return saveTranscript(t.length > 5 ? t.slice(6).trim() : '');
  if (t.startsWith('/agent on ')) return setAgent(true, t.slice(10).trim());
  if (t.startsWith('/agent off ')) return setAgent(false, t.slice(11).trim());
  if (t.startsWith('/theme')) {
    const n = t.split(/\s+/)[1];
    if (!n) { console.log(grey('  themes: ' + Object.keys(THEMES).join(', ') + '   (now ' + config.theme + ')') + '\n'); return; }
    if (THEMES[n]) { config.theme = n; saveConfig(); logo(); } else console.log(grey('  unknown theme.') + '\n');
    return;
  }
  if (t.startsWith('/rounds')) {
    const n = parseInt(t.split(/\s+/)[1], 10);
    if (n >= 1 && n <= 5) { rounds = n; config.rounds = n; saveConfig(); console.log(grey(`  chat depth: ${rounds} round(s) per message.`) + '\n'); }
    else console.log(grey('  usage: /rounds 1-5') + '\n');
    return;
  }
  if (t.startsWith('/cd ')) {
    const np = resolve(cwd, t.slice(4).trim().replace(/^["']|["']$/g, ''));
    try { if (statSync(np).isDirectory()) { cwd = np; saveConfig(); console.log(grey('  dir: ' + cwd) + '\n'); } else console.log(grey('  not a directory: ' + np) + '\n'); }
    catch { console.log(grey('  no such path: ' + np) + '\n'); }
    return;
  }
  if (t.startsWith('/skill-add ')) {
    const r = t.slice(11).trim(), sp = r.indexOf(' ');
    if (sp === -1) { console.log(grey('  usage: /skill-add <name> <template with {args}>') + '\n'); return; }
    config.skills[r.slice(0, sp).toLowerCase()] = r.slice(sp + 1); saveConfig(); console.log(grey('  skill saved.') + '\n'); return;
  }
  if (t.startsWith('/skill ')) return runSkill(t.slice(7).trim());
  if (t.startsWith('/ask ')) return routeRound(t.slice(5).trim());
  if (t.startsWith('/team ')) return converse(t.slice(6).trim());
  if (t.startsWith('/quick ')) return swarmRound(t.slice(7).trim());
  if (t.startsWith('/build ')) return buildTask(t.slice(7).trim());
  if (t.startsWith('/route ')) {
    const rest = t.slice(7).trim(), sp = rest.indexOf(' ');
    if (sp === -1) { console.log(grey('  usage: /route <agent> <question>') + '\n'); return; }
    const agent = findAgent(rest.slice(0, sp));
    if (!agent) { console.log(grey(`  unknown engineer "${rest.slice(0, sp)}". try: ${NAMES.map(n => n.toLowerCase()).join(', ')}`) + '\n'); return; }
    const q = rest.slice(sp + 1);
    lastUser = q; history.push({ role: 'User', text: q });
    const sp2 = SPECIALTY[agent.name] || { cat: 'general' };
    const r = { agent, cat: sp2.cat, why: 'forced by you', mode: 'forced' };
    printRouting(r); hide(); const stop = miniSpin(agent);
    const res = await ask(agent, routedPrompt(agent, q, r), {});
    stop(); show(); printAnswer(res, agent, r); history.push({ role: res.name, text: res.text });
    return;
  }
  if (t.startsWith('/solo ')) {
    const rest = t.slice(6).trim(), sp = rest.indexOf(' ');
    if (sp === -1) { console.log(grey('  usage: /solo <agent> <task>') + '\n'); return; }
    return soloRound(rest.slice(0, sp), rest.slice(sp + 1));
  }
  const at = t.match(/^@(\w+)\s+([\s\S]+)/);
  if (at && findAgent(at[1])) return soloRound(at[1], at[2]);
  await routeRound(t);
}
function cleanup() { show(); try { rmSync(TMP, { recursive: true, force: true }); } catch {} }
async function main() {
  if (ONCE) { await boot(); await routeRound(ONCE); cleanup(); process.exit(0); }
  await boot();
  if (!config.setupDone) await setupWizard();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: accent('  ● ') + grey('you  '), completer });
  rl.prompt();
  rl.on('line', async (line) => { await handle(line); rl.prompt(); });
  rl.on('close', () => { saveConfig(); cleanup(); process.exit(0); });
}
process.on('SIGINT', () => { process.stdout.write('\n'); saveConfig(); cleanup(); process.exit(0); });
main();
