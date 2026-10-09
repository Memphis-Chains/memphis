/* Memphis Chat — frontend
 *
 * Kontrakt (single source of truth, z Memphis Agent):
 *   POST https://api.memphis-v5.pl/chat
 *   { message: string, sessionId?: string }
 *   → { ok: true, reply: string, sessionId: string }
 *   → { ok: false, error: "rate_limited" | "invalid_input" | "backend_unavailable" }
 *
 * Mock mode (?mock=1): zwraca echo z opóźnieniem, bez kontaktu z API.
 */

(() => {
  'use strict';

  // ---------- config ----------
  const params = new URLSearchParams(window.location.search);
  // Mock domyślnie — api.* jeszcze nie działa do czasu Cloudflare Tunnel
  // W produkcji: ?real=1 włącza prawdziwy backend
  const FORCE_MOCK = params.get('mock') === '1' || params.get('real') !== '1';
  const FORCE_REAL = params.get('real') === '1';
  const API_URL = FORCE_MOCK ? 'mock' : 'https://api.memphis-v5.pl/chat';
  const SESSION_KEY = 'memphis-chat-session';
  const RATE_KEY = 'memphis-chat-rate';
  const RATE_LIMIT_PER_HOUR = 10;

  // ---------- session ----------
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  // ---------- rate limit (klient-side, informacyjny) ----------
  function getRate() {
    try {
      const raw = localStorage.getItem(RATE_KEY);
      if (!raw) return { count: 0, resetAt: Date.now() + 3600_000 };
      const parsed = JSON.parse(raw);
      if (Date.now() > parsed.resetAt) return { count: 0, resetAt: Date.now() + 3600_000 };
      return parsed;
    } catch {
      return { count: 0, resetAt: Date.now() + 3600_000 };
    }
  }
  function bumpRate() {
    const r = getRate();
    r.count += 1;
    localStorage.setItem(RATE_KEY, JSON.stringify(r));
    updateRatePill(r);
  }
  function updateRatePill(r) {
    const pill = document.getElementById('rate-pill');
    if (!pill) return;
    const left = RATE_LIMIT_PER_HOUR - r.count;
    pill.textContent = left > 0
      ? `rate limit: ${left} / ${RATE_LIMIT_PER_HOUR} · IP / godz`
      : 'rate limit: 0 / 10 · IP / godz · czekaj';
    if (left <= 2) pill.style.color = 'var(--warn)';
    if (left <= 0) pill.style.color = 'var(--danger)';
  }

  // ---------- DOM ----------
  const log = document.getElementById('log');
  const empty = document.getElementById('empty');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const status = document.getElementById('status');

  // ---------- render ----------
  function renderMsg({ role, text, streaming = false, error = false }) {
    if (empty) empty.style.display = 'none';
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${streaming ? ' streaming' : ''}${error ? ' error' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? 'TY' : 'M';

    const body = document.createElement('div');
    body.className = 'msg-body';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    meta.textContent = role === 'user' ? `ty · ${time}` : `memphis · ${time}`;

    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = text;

    body.appendChild(meta);
    body.appendChild(textEl);
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    log.appendChild(wrap);

    const win = wrap.closest('.chat-window');
    if (win) win.scrollTop = win.scrollHeight;

    return textEl;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function renderRichText(text) {
    // bardzo prosty markdown-ish: **bold**, `code`, linki
    let safe = escapeHtml(text);
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return safe;
  }

  // ---------- mock ----------
  async function mockRequest(message) {
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
    const replies = [
      `[mock] Dostałem: "${message.slice(0, 80)}". To jest tryb mock — prawdziwy backend jeszcze nie podpięty.`,
      `[mock] Brzmi sensownie. W produkcji odpowiedziałbym na: "${message.slice(0, 60)}..."`,
      `[mock] Echo: ${message}`,
      `[mock] MiniMax-M3 by tu coś powiedział, ale jesteśmy jeszcze w trybie demo.`,
    ];
    return {
      ok: true,
      reply: replies[Math.floor(Math.random() * replies.length)],
      sessionId,
    };
  }

  // ---------- real ----------
  async function realRequest(message) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      let data;
      try { data = await res.json(); }
      catch { return { ok: false, error: 'backend_unavailable' }; }
      if (!res.ok) return { ok: false, error: data?.error || 'backend_unavailable' };
      if (data && data.ok === false) return data;
      if (!data || typeof data.reply !== 'string') return { ok: false, error: 'backend_unavailable' };
      if (data.sessionId && data.sessionId !== sessionId) {
        sessionId = data.sessionId;
        sessionStorage.setItem(SESSION_KEY, sessionId);
      }
      return data;
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') return { ok: false, error: 'backend_unavailable' };
      // prawdopodobnie CORS / sieć / DNS
      return { ok: false, error: 'backend_unavailable' };
    }
  }

  // ---------- submit ----------
  function setStatus(text, isError = false) {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('err', !!isError);
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) {
      renderMsg({ role: 'assistant', text: 'Wiadomość za długa (max 2000 znaków).', error: true });
      return;
    }

    const r = getRate();
    if (r.count >= RATE_LIMIT_PER_HOUR) {
      const mins = Math.ceil((r.resetAt - Date.now()) / 60_000);
      renderMsg({
        role: 'assistant',
        text: `Limit rozmów na godzinę osiągnięty. Spróbuj za ~${mins} min.`,
        error: true,
      });
      return;
    }

    renderMsg({ role: 'user', text });
    input.value = '';
    autoSize();
    sendBtn.disabled = true;
    setStatus('memphis myśli…');

    // streaming UI: najpierw pusty assistant, potem uzupełniamy
    const assistantEl = renderMsg({ role: 'assistant', text: '', streaming: true });

    let data;
    try {
      data = FORCE_MOCK ? await mockRequest(text) : await realRequest(text);
    } catch {
      data = { ok: false, error: 'backend_unavailable' };
    }

    if (data.ok) {
      // trywialny streaming przez znaki (jeśli kiedyś backend da SSE to podmienimy)
      const reply = data.reply;
      assistantEl.classList.remove('streaming');
      assistantEl.textContent = '';
      let i = 0;
      const step = () => {
        if (i >= reply.length) {
          bumpRate();
          updateRatePill(getRate());
          setStatus('');
          sendBtn.disabled = false;
          input.focus();
          return;
        }
        const chunkSize = Math.max(2, Math.floor(reply.length / 60));
        assistantEl.textContent = reply.slice(0, i + chunkSize);
        i += chunkSize;
        const win = assistantEl.closest('.chat-window');
        if (win) win.scrollTop = win.scrollHeight;
        setTimeout(step, 16);
      };
      step();
    } else {
      assistantEl.classList.remove('streaming');
      const text = data.error === 'rate_limited'
        ? 'Serwer: rate_limited. Zwolnij.'
        : data.error === 'invalid_input'
        ? 'Serwer: invalid_input. Sprawdź wiadomość.'
        : 'Serwer: backend_unavailable. Spróbuj za chwilę.';
      assistantEl.parentElement.parentElement.classList.add('error');
      assistantEl.textContent = text;
      setStatus('błąd', true);
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ---------- input auto-resize ----------
  function autoSize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  // ---------- events ----------
  form.addEventListener('submit', handleSubmit);
  input.addEventListener('input', autoSize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  });

  // sugestie
  document.querySelectorAll('.suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.suggest || '';
      autoSize();
      input.focus();
    });
  });

  // ---------- boot ----------
  updateRatePill(getRate());
  if (FORCE_MOCK) {
    setStatus('tryb mock · ?real=1 dla prawdziwego backendu', false);
  }
  input.focus();
})();
