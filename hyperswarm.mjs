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
function runAgent(agent, promptText, signal) {
  return new Promise((resolve) => {
    const spec = agent.build(promptText);
    const child = spawn(spec.cmd, spec.args, { shell: !!spec.shell, windowsHide: true });
    let out = '', err = '', settled = false;
    const kill = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(kill, 120000);              // hard backstop
    const onAbort = kill;                                 // straggler cut-off from the round
    if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const done = (text, ok) => {
      if (settled) return; settled = true;
      clearTimeout(timer); if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
      resolve({ name: agent.name, text, ok });
    };
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    if (spec.stdin != null) { try { child.stdin.write(spec.stdin); child.stdin.end(); } catch {} }
    else { try { child.stdin.end(); } catch {} }
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

function clean(s) {
  return (s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // strip ANSI color codes
    .replace(/\r/g, '')
    .trim();
}

// stderr is only a fallback when stdout is empty; drop harmless CLI warnings so they never post as a message
function usableErr(err) {
  return clean(err).split('\n').filter(l => l.trim() &&
    !/^Warning:/i.test(l) && !/256-color/i.test(l) && !/Ripgrep is not available/i.test(l) &&
    !/Falling back to/i.test(l) && !/DeprecationWarning|ExperimentalWarning|\(node:|--trace-/i.test(l)
  ).join('\n').trim();
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

// group-chat message as lines: colored bullet + name label, body with hanging indent
function chatLines(agent, text) {
  const paint = C(agent.color);
  const label = ('● ' + agent.name.toLowerCase()).padEnd(9);
  const indent = ' '.repeat(2 + label.length + 1);
  const wrapped = wrap(text, Math.min(cols() - indent.length, 88));
  const out = ['  ' + paint(label) + ' ' + (wrapped[0] || '')];
  for (const l of wrapped.slice(1)) out.push(indent + l);
  out.push('');                 // breathing room between messages
  return out;
}

// per-agent buzzing glyphs (Nothing-style) for whoever is still typing
function typingGlyphs(typing, frame) {
  const parts = AGENTS.filter(a => typing.has(a.name)).map(a => {
    const tr = Array.from({ length: 4 }, (_, i) => BRAILLE[(frame + i * 2 + a.name.length) % BRAILLE.length]).join('');
    return `${dotOf(a)} ${C(a.color)(a.name.toLowerCase())} ${C(a.color)(tr)}`;
  });
  return parts.length ? '  ' + parts.join('   ') : '';
}

// sticky bottom "thinking" panel: shimmer dot-field + buzzing agent glyphs + hairline,
// while chat messages are printed ABOVE it via .above()
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
    start() { hide(); draw(); },
    tick() { frame++; draw(); },
    above(ls) { if (drawn) { w(`\x1b[${H}A`); drawn = false; } w('\x1b[0J'); for (const x of ls) w(x + '\n'); draw(); },
    stop() { if (drawn) { w(`\x1b[${H}A`); drawn = false; } w('\x1b[0J'); show(); },
  };
}

// treat "(pass)" / quoted-empty as silence
function stripPass(t) {
  const s = String(t || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s || /^\(?\s*pass\s*\)?\.?$/i.test(s)) return '';
  return s;
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
  console.log(grey("  it's a group chat - type a message and the swarm chats back,"));
  console.log(grey('  reacting to you and to each other.'));
  console.log(grey('  /quick <q>          one fast round, everyone answers once'));
  console.log(grey('  /solo <agent> <q>   DM just one'));
  console.log(grey('  /rounds 1-5         reply rounds per message (now ' + rounds + ')'));
  console.log(grey('  /clear   /help   /exit'));
  console.log('');
}

// ---------- prompts ----------
const history = [];
function histText() {
  return history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n\n');
}
function transcriptText(limit = 26) {
  return history.slice(-limit).map(h => `${h.role === 'User' ? 'You' : h.role}: ${h.text}`).join('\n');
}
function chatPrompt(agent) {
  const others = NAMES.filter(n => n !== agent.name);
  return [
    `This is a live group chat in a terminal. Members: "You" (the human) and four AIs - ${NAMES.join(', ')}. You are ${agent.name}.`,
    `Chat like a real group chat: short (1-3 sentences), casual, reactive. Lowercase is fine.`,
    `Talk WITH the group, not just to the human - agree, disagree, build on a point, or @mention someone (e.g. @${others[0].toLowerCase()}). React to the most recent messages.`,
    `Never repeat a point already made. If you have nothing worth adding right now, reply with exactly: (pass)`,
    `This is a text-only chat: do NOT use tools, run commands, browse, or read files - just reply from your own knowledge.`,
    `No preamble, no sign-off, no "as an AI". Output only your chat message as ${agent.name}.`,
    ``,
    `Chat so far:`,
    transcriptText(),
    ``,
    `${agent.name}:`,
  ].join('\n');
}
function soloPrompt(agent, user) {
  return [
    `You are ${agent.name}. Answer the user directly and concisely. Speak in first person as ${agent.name}.`,
    `This is a text-only chat: do NOT use tools, run commands, browse, or read files - just answer from your own knowledge.`,
    history.length ? `\nRecent conversation (context):\n${histText()}\n` : ``,
    `\nUser request:\n${user}\n\nYour response:`,
  ].join('\n');
}

function swarmPrompt(agent, user) {
  const others = NAMES.filter(n => n !== agent.name).join(', ');
  return [
    `You are ${agent.name}, part of a four-AI swarm in a shared terminal (alongside ${others}).`,
    `All four of you are answering THIS prompt at the same time, so give your own best, distinctive take - don't wait for or defer to the others.`,
    `This is a text-only chat: do NOT use tools, run commands, browse, or read files - just answer from your own knowledge.`,
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
// one chat round: all agents type concurrently under a live Nothing-style thinking panel;
// each message drops into the timeline above the panel as that agent lands
async function chatRound(agents) {
  const typing = new Set(agents.map(a => a.name));
  const posted = [];
  const stage = thinkingStage(() => typing);
  stage.start();
  const anim = setInterval(() => stage.tick(), 110);
  const ac = new AbortController();
  let graceArmed = false;
  await Promise.allSettled(agents.map(a =>
    runAgent(a, chatPrompt(a), ac.signal).then(res => {
      typing.delete(a.name);
      const text = stripPass(res.text);
      if (text && !/^\((no response|failed to launch)/.test(text)) {
        stage.above(chatLines(a, text)); history.push({ role: a.name, text }); posted.push(a.name);
      }
      // once someone has replied, give stragglers a bounded grace then cut them off (prevents a hung agent freezing the round)
      if (!graceArmed) { graceArmed = true; setTimeout(() => ac.abort(), 35000); }
    })
  ));
  clearInterval(anim);
  stage.stop();
  return posted;
}

// a full exchange: your message, then up to `rounds` rounds of the swarm chatting with you and each other
async function converse(userText) {
  history.push({ role: 'User', text: userText });
  for (let r = 0; r < rounds; r++) {
    const posted = await chatRound(AGENTS);
    if (!posted.length) break;   // everyone passed -> conversation lull, hand it back to you
  }
  console.log('');
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
let rounds = 2;   // reply rounds per message
async function handle(line) {
  const t = line.trim();
  if (!t) return;
  if (t === '/exit' || t === '/quit') { cleanup(); process.exit(0); }
  if (t === '/help') { help(); return; }
  if (t === '/clear') { history.length = 0; console.log(grey('  chat cleared.') + '\n'); return; }
  if (t.startsWith('/rounds')) {
    const n = parseInt(t.split(/\s+/)[1], 10);
    if (n >= 1 && n <= 5) { rounds = n; console.log(grey(`  chat depth: ${rounds} round(s) per message.`) + '\n'); }
    else console.log(grey('  usage: /rounds 1-5') + '\n');
    return;
  }
  if (t.startsWith('/quick ')) { await swarmRound(t.slice(7).trim()); return; }
  if (t.startsWith('/solo ')) {
    const rest = t.slice(6).trim(); const sp = rest.indexOf(' ');
    if (sp === -1) { console.log(grey(`  usage: /solo <agent> <message>`) + '\n'); return; }
    await soloRound(rest.slice(0, sp), rest.slice(sp + 1)); return;
  }
  await converse(t);
}

function cleanup() { show(); try { rmSync(TMP, { recursive: true, force: true }); } catch {} }

async function main() {
  if (ONCE) { await boot(); await converse(ONCE); cleanup(); process.exit(0); }
  await boot();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: RED('  ● ') + grey('you  ') });
  rl.prompt();
  rl.on('line', async (line) => { await handle(line); rl.prompt(); });
  rl.on('close', () => { cleanup(); process.exit(0); });
}
process.on('SIGINT', () => { process.stdout.write('\n'); cleanup(); process.exit(0); });
main();
