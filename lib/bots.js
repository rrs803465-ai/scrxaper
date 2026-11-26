// Premade bots. They run inside the server: there are no tokens, webhooks or external programs.
export const BOT_USERS = {
  sentinel: { name: 'Sentinel', icon: 'shield' },
  jukebox: { name: 'Jukebox', icon: 'music' },
  greeter: { name: 'Greeter', icon: 'wave' },
  funbot: { name: 'Funbot', icon: 'dice' },
  levels: { name: 'Levels', icon: 'star' },
  toolkit: { name: 'Toolkit', icon: 'tool' },
  arcade: { name: 'Arcade', icon: 'game' },
  quotebook: { name: 'Quotebook', icon: 'quote' },
};

export const BOT_CATALOG = [
  { id: 'sentinel', name: 'Sentinel', icon: 'shield', tagline: 'Security and moderation',
    description: 'Blocks links, banned words, shouting, mass mentions and spam floods. Repeat spammers are timed out in communities. Everything it does is written to the moderation log.',
    defaults: { links: false, caps: true, spam: true, mentions: 6, words: [] },
    fields: [{ key: 'links', type: 'bool', label: 'Block links' }, { key: 'caps', type: 'bool', label: 'Block shouting (mostly capitals)' },
      { key: 'spam', type: 'bool', label: 'Block spam floods' }, { key: 'mentions', type: 'number', label: 'Max @mentions per message (0 = off)', min: 0, max: 20 },
      { key: 'words', type: 'list', label: 'Blocked words (comma separated)' }] },
  { id: 'jukebox', name: 'Jukebox', icon: 'music', tagline: 'Music you upload',
    description: 'Upload MP3, WAV, OGG, M4A or FLAC tracks (up to 10 MB each) and play them with !play, !pause, !skip and !queue. Everyone in a voice room hears the same track in sync; in text chats it posts a player.',
    defaults: { announce: true }, fields: [{ key: 'announce', type: 'bool', label: 'Post a player card when a track starts' }] },
  { id: 'greeter', name: 'Greeter', icon: 'wave', tagline: 'Welcome new people',
    description: 'Greets people when they join. Use {user} and {name} in the message.',
    defaults: { welcome: 'Welcome {user} to {name}.', farewell: '' },
    fields: [{ key: 'welcome', type: 'text', label: 'Welcome message', max: 300 }, { key: 'farewell', type: 'text', label: 'Goodbye message (optional)', max: 300 }] },
  { id: 'funbot', name: 'Funbot', icon: 'dice', tagline: 'Games and small talk',
    description: 'Commands: !roll, !flip, !8ball, !choose, !rps, !rate, !hug, !joke, !fact, !trivia and !poll.',
    defaults: {}, fields: [] },
  { id: 'levels', name: 'Levels', icon: 'star', tagline: 'XP, ranks and a leaderboard',
    description: 'People earn XP by chatting (once every 30 seconds counts). Commands: !rank shows your level, !top shows the leaderboard. Level-ups are announced.',
    defaults: { announce: true, perMessage: 10 },
    fields: [{ key: 'announce', type: 'bool', label: 'Announce level-ups' }, { key: 'perMessage', type: 'number', label: 'XP per message (1 to 50)', min: 1, max: 50 }] },
  { id: 'toolkit', name: 'Toolkit', icon: 'tool', tagline: 'Calculator, reminders and timers',
    description: 'Commands: !calc 2*(3+4), !time, !remind 10m stand up, !timer 5m, !pick a, b, c, !password, !countdown 2027-01-01.',
    defaults: {}, fields: [] },
  { id: 'arcade', name: 'Arcade', icon: 'game', tagline: 'Little games for the chat',
    description: 'Commands: !guess starts a number game (then !guess 42), !hangman starts a word game (then !hangman e), !scramble gives a jumbled word (answer with !unscramble word), !tictactoe to play against the bot.',
    defaults: {}, fields: [] },
  { id: 'quotebook', name: 'Quotebook', icon: 'quote', tagline: 'Save the funny and the wise',
    description: 'Commands: !quote shows a random one, !quote add text saves one, !quotes lists the latest, !quote del n removes one you saved.',
    defaults: {}, fields: [] },
];

