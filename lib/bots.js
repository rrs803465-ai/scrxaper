// Premade bots. They run inside the server: there are no tokens, webhooks or external programs.
export const BOT_USERS = {
  sentinel: { name: 'Sentinel', icon: 'shield' },
  jukebox: { name: 'Jukebox', icon: 'music' },
  greeter: { name: 'Greeter', icon: 'wave' },
  funbot: { name: 'Funbot', icon: 'dice' },
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
  play: 'jukebox', pause: 'jukebox', resume: 'jukebox', skip: 'jukebox', queue: 'jukebox', now: 'jukebox', stop: 'jukebox', tracks: 'jukebox' };

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
