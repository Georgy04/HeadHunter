const $ = (id) => document.getElementById(id);
const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TOKEN_KEY = 'hh_token';

let token = localStorage.getItem(TOKEN_KEY) || '';
let snapshot = null;
let pollTimer = null;
let confirmAction = null;
const seenInbox = new Set(JSON.parse(localStorage.getItem('hh_seen') || '[]'));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-player-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка сети'), { code: data.code, status: res.status });
  return data;
}

function toast(text, ms = 3000) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function showScreen(name) {
  ['register', 'login', 'wait', 'game'].forEach((screen) => {
    $(`screen-${screen}`).classList.toggle('hidden', screen !== name);
  });
}

// --- Шаг 1: регистрация -------------------------------------------------------

$('btn-suggest').addEventListener('click', async () => {
  try {
    $('input-nickname').value = (await api('/api/nickname')).nickname;
  } catch {
    toast('Не удалось придумать никнейм, введите свой');
  }
});

$('btn-register').addEventListener('click', async () => {
  const name = $('input-name').value.trim();
  const nickname = $('input-nickname').value.trim();
  const pin = $('input-pin').value.trim();
  $('register-error').classList.add('hidden');
  if (name.length < 2) return showError('register-error', 'Введите имя');
  if (nickname.length < 2) return showError('register-error', 'Придумайте никнейм');
  if (!/^\d{4}$/.test(pin)) return showError('register-error', 'PIN — это четыре цифры');

  $('btn-register').disabled = true;
  try {
    const data = await api('/api/register', { method: 'POST', body: { name, nickname, pin } });
    enterWith(data);
  } catch (err) {
    showError('register-error', err.message);
  } finally {
    $('btn-register').disabled = false;
  }
});

// Вход по «имя + PIN»: телефон могли почистить или сменить, а токен живёт только
// в браузере. Имя не тайна, поэтому PIN здесь — единственная преграда.
$('btn-login').addEventListener('click', async () => {
  const name = $('login-name').value.trim();
  const pin = $('login-pin').value.trim();
  $('login-error').classList.add('hidden');
  if (name.length < 2) return showError('login-error', 'Введите имя');
  if (!/^\d{4}$/.test(pin)) return showError('login-error', 'PIN — это четыре цифры');

  $('btn-login').disabled = true;
  try {
    const data = await api('/api/login', { method: 'POST', body: { name, pin } });
    enterWith(data);
  } catch (err) {
    showError('login-error', err.message);
  } finally {
    $('btn-login').disabled = false;
  }
});

$('btn-to-login').addEventListener('click', () => {
  $('login-error').classList.add('hidden');
  $('login-name').value = $('input-name').value.trim();
  showScreen('login');
});

$('btn-to-register').addEventListener('click', () => {
  $('register-error').classList.add('hidden');
  showScreen('register');
});

['input-pin', 'login-pin'].forEach((id) => {
  $(id).addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
});

function enterWith(data) {
  token = data.token;
  localStorage.setItem(TOKEN_KEY, token);
  apply(data);
  startPolling();
}

function showError(id, text) {
  $(id).textContent = text;
  $(id).classList.remove('hidden');
}

// --- Шаг 2: ожидание бейджа и старта ------------------------------------------

/**
 * Пока бейджа нет, игрок видит свою будущую эмблему и идёт с ней к ведущему.
 * После выдачи, но до старта, тот же экран показывает, что человек уже в игре.
 */
function renderWait(data) {
  const { me, game } = data;
  const waitingForBadge = !me.hasBadge;

  $('wait-name').textContent = me.name;
  $('wait-nickname').textContent = me.nickname;
  $('wait-emblem').innerHTML = me.emblem ? me.emblem.svg : '';
  $('wait-desc').textContent = me.emblem ? me.emblem.description : '';

  if (waitingForBadge) {
    $('wait-title').textContent = 'Ваша эмблема';
    $('wait-lead').textContent = 'Покажите этот экран ведущему — он выдаст бейдж с такой эмблемой.';
    $('wait-code').textContent = me.emblem ? me.emblem.code : '';
    $('wait-note').textContent = 'Экран сменится сам, как только ведущий подтвердит выдачу.';
  } else {
    const players = data.board.length;
    $('wait-title').textContent = 'Вы в игре';
    $('wait-lead').textContent = 'Бейдж получен. Носите эмблему на виду — по ней вас будут искать.';
    $('wait-code').textContent = '';
    $('wait-note').textContent = `Ждём, когда ведущий начнёт игру. Участников с бейджами: ${players}.`;
  }

  showScreen('wait');
}