export const applyConfig = (bot, input = {}) => {
  const spec = BOT_CATALOG.find((b) => b.id === bot);
  if (!spec) return null;
  const out = { ...spec.defaults };
  for (const f of spec.fields) {
    const v = input[f.key];
    if (v === undefined) continue;
    if (f.type === 'bool') out[f.key] = !!v;
    else if (f.type === 'number') out[f.key] = Math.min(Math.max(Math.trunc(Number(v)) || 0, f.min ?? 0), f.max ?? 100);
    else if (f.type === 'text') out[f.key] = String(v).trim().slice(0, f.max ?? 300);
    else if (f.type === 'list') out[f.key] = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map((w) => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 50).map((w) => w.slice(0, 30));
  }
  return out;
};

export const automod = (cfg, text) => {
  const t = String(text ?? '');
  if (cfg.links && /(https?:\/\/|www\.)\S+/i.test(t)) return 'links are not allowed here';
  const lower = t.toLowerCase();
  for (const w of cfg.words ?? []) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(lower)) return 'that word is blocked here';
  }
  if (cfg.mentions && (t.match(/@\w+/g) ?? []).length > cfg.mentions) return 'too many mentions';
  if (cfg.caps) {
    const letters = t.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 12 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.7) return 'please do not shout';
  }
  return null;
};

const EIGHT = ['It is certain.', 'Without a doubt.', 'Yes, definitely.', 'Most likely.', 'Signs point to yes.', 'Ask again later.', 'Cannot predict now.', 'Do not count on it.', 'My sources say no.', 'Very doubtful.'];
const JOKES = ['Why do programmers prefer dark mode? Because light attracts bugs.', 'There are 10 kinds of people: those who understand binary and those who do not.', 'A SQL query walks into a bar, sees two tables and asks: may I join you?',
  'I would tell you a UDP joke, but you might not get it.', 'Why did the developer go broke? He used up all his cache.'];
const FACTS = ['Honey never spoils; edible honey has been found in ancient tombs.', 'Octopuses have three hearts.', 'A day on Venus is longer than its year.', 'Bananas are berries; strawberries are not.', 'The first computer bug was a real moth found in a relay in 1947.'];
const TRIVIA = [['What is the capital of Australia?', 'canberra'], ['How many sides does a hexagon have?', '6'], ['Which planet is known as the Red Planet?', 'mars'],
  ['What is the chemical symbol for gold?', 'au'], ['In computing, what does CPU stand for?', 'central processing unit'], ['How many bits are in a byte?', '8'], ['Which ocean is the largest?', 'pacific']];

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

export const COMMANDS = { roll: 'funbot', dice: 'funbot', flip: 'funbot', coin: 'funbot', '8ball': 'funbot', choose: 'funbot', rps: 'funbot', rate: 'funbot', hug: 'funbot', joke: 'funbot', fact: 'funbot', trivia: 'funbot', answer: 'funbot', poll: 'funbot', help: 'funbot',
  play: 'jukebox', pause: 'jukebox', resume: 'jukebox', skip: 'jukebox', queue: 'jukebox', now: 'jukebox', stop: 'jukebox', tracks: 'jukebox',
  rank: 'levels', top: 'levels',
  calc: 'toolkit', time: 'toolkit', remind: 'toolkit', timer: 'toolkit', pick: 'toolkit', password: 'toolkit', countdown: 'toolkit',
  guess: 'arcade', hangman: 'arcade', scramble: 'arcade', unscramble: 'arcade', tictactoe: 'arcade', ttt: 'arcade',
  quote: 'quotebook', quotes: 'quotebook' };

