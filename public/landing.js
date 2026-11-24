const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// scroll reveal
const rev = document.querySelectorAll('.reveal');
if (reduce || !('IntersectionObserver' in window)) {
  rev.forEach(e => e.classList.add('in'));
} else {
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  rev.forEach(e => io.observe(e));
}

// sticky nav
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('stuck', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// chat typing sequence
const bubbles = [...document.querySelectorAll('#bubbles [data-b]')];
const typing = document.getElementById('typing');
if (reduce) {
  bubbles.forEach(b => b.classList.add('show'));
} else if (bubbles.length) {
  let timer;
  const wait = (ms) => new Promise(r => { timer = setTimeout(r, ms); });
  const run = async () => {
    for (;;) {
      bubbles.forEach(b => b.classList.remove('show'));
      await wait(700);
      for (let i = 0; i < bubbles.length; i++) {
        typing.classList.add('on');
        await wait(900);
        typing.classList.remove('on');
        bubbles[i].classList.add('show');
        await wait(600);
      }
      await wait(4000);
    }
  };
  run();
}

// audio-spectrum ring
const cv = document.getElementById('spectrum');
if (cv) {
  const ctx = cv.getContext('2d');
  const N = 56;
  const draw = (t) => {
    const w = cv.width, c = w / 2, r0 = w * 0.34, max = w * 0.14;
    ctx.clearRect(0, 0, w, w);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.2;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      const v = reduce ? 0.45 + 0.3 * Math.sin(i * 1.7)
        : 0.5 + 0.28 * Math.sin(t / 380 + i * 0.7) + 0.22 * Math.sin(t / 170 - i * 1.9);
      const len = 4 + Math.max(0.05, Math.min(1, v)) * max;
      const x1 = c + Math.cos(a) * r0, y1 = c + Math.sin(a) * r0;
      const x2 = c + Math.cos(a) * (r0 + len), y2 = c + Math.sin(a) * (r0 + len);
      ctx.strokeStyle = `rgba(${183 + (i % 4) * 14}, ${201 + (i % 3) * 8}, 240, ${0.55 + v * 0.4})`;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  };
  let raf = 0, visible = true;
  const loop = (t) => { draw(t); if (!reduce && visible) raf = requestAnimationFrame(loop); };
  draw(0);
  if (!reduce) {
    raf = requestAnimationFrame(loop);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => {
        const was = visible; visible = e.isIntersecting;
        if (visible && !was) raf = requestAnimationFrame(loop);
      }).observe(cv);
    }
  }
}

// install prompt
let deferred = null;
const installBtns = document.querySelectorAll('[data-install]');
const setInstall = (on) => installBtns.forEach(b => { b.hidden = !on; });
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; setInstall(true); });
installBtns.forEach(b => b.addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt();
  try { await deferred.userChoice; } catch {}
  deferred = null; setInstall(false);
}));
addEventListener('appinstalled', () => { deferred = null; setInstall(false); });