// --- Игровой цикл -------------------------------------------------------------

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 8000);
}

async function refresh() {
  try {
    apply(await api('/api/me'));
  } catch (err) {
    if (err.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      location.href = '/';
      return;
    }
    // Первый запрос не прошёл — объясняем, вместо того чтобы показывать пустоту.
    if (!snapshot) {
      $('wait-title').textContent = 'Нет связи';
      $('wait-lead').textContent = 'Сервер игры не отвечает. Проверьте, что вы подключены к сети площадки.';
      $('wait-note').textContent = 'Попробуем снова через несколько секунд.';
      showScreen('wait');
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token) refresh();
});

const STATUS_TEXT = {
  lobby: 'Игра ещё не началась',
  running: 'Игра идёт',
  paused: 'Пауза',
  finished: 'Игра окончена',
};

function apply(data) {
  const prev = snapshot;
  snapshot = data;
  const { me, rules, game } = data;
  announce(prev, data);

  // До выдачи бейджа и до старта игры играть нечем: показываем экран ожидания,
  // чтобы человек не тыкал в кнопки, которые всё равно ответят отказом.
  if (!me.hasBadge || game.status === 'lobby') {
    renderWait(data);
    return;
  }
  if ($('screen-game').classList.contains('hidden')) showScreen('game');

  $('top-nickname').textContent = me.nickname;
  $('top-status').textContent = STATUS_TEXT[game.status] ?? game.status;
  $('top-score').textContent = me.score;

  $('target-nickname').textContent = me.target ? me.target.nickname : 'ждём начала игры';
  $('shoot-target').textContent = me.target ? me.target.nickname : '—';
  $('shoot-hit').textContent = `+${rules.hitPoints}`;
  $('shoot-miss').textContent = `−${rules.missPenalty}`;
  $('defense-points').textContent = `+${rules.defensePoints}`;

  $('my-emblem').innerHTML = me.emblem.svg;
  $('my-emblem-note').textContent = me.emblem.description;

  renderHints(me);
  renderAmmo(me, rules);
  renderLog(me);
  renderInbox(me.inbox);
  renderPeople(data.roster, me);
  renderDefense(me);
  renderBoard(data.board, me.nickname);
}

/** Два перехода игрок может пропустить, если экран лежит в кармане: сообщаем о них. */
function announce(prev, data) {
  if (!prev) return;
  if (!prev.me.hasBadge && data.me.hasBadge) {
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    toast('Бейдж выдан. Носите эмблему на виду.', 6000);
  }
  if (prev.game.status === 'lobby' && data.game.status === 'running') {
    if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
    toast('Игра началась. Ваша цель уже в приложении.', 6000);
  }
}

function renderHints(me) {
  $('hints-left').textContent = me.hints.length ? `· осталось ${me.hintsLeft}` : '';
  $('hints-list').innerHTML = me.hints.length
    ? me.hints.map((h) => `<li>${esc(h.text)}</li>`).join('')
    : '<li class="muted small">Подсказок пока нет. Их дают за активности — введите полученный код ниже.</li>';
}

function renderAmmo(me, rules) {
  $('ammo-dots').innerHTML = Array.from(
    { length: rules.ammoMax },
    (_, i) => `<div class="bullet ${i < me.ammo ? 'full' : ''}"></div>`
  ).join('');

  const parts = [];
  if (me.ammo < rules.ammoMax && me.nextAmmoAt) parts.push(`следующий патрон через ${countdown(me.nextAmmoAt)}`);
  if (me.cooldownUntil > Date.now()) parts.push(`ствол остынет через ${countdown(me.cooldownUntil)}`);
  if (parts.length === 0) parts.push(`полный боезапас, +1 патрон каждые ${rules.ammoRegenMinutes} мин`);
  $('ammo-note').textContent = parts.join(', ');
}