export const parseCommand = (text) => {
  const m = /^!([a-z0-9]{2,10})(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  return COMMANDS[cmd] ? { cmd, args: (m[2] ?? '').trim(), bot: COMMANDS[cmd] } : null;
};

// Funbot commands. ctx: { user, rand, trivia (mutable { q, a } or undefined), setTrivia(fn) }
export const funCommand = (cmd, args, ctx) => {
  const rand = ctx.rand ?? Math.random;
  switch (cmd) {
    case 'help': return { text: 'Funbot: !roll [sides|NdM], !flip, !8ball <question>, !choose a, b, c, !rps rock|paper|scissors, !rate <thing>, !hug @user, !joke, !fact, !trivia, !answer <text>, !poll Question | option | option. Jukebox: !play <n|name>, !pause, !resume, !skip, !queue, !now, !stop, !tracks.' };
    case 'roll': case 'dice': {
      const m = /^(\d{1,2})d(\d{1,4})$/i.exec(args);
      const [n, sides] = m ? [Math.max(1, Number(m[1])), Math.max(2, Number(m[2]))] : [1, Math.min(Math.max(Number(args) || 6, 2), 10000)];
      const rolls = Array.from({ length: Math.min(n, 20) }, () => 1 + Math.floor(rand() * sides));
      return { text: `${ctx.user} rolled ${rolls.length > 1 ? `${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}` : rolls[0]} (d${sides})` };
    }
    case 'flip': case 'coin': return { text: `${ctx.user} flipped ${rand() < 0.5 ? 'heads' : 'tails'}.` };
    case '8ball': return args ? { text: `${pick(EIGHT, rand)}` } : { text: 'Ask a question first: !8ball will I ship today?' };
    case 'choose': {
      const opts = args.split(/\s*[,|]\s*/).filter(Boolean);
      return opts.length > 1 ? { text: `I choose: ${pick(opts, rand)}` } : { text: 'Give me options: !choose pizza, noodles, tacos' };
    }
    case 'rps': {
      const mine = ['rock', 'paper', 'scissors'];
      const you = args.toLowerCase();
      if (!mine.includes(you)) return { text: 'Use !rps rock, !rps paper or !rps scissors.' };
      const bot = pick(mine, rand);
      const win = (you === 'rock' && bot === 'scissors') || (you === 'paper' && bot === 'rock') || (you === 'scissors' && bot === 'paper');
      return { text: `${you} vs ${bot}: ${you === bot ? 'a draw.' : win ? `${ctx.user} wins.` : 'I win.'}` };
    }
    case 'rate': return args ? { text: `I rate ${args.slice(0, 60)} a ${Math.floor(rand() * 11)}/10.` } : { text: 'Rate what? !rate my playlist' };
    case 'hug': return { text: `${ctx.user} hugs ${args ? args.slice(0, 40) : 'everyone'}.` };
    case 'joke': return { text: pick(JOKES, rand) };
    case 'fact': return { text: pick(FACTS, rand) };
    case 'trivia': {
      const [q, a] = pick(TRIVIA, rand);
      ctx.setTrivia({ q, a, at: Date.now() });
      return { text: `Trivia: ${q} Reply with !answer <your answer>.` };
    }
    case 'answer': {
      const t = ctx.trivia;
      if (!t || Date.now() - t.at > 120000) return { text: 'No trivia running. Start one with !trivia.' };
      if (args.toLowerCase().trim() === t.a) { ctx.setTrivia(null); return { text: `${ctx.user} got it: ${t.a}.` }; }
      return { text: 'Not quite. Try again.' };
    }
    case 'poll': {
      const [q, ...opts] = args.split('|').map((s) => s.trim()).filter(Boolean);
      if (!q || opts.length < 2 || opts.length > 6) return { text: 'Use !poll Question | option one | option two (2 to 6 options).' };
      return { kind: 'poll', text: q.slice(0, 200), meta: { options: opts.map((o) => o.slice(0, 60)) } };
    }
    default: return null;
  }
};

/* ------------------------------------------------------------------ Levels */
export const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 100));
export const xpFor = (level) => level * level * 100;

