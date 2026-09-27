/* Memphis v5 — site runtime
 *
 * Rules this file obeys:
 *  - zero dependencies, zero network calls except same-origin /api/*
 *  - every fetch is fire-and-forget; analytics must never block or break UX
 *  - with JS disabled the page must still be complete and readable
 */
(() => {
  'use strict';

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ── anonymous id: random, local-only, never sent as identity ──────────
  const VISITOR_KEY = 'memphis_vid';
  function visitorId() {
    let v = null;
    try { v = localStorage.getItem(VISITOR_KEY); } catch { /* private mode */ }
    if (!v) {
      v = 'v' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      try { localStorage.setItem(VISITOR_KEY, v); } catch { /* ignore */ }
    }
    return v;
  }

  // ── analytics: same-origin, no cookies, best effort ───────────────────
  function track(kind, label = '', path = '') {
    try {
      const body = JSON.stringify({
        kind, label, path,
        visitor: visitorId(),
        referrer: document.referrer,
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/collect.php', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/collect.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, keepalive: true,
      }).catch(() => {});
    } catch { /* never let analytics surface */ }
  }

  // ── copy-to-clipboard with real feedback ─────────────────────────────
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) {
          resolve();
        } else {
          reject(new Error('copy failed'));
        }
      } catch (e) {
        document.body.removeChild(ta);
        reject(e);
      }
    });
  }

  function wireCopy() {
    $$('[data-copy]').forEach((btn) => {
      const sel = btn.getAttribute('data-copy');
      const src = sel ? $(sel) : null;
      const text = btn.getAttribute('data-copy-text') || (src ? src.textContent.trim() : '');
      const label = btn.querySelector('[data-copy-label]') || btn;
      const original = label.textContent;

      btn.addEventListener('click', () => {
        copyText(text).then(() => {
          label.textContent = 'Skopiowane';
          btn.classList.add('is-copied');
          track('copy', btn.getAttribute('data-copy-id') || 'copy');
          setTimeout(() => {
            label.textContent = original;
            btn.classList.remove('is-copied');
          }, 1800);
        }).catch(() => {
          label.textContent = 'Zaznacz i skopiuj ręcznie';
          setTimeout(() => { label.textContent = original; }, 2600);
        });
      });
    });
  }

  // ── count up to a real target, only when it is actually visible ──────
  function animateCount(el) {
    const target = Number(el.getAttribute('data-count')) || 0;
    if (target === 0) { el.textContent = '0'; return; }
    if (REDUCED) { el.textContent = target.toLocaleString('pl-PL'); return; }
    const dur = 1100;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString('pl-PL');
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Counters only animate when scrolled into view, so numbers never
  // finish counting for a section the visitor never reached.
  function wireCounters() {
    const nums = $$('[data-count]');
    if (!nums.length) return;
    if (REDUCED || !('IntersectionObserver' in window)) {
      nums.forEach((n) => { n.textContent = Number(n.getAttribute('data-count')).toLocaleString('pl-PL'); });
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { animateCount(e.target); io.unobserve(e.target); }
      });
    }, { threshold: 0.5 });
    nums.forEach((n) => io.observe(n));
  }

  // ── terminal that types itself out ───────────────────────────────────
  function wireTerminal() {
    const term = $('#term');
    if (!term) return;
    const body = $('#term-body');
    const lines = $$('[data-line]', body);
    if (!lines.length) return;

    if (REDUCED) {
      lines.forEach((l) => { l.style.opacity = '1'; l.style.transform = 'none'; });
      return;
    }
    lines.forEach((l) => { l.style.opacity = '0'; l.style.transform = 'translateY(4px)'; });

    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      lines.forEach((line, i) => {
        setTimeout(() => {
          line.style.transition = 'opacity .25s ease, transform .25s ease';
          line.style.opacity = '1';
          line.style.transform = 'none';
        }, i * 420);
      });
    };

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { run(); io.disconnect(); }
        });
      }, { threshold: 0.35 });
      io.observe(term);
    } else {
      run();
    }
  }

  // ── scroll reveal, gated on .js so no-JS never leaves blank blocks ──
  function wireReveal() {
    const items = $$('.reveal');
    if (!items.length) return;
    if (REDUCED || !('IntersectionObserver' in window)) {
      items.forEach((i) => i.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((i) => io.observe(i));
  }

  // ── scroll depth: 25/50/75/100, once each ────────────────────────────
  function wireScrollDepth() {
    const marks = new Set();
    if (REDUCED) return;
    const check = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      if (max <= 0) return;
      const pct = Math.min(100, Math.round((window.scrollY / max) * 100));
      [25, 50, 75, 100].forEach((m) => {
        if (pct >= m && !marks.has(m)) {
          marks.add(m);
          track('scroll_depth', String(m));
        }
      });
    };
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { check(); ticking = false; });
    }, { passive: true });
    check();
  }

  // ── FAQ accordion ────────────────────────────────────────────────────
  function wireFaq() {
    $$('.faq-item').forEach((item) => {
      const btn = $('button', item);
      const body = $('.faq-body', item);
      if (!btn || !body) return;
      btn.addEventListener('click', () => {
        const open = item.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', String(open));
        if (open) track('expand', 'faq');
      });
    });
  }

  // ── tabs (use cases) ─────────────────────────────────────────────────
  function wireTabs() {
    const tabs = $$('[role="tab"]');
    if (!tabs.length) return;
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.classList.toggle('is-active', on);
        });
        $$('[role="tabpanel"]').forEach((p) => {
          p.hidden = p.id !== tab.getAttribute('aria-controls');
        });
        track('expand', 'tab:' + tab.getAttribute('data-tab'));
      });
    });
  }

  // ── newsletter: posts, then reports what actually happened ──────────
  function wireNewsletter() {
    const form = $('#nl-form');
    if (!form) return;
    const input = $('#nl-email');
    const consent = $('#nl-consent');
    const msg = $('#nl-msg');
    const submit = $('#nl-submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!consent || !consent.checked) {
        msg.textContent = 'Zaznacz zgodę na przetwarzanie adresu.';
        msg.className = 'nl-msg is-error';
        return;
      }
      const email = input.value.trim();
      if (!email) return;

      submit.disabled = true;
      submit.textContent = 'Zapisuję…';
      msg.textContent = '';

      try {
        const res = await fetch('/api/lead.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            consent: 'true',
            kind: 'newsletter',
            source: 'hero',
          }),
        });
        const data = await res.json();
        if (data.ok) {
          form.reset();
          msg.textContent = data.message;
          msg.className = 'nl-msg is-ok';
          track('newsletter', 'form');
        } else {
          msg.textContent = data.error === 'invalid_email'
            ? 'Ten adres wygląda na niepoprawny.'
            : 'Coś poszło nie tak. Spróbuj raz jeszcze.';
          msg.className = 'nl-msg is-error';
        }
      } catch {
        msg.textContent = 'Brak połączenia z serwerem. Spróbuj ponownie.';
        msg.className = 'nl-msg is-error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Zapisz mnie';
      }
    });
  }

  // ── outbound clicks that are real conversions ───────────────────────
  function wireConversionLinks() {
    $$('[data-conversion]').forEach((a) => {
      a.addEventListener('click', () => {
        track('cta', a.getAttribute('data-conversion'));
      });
    });
    const dl = $('#install-cmd');
    if (dl) {
      dl.addEventListener('click', () => track('download', 'install.sh'));
    }
  }

  // ── video: only report real playback, never autoplay sound ───────────
  function wireVideo() {
    const v = $('video');
    if (!v) return;
    v.addEventListener('play', () => track('play', 'install-30s'), { once: true });
  }

  // ── mobile nav ─────────────────────────────────────────────────────
  function wireNav() {
    const burger = $('.nav-burger');
    const menu = $('#mobile-menu');
    if (!burger || !menu) return;
    burger.addEventListener('click', () => {
      const open = menu.hasAttribute('hidden');
      if (open) { menu.removeAttribute('hidden'); } else { menu.setAttribute('hidden', ''); }
      burger.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') {
        menu.setAttribute('hidden', '');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function init() {
    wireNav();
    wireCopy();
    wireCounters();
    wireTerminal();
    wireReveal();
    wireScrollDepth();
    wireFaq();
    wireTabs();
    wireNewsletter();
    wireConversionLinks();
    wireVideo();
    track('pageview', '', location.pathname);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
