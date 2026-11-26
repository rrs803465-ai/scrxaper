// First-run setup wizard: shown when the server has no owner yet. Asks for the setup code printed in the server log,
// creates the owner account and names the site.
import { $, h, clear, icon, api, fail } from './core.js';

export function runSetup(config) {
  return new Promise((resolve) => {
    const root = $('setup');
    root.hidden = false;
    const data = { code: '', displayName: '', username: '', password: '', siteName: config.siteName && config.siteName !== 'Scrxaper' ? config.siteName : '' };
    let step = 0; let busy = false; let flash = '';
    const input = (name, label, props = {}) => h('label', { class: 'field' }, label, h('input', { name, value: data[name] ?? '', autocomplete: 'off', ...props, oninput: (e) => { data[name] = e.target.value; } }));
    const note = (...kids) => h('p', { class: 'hint' }, ...kids);
    const steps = [
      { title: 'Welcome', sub: 'Let us set up your Scrxaper in four quick steps.', body: () => h('div', { class: 'stack' },
        h('ul', { class: 'setup-list' }, ...['Prove it is you with the setup code from the server log', 'Create the owner account', 'Name your site', 'Check sign-in options'].map((t, i) => h('li', {}, h('b', {}, String(i + 1)), t))),
        note('Nobody else can finish setup without the code, so it is safe to leave this page open.')), valid: () => true },
      { title: 'Setup code', sub: 'Find it in your server log (Railway: Deployments, then View logs). It looks like 8 letters and numbers.', body: () => h('div', { class: 'stack' },
        input('code', 'Setup code', { autocapitalize: 'none', spellcheck: 'false', autofocus: true, maxLength: 64, placeholder: 'a1b2c3d4' }),
        note('You can also set your own with the SETUP_CODE environment variable.')), valid: () => data.code.trim().length >= 4 || 'Enter the setup code.' },
      { title: 'Owner account', sub: 'The owner can make admins and staff and sees the site panel.', body: () => h('div', { class: 'stack' },
        input('displayName', 'Your name', { maxLength: 40, autofocus: true }), input('username', 'Username', { maxLength: 24, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'username' }),
        input('password', 'Password (12 characters or more)', { type: 'password', autocomplete: 'new-password' })),
        valid: () => (!/^[a-z0-9_]{3,24}$/i.test(data.username) ? 'Usernames are 3 to 24 letters, numbers or underscores.' : data.password.length < 12 ? 'The password needs at least 12 characters.' : true) },
      { title: 'Your site', sub: 'This name shows on the sign-in page.', body: () => h('div', { class: 'stack' },
        input('siteName', 'Site name', { maxLength: 40, autofocus: true, placeholder: 'Scrxaper' }),
        h('div', { class: 'setup-card' }, icon('google', 18), h('div', { class: 'grow' }, h('b', {}, 'Continue with Google'),
          h('p', { class: 'hint' }, config.google ? 'On. People will see the Google button on the sign-in page.' : 'Off. To turn it on, set SUPABASE_URL and SUPABASE_ANON_KEY on the server, enable Google in Supabase (Authentication, Providers) and add this site to its redirect URLs. Then restart.')))),
        valid: () => true },
    ];
    const paint = () => {
      const s = steps[step];
      const last = step === steps.length - 1;
      const msg = h('p', { class: 'error', role: 'alert' }, flash); flash = '';
      const next = h('button', { class: 'primary', type: 'button', onclick: async () => {
        const ok = s.valid(); if (ok !== true) { msg.textContent = ok; return; }
        if (!last) { step += 1; paint(); return; }
        if (busy) return; busy = true; next.disabled = true;
        try { await api('/api/setup', { body: { code: data.code.trim(), username: data.username.trim().toLowerCase(), displayName: data.displayName.trim(), password: data.password, siteName: data.siteName.trim() } }); root.hidden = true; resolve(); }
        catch (e) { busy = false; next.disabled = false; msg.textContent = e.message; if (/setup code/i.test(e.message)) { flash = e.message; step = 1; paint(); } }
      } }, last ? 'Create my Scrxaper' : 'Continue');
      const dots = h('div', { class: 'dots' }, ...steps.map((_, i) => h('i', { class: i === step ? 'on' : i < step ? 'done' : '' })));
      const body = s.body();
      body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') next.click(); });
      clear(root, h('section', { class: 'setup-card-wrap' }, h('img', { src: '/logo.png', alt: '', width: 56, height: 56, class: 'setup-logo' }), dots, h('h1', {}, s.title), h('p', { class: 'hint lead' }, s.sub), body, msg,
        h('div', { class: 'dlg-actions' }, step ? h('button', { class: 'ghost', type: 'button', onclick: () => { step -= 1; paint(); } }, 'Back') : h('span'), next)));
      setTimeout(() => root.querySelector('input')?.focus(), 60);
    };
    paint();
  });
}