/* ------------------------------------------------------------------ Toolkit */
// Small, safe expression evaluator: numbers, + - * / % ^, parentheses, unary minus, sqrt abs round floor ceil min max, pi, e.
export const calc = (src) => {
  const t = String(src ?? '').toLowerCase().replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, ' ');
  if (!t.trim() || t.length > 120) throw new Error('Give me something to calculate, like !calc 2*(3+4).');
  const toks = t.match(/\d+\.?\d*|\.\d+|[a-z]+|[-+*/%^()]/g) ?? [];
  if (toks.join('').length < t.replace(/\s/g, '').length) throw new Error('I only understand numbers and + - * / % ^ ( ).');
  let i = 0;
  const FN = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil };
  const FN2 = { min: Math.min, max: Math.max };
  const peek = () => toks[i];
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const o = toks[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = pow(); while (peek() === '*' || peek() === '/' || peek() === '%') { const o = toks[i++]; const r = pow(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const pow = () => { const b = unary(); if (peek() === '^') { i++; return b ** pow(); } return b; };
  const unary = () => { if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return atom(); };
  const atom = () => {
    const k = toks[i++];
    if (k === undefined) throw new Error('That ends too soon.');
    if (k === '(') { const v = expr(); if (toks[i++] !== ')') throw new Error('Missing a closing bracket.'); return v; }
    if (/^[\d.]/.test(k)) return Number(k);
    if (k === 'pi') return Math.PI;
    if (k === 'e') return Math.E;
    if (FN[k] || FN2[k]) {
      if (toks[i++] !== '(') throw new Error(`${k} needs brackets, like ${k}(9).`);
      const args = [expr()];
      while (FN2[k] && peek() !== ')' && peek() !== undefined) args.push(expr());
      if (toks[i++] !== ')') throw new Error('Missing a closing bracket.');
      return (FN[k] ?? FN2[k])(...args);
    }
    throw new Error(`I do not know "${k}".`);
  };
  const v = expr();
  if (i < toks.length) throw new Error('I could not read all of that.');
  if (!Number.isFinite(v)) throw new Error('That does not have a finite answer.');
  return Math.round(v * 1e10) / 1e10;
};

export const parseDuration = (s) => {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d)?$/i.exec(String(s ?? '').trim());
  if (!m) return null;
  const mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400 }[(m[2] ?? 'm').toLowerCase()];
  return Math.round(Number(m[1]) * mult * 1000);
};
export const fmtSpan = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, (!d && !h && s % 60 && `${s % 60}s`)].filter(Boolean).join(' ') || '0s';
};
export const toolkitCommand = (cmd, args, ctx) => {
  const rand = ctx.rand ?? Math.random;
  const now = ctx.now ?? Date.now();
  switch (cmd) {
    case 'calc': try { return { text: `${args} = ${calc(args)}` }; } catch (e) { return { text: e.message }; }
    case 'time': return { text: `It is ${new Date(now).toUTCString().replace('GMT', 'UTC')}.` };
    case 'pick': { const o = args.split(/\s*,\s*/).filter(Boolean); return o.length > 1 ? { text: `Pick: ${o[Math.floor(rand() * o.length)]}` } : { text: 'Give me options: !pick tea, coffee, water' }; }
    case 'password': { const set = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out = ''; for (let k = 0; k < 16; k++) out += set[Math.floor(rand() * set.length)]; return { text: `Here is one nobody has seen: ${out}`, private: true }; }
    case 'countdown': {
      const t = Date.parse(`${args.trim()}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.trim()) || Number.isNaN(t)) return { text: 'Use a date like !countdown 2027-01-01.' };
      return { text: t > now ? `${fmtSpan(t - now)} until ${args.trim()} (UTC).` : `${args.trim()} was ${fmtSpan(now - t)} ago.` };
    }
    case 'timer': case 'remind': {
      const [first, ...rest] = args.split(/\s+/);
      const ms = parseDuration(first);
      if (!ms || ms < 1000 || ms > 24 * 3600e3) return { text: `Use ${cmd === 'timer' ? '!timer 5m' : '!remind 10m take the bread out'} (1 second to 24 hours).` };
      const what = cmd === 'timer' ? 'Time is up.' : rest.join(' ').slice(0, 200);
      if (!what) return { text: 'Remind you about what? !remind 10m stand up' };
      return { text: `Okay, ${fmtSpan(ms)} from now.`, schedule: { ms, text: `${ctx.user}: ${cmd === 'timer' ? 'Your timer is up.' : `reminder, ${what}`}` } };
    }
    default: return null;
  }
};

/* ------------------------------------------------------------------ Arcade */
const WORDS = ['planet', 'rocket', 'garden', 'pirate', 'jungle', 'castle', 'puzzle', 'silver', 'thunder', 'melody', 'harvest', 'compass', 'lantern', 'glacier', 'whisper', 'monsoon', 'orchard', 'voltage', 'cascade', 'journey'];
export const arcadeCommand = (cmd, args, ctx) => {
  const rand = ctx.rand ?? Math.random;
  const g = ctx.game ?? {}; // { guess, hang, scramble, ttt }
  const set = ctx.setGame;
  const a = args.trim();
  if (cmd === 'guess') {
    if (!a) { set({ ...g, guess: { n: 1 + Math.floor(rand() * 100), tries: 0 } }); return { text: 'I am thinking of a number from 1 to 100. Use !guess 42.' }; }
    const n = Number(a);
    if (!g.guess) return { text: 'No game running. Start with !guess.' };
    if (!Number.isInteger(n) || n < 1 || n > 100) return { text: 'Pick a whole number from 1 to 100.' };
    g.guess.tries += 1;
    if (n === g.guess.n) { const t = g.guess.tries; set({ ...g, guess: null }); return { text: `${ctx.user} got it, ${n}, in ${t} ${t === 1 ? 'try' : 'tries'}.` }; }
    return { text: `${n} is too ${n < g.guess.n ? 'low' : 'high'}.` };
  }
  if (cmd === 'hangman') {
    if (!a) { const w = WORDS[Math.floor(rand() * WORDS.length) % WORDS.length]; set({ ...g, hang: { w, got: [], miss: [] } }); return { text: `Hangman: ${w.replace(/./g, '_ ').trim()}  (6 misses allowed). Use !hangman e.` }; }
    const h = g.hang; if (!h) return { text: 'No game running. Start with !hangman.' };
    const x = a.toLowerCase();
    if (x.length > 1) { if (x === h.w) { set({ ...g, hang: null }); return { text: `${ctx.user} solved it: ${h.w}.` }; } h.miss.push('?'); }
    else if (!/^[a-z]$/.test(x)) return { text: 'Guess one letter, like !hangman e.' };
    else if (h.got.includes(x) || h.miss.includes(x)) return { text: `${x} was already tried.` };
    else if (h.w.includes(x)) h.got.push(x); else h.miss.push(x);
    const shown = [...h.w].map((c) => (h.got.includes(c) ? c : '_')).join(' ');
    if (!shown.includes('_')) { set({ ...g, hang: null }); return { text: `${shown}  Solved by ${ctx.user}.` }; }
    if (h.miss.length >= 6) { set({ ...g, hang: null }); return { text: `Out of tries. The word was ${h.w}.` }; }
    return { text: `${shown}  Misses ${h.miss.length}/6: ${h.miss.join(' ') || 'none'}` };
  }
  if (cmd === 'scramble') {
    const w = WORDS[Math.floor(rand() * WORDS.length) % WORDS.length]; let s = w;
    for (let k = 0; k < 8 && s === w; k++) s = [...w].sort(() => rand() - 0.5).join('');
    set({ ...g, scramble: { w } }); return { text: `Unscramble this: ${s}. Answer with !unscramble word.` };
  }
  if (cmd === 'unscramble') {
    if (!g.scramble) return { text: 'No game running. Start with !scramble.' };
    if (a.toLowerCase() === g.scramble.w) { set({ ...g, scramble: null }); return { text: `${ctx.user} got it: ${g.scramble.w}.` }; }
    return { text: 'Not that one.' };
  }
  if (cmd === 'tictactoe' || cmd === 'ttt') return tttMove(g, set, a, ctx);
  return null;
};
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const winner = (b) => { for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x]; return b.includes('') ? null : 'draw'; };
const draw = (b) => [0, 3, 6].map((r) => b.slice(r, r + 3).map((c, k) => c || String(r + k + 1)).join(' | ')).join('\n---------\n');
const tttMove = (g, set, a, ctx) => {
  if (!g.ttt || !a) { const b = Array(9).fill(''); set({ ...g, ttt: { b, by: ctx.user } }); return { text: `Tic-tac-toe, ${ctx.user} is X.\n${draw(b)}\nPlay with !tictactoe 5 (a square from 1 to 9).` }; }
  const n = Number(a) - 1; const b = g.ttt.b;
  if (!Number.isInteger(n) || n < 0 || n > 8 || b[n]) return { text: 'Choose a free square from 1 to 9.' };
  b[n] = 'X';
  let w = winner(b);
  if (!w) {
    const free = b.map((c, k) => (c ? -1 : k)).filter((k) => k >= 0);
    const tryWin = (m) => free.find((k) => { b[k] = m; const r = winner(b) === m; b[k] = ''; return r; });
    const k = tryWin('O') ?? tryWin('X') ?? (b[4] ? free[Math.floor((ctx.rand ?? Math.random)() * free.length)] : 4);
    b[k] = 'O'; w = winner(b);
  }
  if (w) set({ ...g, ttt: null });
  return { text: `${draw(b)}${w ? `\n${w === 'draw' ? 'A draw.' : w === 'X' ? `${ctx.user} wins.` : 'I win.'}` : ''}` };
};