function countdown(ts) {
  const total = Math.ceil(Math.max(0, ts - Date.now()) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  return m > 0 ? `${m} мин ${s} с` : `${s} с`;
}

function renderLog(me) {
  const list = $('log-list');
  if (!me.log.length) {
    list.innerHTML = '<li class="muted small">Пока не стреляли</li>';
    return;
  }
  const LABEL = { hit: 'попадание', miss: 'мимо', blocked: 'защита цели' };
  list.innerHTML = me.log
    .map((entry) => {
      const extra = entry.result === 'hit' ? ` — это был ${esc(entry.targetNickname ?? '')}` : '';
      return `<li>
        <span class="badge-res ${entry.result}">${entry.points > 0 ? '+' : ''}${entry.points || 0}</span>
        <span class="small">${esc(entry.targetName)}<span class="muted"> · ${LABEL[entry.result]}${extra}</span></span>
      </li>`;
    })
    .join('');
}

function renderInbox(inbox) {
  const fresh = inbox.filter((m) => !m.read);
  $('inbox').innerHTML = fresh
    .map((m) => `<div class="note ${esc(m.kind)}">${esc(m.text)}<span class="muted small"> — нажмите, чтобы убрать</span></div>`)
    .join('');

  const unseen = fresh.filter((m) => !seenInbox.has(m.id));
  if (unseen.length) {
    unseen.forEach((m) => seenInbox.add(m.id));
    localStorage.setItem('hh_seen', JSON.stringify([...seenInbox].slice(-60)));
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    toast(unseen[0].text, 5000);
  }
}

$('inbox').addEventListener('click', async () => {
  if (!snapshot?.me.inbox.some((m) => !m.read)) return;
  $('inbox').innerHTML = '';
  await api('/api/inbox/read', { method: 'POST' }).catch(() => {});
  refresh();
});

// --- Списки людей -------------------------------------------------------------

function renderPeople(roster, me) {
  const others = roster.filter((p) => p.id !== me.id);
  $('list-shoot').innerHTML = others
    .map((p) => {
      const tried = me.attempts.includes(p.id);
      return `<button class="person ${tried ? 'tried' : ''}" data-id="${p.id}" data-name="${esc(p.name)}" ${
        tried ? 'disabled' : ''
      }>${esc(p.name)}${tried ? '<span class="muted small">уже стреляли</span>' : ''}</button>`;
    })
    .join('');

  $('list-defense').innerHTML = others
    .map((p) => `<button class="person" data-id="${p.id}" data-name="${esc(p.name)}">${esc(p.name)}</button>`)
    .join('');

  applySearch('shoot');
  applySearch('defense');
}

function applySearch(kind) {
  const query = $(`search-${kind}`).value.trim().toLowerCase();
  $(`list-${kind}`)
    .querySelectorAll('.person')
    .forEach((btn) => {
      btn.classList.toggle('hidden', Boolean(query) && !btn.dataset.name.toLowerCase().includes(query));
    });
}

['shoot', 'defense'].forEach((kind) => {
  $(`search-${kind}`).addEventListener('input', () => applySearch(kind));
});

function renderDefense(me) {
  const parts = [];
  if (me.defense.shielded) parts.push('Щит активен: ближайший выстрел вашего охотника не пройдёт.');
  if (me.defense.nextTryAt > Date.now()) parts.push(`Следующая попытка через ${countdown(me.defense.nextTryAt)}.`);
  if (me.defense.identified) parts.push(`Охотников вычислено: ${me.defense.identified}.`);
  $('defense-status').textContent = parts.join(' ');
}

// --- Действия -----------------------------------------------------------------

function askConfirm(html, action) {
  $('modal-body').innerHTML = html;
  confirmAction = action;
  $('modal').classList.remove('hidden');
}

$('modal-cancel').addEventListener('click', () => {
  confirmAction = null;
  $('modal').classList.add('hidden');
});

$('modal-confirm').addEventListener('click', async () => {
  const action = confirmAction;
  confirmAction = null;
  $('modal').classList.add('hidden');
  if (action) await action();
});

$('list-shoot').addEventListener('click', (event) => {
  const btn = event.target.closest('.person');
  if (!btn || !snapshot) return;
  if (!snapshot.me.target) return toast('Контракт ещё не выдан');
  if (snapshot.me.ammo < 1) return toast('Патронов нет, ждите перезарядки');

  askConfirm(
    `<div class="card-label">Подтвердите выстрел</div>
     <p class="center big-name">${esc(btn.dataset.name)}</p>
     <p class="center">Вы заявляете, что это <b>${esc(snapshot.me.target.nickname)}</b></p>
     <p class="muted small center">Промах стоит ${snapshot.rules.missPenalty} очков и патрон.</p>`,
    async () => {
      try {
        const res = await api('/api/shoot', { method: 'POST', body: { playerId: btn.dataset.id } });
        apply(res.state);
        showShotFlash(res, btn.dataset.name);
      } catch (err) {
        toast(err.message, 4000);
        refresh();
      }
    }
  );
});

$('list-defense').addEventListener('click', (event) => {
  const btn = event.target.closest('.person');
  if (!btn || !snapshot) return;

  askConfirm(
    `<div class="card-label">Выставить защиту</div>
     <p class="center big-name">${esc(btn.dataset.name)}</p>
     <p class="center">Вы считаете, что этот человек охотится на вас.</p>
     <p class="muted small center">Не угадаете — следующая попытка нескоро.</p>`,
    async () => {
      try {
        const res = await api('/api/defend', { method: 'POST', body: { playerId: btn.dataset.id } });
        if (res.state) apply(res.state);
        showDefenseFlash(res);
      } catch (err) {
        toast(err.message, 4000);
        refresh();
      }
    }
  );
});

$('btn-code').addEventListener('click', async () => {
  const code = $('input-code').value.trim();
  if (!code) return;
  try {
    const res = await api('/api/code', { method: 'POST', body: { code } });
    $('input-code').value = '';
    apply(res.state);
    if (res.hint) toast(`Подсказка: ${res.hint.text}`, 7000);
    else if (res.hintsExhausted) toast('Подсказки по текущей цели кончились', 5000);
    if (res.points) toast(`Начислено ${res.points} очков`, 5000);
  } catch (err) {
    toast(err.message, 4000);
  }
});

function flash(html, ms) {
  $('flash-inner').innerHTML = html;
  $('flash').classList.remove('hidden');
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => $('flash').classList.add('hidden'), ms);
}

