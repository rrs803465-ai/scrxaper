// Interactive finishing: press ripples, card tilt and gentle reveals. Everything is delegated, so it costs nothing per element.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TILT = '.shopitem, .tilt, .track';
export function startFx() {
  if (reduce) return;
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('.primary, .ghost, button.chip'); if (!b) return;
    const r = b.getBoundingClientRect(); const d = Math.max(r.width, r.height) * 2;
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    b.style.overflow = 'hidden';
    const s = document.createElement('span'); s.className = 'rip'; s.style.width = s.style.height = `${d}px`; s.style.left = `${e.clientX - r.left - d / 2}px`; s.style.top = `${e.clientY - r.top - d / 2}px`;
    b.append(s); setTimeout(() => s.remove(), 650);
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return; const c = e.target.closest?.(TILT); if (!c) return;
    const r = c.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - .5; const y = (e.clientY - r.top) / r.height - .5;
    c.style.transform = `perspective(700px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg) translateY(-2px)`;
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { const c = e.target.closest?.(TILT); if (c && !c.contains(e.relatedTarget)) c.style.transform = ''; }, { passive: true });
  const io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { threshold: .08 });
  const seen = (n) => { if (n.nodeType === 1) { if (n.matches?.('.shopitem, .post')) { n.classList.add('reveal'); io.observe(n); } n.querySelectorAll?.('.shopitem, .post').forEach((k) => { k.classList.add('reveal'); io.observe(k); }); } };
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(seen))).observe(document.body, { childList: true, subtree: true });
}
