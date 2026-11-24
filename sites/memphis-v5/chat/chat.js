(() => {
  'use strict';
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const log = document.getElementById('log');
  const mode = document.getElementById('mode');
  const note = document.getElementById('model-note');
  const history = [];
  let sessionId;
  let pending = false;

  function describeMode() {
    if (note) note.textContent = mode?.value === 'local'
      ? 'Wiadomości przetwarza Bielik na komputerze Memphisa. Pozostają poza usługą MiniMax.'
      : 'Basal sprawdza pytanie na komputerze Memphisa. MiniMax otrzymuje wiadomość, dwie ostatnie wymiany i pasujący jawny fragment pamięci. Gdy usługa jest niedostępna, odpowiada lokalny Bielik.';
  }
  if (mode && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) mode.value = 'local';
  describeMode();
  mode?.addEventListener('change', () => {
    history.length = 0;
    sessionId = undefined;
    log.replaceChildren();
    document.getElementById('empty').style.display = '';
    document.getElementById('empty').hidden = false;
    describeMode();
  });

  function render(role, text, error = false, source = 'Memphis', classification) {
    document.getElementById('empty').hidden = true;
    document.getElementById('empty').style.display = 'none';
    const row = document.createElement('div');
    row.className = 'msg ' + role + (error ? ' error' : '');
    const avatar = document.createElement('span');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? 'Ty' : 'M';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const label = document.createElement('div');
    label.className = 'msg-meta';
    label.textContent = role === 'user' ? 'Ty' : source;
    const content = document.createElement('div');
    content.className = 'msg-text';
    content.textContent = text;
    body.append(label, content);
    const reference = classification?.source;
    if (reference && typeof reference.text === 'string' && Number.isInteger(reference.index)) {
      const details = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = 'Źródło z pamięci · ' + reference.chain + ' #' + reference.index;
      const excerpt = document.createElement('p');
      excerpt.textContent = reference.text;
      details.append(title, excerpt);
      body.appendChild(details);
    }
    row.append(avatar, body);
    log.appendChild(row);
    row.scrollIntoView({ block: 'nearest' });
  }

  function resize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const message = input.value.trim();
    if (!message) return;
    if (message.length > 2000) {
      status.textContent = 'Skróć wiadomość do 2000 znaków.';
      return;
    }
    pending = true;
    send.disabled = true;
    if (mode) mode.disabled = true;
    input.value = '';
    resize();
    render('user', message);
    status.textContent = 'Memphis przygotowuje odpowiedź…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 130_000);
    try {
      const response = await fetch('./api.php', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId, history, mode: mode?.value || 'local' }), signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true || typeof data.reply !== 'string' || !data.reply.trim()) {
        const wait = Number(response.headers.get('Retry-After'));
        if (response.status === 429) throw new Error(wait > 0
          ? 'Wysyłasz wiadomości bardzo szybko. Spróbuj za ' + wait + ' s.'
          : 'Wysyłasz wiadomości bardzo szybko. Spróbuj za chwilę.');
        if (data.error === 'restricted') throw new Error('Memphis nie może odpowiedzieć na tę wiadomość.');
        if (data.error === 'busy') throw new Error('Memphis odpowiada teraz innej osobie. Spróbuj za chwilę.');
        if (data.error === 'invalid_input') throw new Error('Sprawdź wiadomość i wyślij ją ponownie.');
        throw new Error('offline');
      }
      sessionId = data.sessionId;
      history.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply.slice(0, 2000) });
      if (history.length > 4) history.splice(0, 2);
      render('assistant', data.reply, false,
        data.meta?.provider === 'minimax' ? data.meta.model : 'Bielik · na komputerze Memphisa', data.meta?.classification);
      status.textContent = '';
    } catch (error) {
      const known = ['Wysyłasz wiadomości', 'Memphis odpowiada teraz', 'Memphis nie może', 'Sprawdź wiadomość'];
      const feedback = known.some(prefix => error.message?.startsWith(prefix)) ? error.message
        : 'Nie udało się połączyć z Memphisem. Spróbuj ponownie za chwilę.';
      render('assistant', feedback, true);
      status.textContent = '';
      if (!input.value) input.value = message;
      resize();
    } finally {
      clearTimeout(timeout);
      pending = false;
      send.disabled = false;
      if (mode) mode.disabled = false;
      input.focus();
    }
  });

  input.addEventListener('input', resize);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  document.querySelectorAll('.suggestion').forEach(button => {
    button.addEventListener('click', () => {
      input.value = button.dataset.suggest || '';
      resize();
      input.focus();
    });
  });
})();