function showShotFlash(res, name) {
  if (navigator.vibrate) navigator.vibrate(res.result === 'hit' ? [60, 40, 120] : 200);
  if (res.result === 'hit') {
    flash(
      `<div class="flash-title hit">ПОПАДАНИЕ</div>
       <div class="flash-sub">${esc(name)} и есть ${esc(res.victimNickname)}. ${res.points > 0 ? '+' : ''}${res.points} очков.<br />
       Новая цель: <b>${esc(res.newTargetNickname ?? '—')}</b></div>`,
      4200
    );
  } else if (res.result === 'blocked') {
    flash(
      `<div class="flash-title blocked">ЗАЩИТА</div>
       <div class="flash-sub">Вы опознали человека верно, но он успел выставить защиту. Патрон потрачен, очки на месте.</div>`,
      4200
    );
  } else {
    flash(`<div class="flash-title miss">МИМО</div><div class="flash-sub">Это не ваша цель. ${res.points} очков.</div>`, 2600);
  }
}

function showDefenseFlash(res) {
  if (res.result === 'right') {
    flash(
      `<div class="flash-title hit">ВЫЧИСЛИЛИ</div>
       <div class="flash-sub">${esc(res.suspectName)} действительно охотится на вас.${
        res.points ? ` +${res.points} очков.` : ' Очки за него уже начислены раньше.'
      }<br />Щит выставлен.</div>`,
      4200
    );
  } else if (res.result === 'no_hunters') {
    flash(
      `<div class="flash-title">ПОКА ТИХО</div>
       <div class="flash-sub">На вас сейчас никто не охотится. Попытка не потрачена.</div>`,
      3200
    );
  } else {
    flash(`<div class="flash-title miss">НЕ УГАДАЛИ</div><div class="flash-sub">Этот человек за вами не охотится.</div>`, 2800);
  }
}

$('flash').addEventListener('click', () => $('flash').classList.add('hidden'));

// --- Табло и вкладки ----------------------------------------------------------

function renderBoard(rows, myNickname) {
  $('board-list').innerHTML = rows
    .map(
      (r) => `<li class="${r.nickname === myNickname ? 'me' : ''}">
        <span>${esc(r.nickname)}<span class="sub">${r.hits} попаданий · ${r.misses} промахов</span></span>
        <span class="pts">${r.score}</span>
      </li>`
    )
    .join('');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    ['home', 'shoot', 'defense', 'board'].forEach((view) => {
      $(`view-${view}`).classList.toggle('hidden', view !== tab.dataset.view);
    });
    window.scrollTo(0, 0);
  });
});

// Таймеры патронов и перезарядки тикают локально, без запросов к серверу.
setInterval(() => {
  if (snapshot?.me?.hasBadge && !$('screen-game').classList.contains('hidden')) {
    renderAmmo(snapshot.me, snapshot.rules);
    renderDefense(snapshot.me);
  }
}, 1000);

if (token) {
  $('wait-title').textContent = 'Загружаем';
  $('wait-lead').textContent = 'Связываемся с сервером игры…';
  $('wait-note').textContent = '';
  showScreen('wait');
  refresh().then(startPolling);
} else {
  showScreen('register');
}
