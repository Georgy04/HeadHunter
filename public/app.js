const $ = (id) => document.getElementById(id);
const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TOKEN_KEY = 'hh_token';

let token = localStorage.getItem(TOKEN_KEY) || '';
let snapshot = null;
// Часы телефона и часы ноутбука-сервера редко совпадают минута в минуту, а на
// площадке без интернета их и синхронизировать нечем. Сроки перезарядки и
// остывания ствола сервер присылает своими метками времени, поэтому сравнивать
// их с локальными часами нельзя: разойдись они на десять минут — и приложение
// пообещает патрон, которого сервер ещё не даст. Держим поправку и живём по
// серверному времени.
let clockSkew = 0;
const serverNow = () => Date.now() + clockSkew;
let pollTimer = null;
let confirmAction = null;
// Смысл выстрела: по своему контракту или за награду в розыске.
let shootMode = 'contract';
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
  if (data.serverTime) clockSkew = data.serverTime - Date.now();
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
  // Номер раунда показываем со второго: он объясняет, почему никнейм сменился.
  $('top-status').textContent =
    (game.round ?? 0) > 1
      ? `раунд ${game.round} · ${STATUS_TEXT[game.status] ?? game.status}`
      : STATUS_TEXT[game.status] ?? game.status;
  // Наверху — счёт раунда: за него идёт борьба на табло и из-за него объявляют в
  // розыск. Сквозной счёт нужен только на аукционе, поэтому висит мелко и лишь
  // тогда, когда отличается от раундового.
  $('top-score').textContent = me.score;
  $('top-total').textContent = `всего ${me.totalScore}`;
  $('top-total').classList.toggle('hidden', me.totalScore === me.score);

  $('target-nickname').textContent = me.target ? me.target.nickname : 'ждём начала игры';
  $('defense-points').textContent = `+${rules.defensePoints}`;

  $('my-emblem').innerHTML = me.emblem.svg;
  $('my-emblem-note').textContent = me.emblem.description;

  renderHints(me);
  renderAmmo(me, rules);
  renderLog(me);
  renderInbox(me.inbox);
  renderWanted(data);
  renderPeople(data.roster, me, data.wanted);
  renderDefense(me);
  renderBoard(data.board, me.nickname);
  renderSaloon(data, me.nickname);
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
  // Смена никнейма бывает только на новом раунде, и пропустить её нельзя:
  // под этим именем игрока объявят в розыск и о нём будут говорить в салуне.
  if (prev.me.nickname !== data.me.nickname) {
    if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 120]);
    toast(`Новый раунд: теперь вы «${data.me.nickname}»`, 9000);
  }
}

/**
 * Плакат розыска и смысл вкладки «Выстрел». Награду забирают из того же списка
 * имён, поэтому переключатель показываем только когда охота за наградой вообще
 * возможна: себя не выдать, а свою цель выгоднее брать по контракту.
 */
function renderWanted(data) {
  const wanted = data.wanted;
  const card = $('wanted-card');
  const seg = $('shoot-mode');

  if (!wanted) {
    card.classList.add('hidden');
    seg.classList.add('hidden');
    shootMode = 'contract';
    renderShootNote(data);
    return;
  }

  card.classList.remove('hidden');
  $('wanted-nickname').textContent = wanted.nickname;
  $('wanted-note').textContent = wanted.isMe
    ? `Разыскивают вас. Награда за вашу голову — ${wanted.bounty}, и стрелять в вас теперь может любой. Имя не объявлено: пока вас не вычислили, вы в безопасности.`
    : wanted.isMyTarget
      ? `Это ваша цель. Стреляйте по контракту — получите и очки за попадание, и награду ${wanted.bounty}.`
      : `Награда ${wanted.bounty} тому, кто первым назовёт, кто это. Стрелять может любой — ищите на вкладке «Выстрел».`;

  const canHunt = !wanted.isMe && !wanted.isMyTarget;
  seg.classList.toggle('hidden', !canHunt);
  if (!canHunt) shootMode = 'contract';
  renderShootNote(data);
}

function renderShootNote(data) {
  const { me, rules, wanted } = data;
  const bounty = shootMode === 'bounty' && wanted;

  $('shoot-mode')
    .querySelectorAll('.seg-btn')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === shootMode));

  // Штраф за промах ведущий может обнулить, и тогда про очки говорить нечего:
  // цена ошибки — потраченный патрон, а он приходит раз в час.
  const missCost = rules.missPenalty > 0 ? `промах <b>−${rules.missPenalty}</b>` : 'промах стоит только патрона';

  $('shoot-label').textContent = bounty ? 'Выстрел за награду' : 'Выстрел';
  $('shoot-note').innerHTML = bounty
    ? `Выберите человека, который, по-вашему, и есть <b>${esc(wanted.nickname)}</b>.
       Награда <b>+${wanted.bounty}</b>, ${missCost}.
       Промах здесь не мешает вашему контракту.`
    : `Выберите человека, который, по-вашему, и есть <b>${esc(me.target ? me.target.nickname : '—')}</b>.
       Попадание <b>+${rules.hitPoints}</b>, ${missCost}. Можно не стрелять и подождать подсказок.`;
}

function renderSaloon(data, myNickname) {
  const chat = data.chat ?? [];
  $('chat-list').innerHTML = chat.length
    ? chat
        .slice()
        .reverse()
        .map(
          (m) => `<li><span class="when">${clock(m.at)}</span>
            <span class="who ${m.nickname === myNickname ? 'me' : ''}">${esc(m.nickname)}</span>: ${esc(m.text)}</li>`
        )
        .join('')
    : '<li class="muted small">Пока тихо. Скажите что-нибудь первым.</li>';

  const pulse = data.pulse ?? [];
  $('pulse-list').innerHTML = pulse.length
    ? pulse.map((e) => `<li><span class="when">${clock(e.at)}</span> ${esc(e.text)}</li>`).join('')
    : '<li class="muted small">Пока ничего не произошло</li>';
}

const clock = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

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
  if (me.cooldownUntil > serverNow()) parts.push(`ствол остынет через ${countdown(me.cooldownUntil)}`);
  if (parts.length === 0) parts.push(`полный боезапас, +1 патрон каждые ${rules.ammoRegenMinutes} мин`);
  $('ammo-note').textContent = parts.join(', ');
}

function countdown(ts) {
  const total = Math.ceil(Math.max(0, ts - serverNow()) / 1000);
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
  const LABEL = { hit: 'попадание', miss: 'мимо', blocked: 'защита цели', bounty: 'награда за розыск' };
  list.innerHTML = me.log
    .map((entry) => {
      const extra =
        entry.result === 'hit' || entry.result === 'bounty' ? ` — это был ${esc(entry.targetNickname ?? '')}` : '';
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

function personRow(p, { extra = '', note = '', mark = '' } = {}) {
  const memo = p.note ? `<span class="memo">${esc(p.note)}</span>` : '';
  const label = extra ? `<span class="muted small">${esc(extra)}</span>` : '';
  return `<div class="person ${mark}" data-id="${p.id}" data-name="${esc(p.name)}" data-note="${esc(p.note ?? '')}">
    <button class="pick" ${extra ? 'disabled' : ''}>${esc(p.name)}${label}${memo}</button>
    <button class="jot ${p.note ? 'filled' : ''}" title="Заметка">✎</button>
  </div>`;
}

function renderPeople(roster, me, wanted) {
  const others = roster.filter((p) => p.id !== me.id);
  const bounty = shootMode === 'bounty' && wanted;
  const tried = bounty ? me.bountyAttempts ?? [] : me.attempts;

  $('list-shoot').innerHTML = others
    .map((p) =>
      personRow(p, {
        extra: tried.includes(p.id) ? 'уже стреляли' : '',
        mark: tried.includes(p.id) ? 'tried' : '',
      })
    )
    .join('');

  $('list-defense').innerHTML = others
    .map((p) =>
      personRow(p, {
        extra: me.defense.guardId === p.id ? 'защита стоит здесь' : '',
        mark: me.defense.guardId === p.id ? 'guarded' : '',
      })
    )
    .join('');

  applySearch('shoot');
  applySearch('defense');
}

/** Ищем и по имени, и по заметке: пометив «алый круг», человек находит потом всех таких. */
function applySearch(kind) {
  const query = $(`search-${kind}`).value.trim().toLowerCase();
  $(`list-${kind}`)
    .querySelectorAll('.person')
    .forEach((row) => {
      const haystack = `${row.dataset.name} ${row.dataset.note}`.toLowerCase();
      row.classList.toggle('hidden', Boolean(query) && !haystack.includes(query));
    });
}

['shoot', 'defense'].forEach((kind) => {
  $(`search-${kind}`).addEventListener('input', () => applySearch(kind));
});

function renderDefense(me) {
  const parts = [];
  parts.push(
    me.defense.guardName
      ? `Защита стоит на: ${me.defense.guardName}. Менять можно в любой момент.`
      : 'Защита не поставлена: любой выстрел по вам пройдёт.'
  );
  if (me.defense.blocked) parts.push(`Охотников остановлено: ${me.defense.blocked}.`);
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

/** Заметка о человеке: короткая строка, по ней же потом работает поиск. */
function askNote(row) {
  askConfirm(
    `<div class="card-label">Заметка</div>
     <p class="center big-name">${esc(row.dataset.name)}</p>
     <p class="muted small center">Что вы про него запомнили — например, приметы эмблемы.
     Заметку видите только вы. Пустая строка стирает.</p>
     <label class="field" style="margin-top:12px">
       <input id="note-input" maxlength="40" value="${esc(row.dataset.note)}" placeholder="алый круг, внутри крест" />
     </label>`,
    async () => {
      try {
        const res = await api('/api/note', {
          method: 'POST',
          body: { playerId: row.dataset.id, text: $('note-input')?.value ?? '' },
        });
        apply(res.state);
      } catch (err) {
        toast(err.message, 4000);
      }
    }
  );
  setTimeout(() => $('note-input')?.focus(), 50);
}

$('list-shoot').addEventListener('click', (event) => {
  const row = event.target.closest('.person');
  if (!row || !snapshot) return;
  if (event.target.closest('.jot')) return askNote(row);
  if (event.target.closest('.pick')?.disabled) return;

  const wanted = snapshot.wanted;
  const bounty = shootMode === 'bounty' && wanted;
  if (!bounty && !snapshot.me.target) return toast('Контракт ещё не выдан');
  if (snapshot.me.ammo < 1) return toast('Патронов нет, ждите перезарядки');

  const claim = bounty ? wanted.nickname : snapshot.me.target.nickname;
  askConfirm(
    `<div class="card-label">${bounty ? 'Выстрел за награду' : 'Подтвердите выстрел'}</div>
     <p class="center big-name">${esc(row.dataset.name)}</p>
     <p class="center">Вы заявляете, что это <b>${esc(claim)}</b></p>
     <p class="muted small center">${
       snapshot.rules.missPenalty > 0
         ? `${bounty ? `Угадали — награда ${wanted.bounty}. ` : ''}Промах стоит ${snapshot.rules.missPenalty} очков и патрон.`
         : `${bounty ? `Угадали — награда ${wanted.bounty}. ` : ''}Промах стоит патрона.`
     }</p>`,
    async () => {
      try {
        const res = await api('/api/shoot', {
          method: 'POST',
          body: { playerId: row.dataset.id, bounty },
        });
        apply(res.state);
        showShotFlash(res, row.dataset.name);
      } catch (err) {
        toast(err.message, 4000);
        refresh();
      }
    }
  );
});

$('list-defense').addEventListener('click', (event) => {
  const row = event.target.closest('.person');
  if (!row || !snapshot) return;
  if (event.target.closest('.jot')) return askNote(row);
  if (event.target.closest('.pick')?.disabled) return;

  askConfirm(
    `<div class="card-label">Выставить защиту</div>
     <p class="center big-name">${esc(row.dataset.name)}</p>
     <p class="center">Вы считаете, что этот человек охотится на вас.</p>
     <p class="muted small center">Ставку можно менять когда угодно, но действует только одна.
     Правильность не покажут — узнаете, если он выстрелит.</p>`,
    async () => {
      try {
        const res = await api('/api/defend', { method: 'POST', body: { playerId: row.dataset.id } });
        if (res.state) apply(res.state);
        showDefenseFlash(res);
      } catch (err) {
        toast(err.message, 4000);
        refresh();
      }
    }
  );
});

$('shoot-mode').addEventListener('click', (event) => {
  const btn = event.target.closest('.seg-btn');
  if (!btn || !snapshot) return;
  shootMode = btn.dataset.mode;
  renderShootNote(snapshot);
  renderPeople(snapshot.roster, snapshot.me, snapshot.wanted);
});

async function sayInChat() {
  const text = $('input-chat').value.trim();
  if (!text) return;
  try {
    const res = await api('/api/chat', { method: 'POST', body: { text } });
    $('input-chat').value = '';
    apply(res.state);
  } catch (err) {
    toast(err.message, 4000);
  }
}

$('btn-chat').addEventListener('click', sayInChat);
$('input-chat').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sayInChat();
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
  if (navigator.vibrate) navigator.vibrate(res.result === 'miss' ? 200 : [60, 40, 120]);
  if (res.result === 'bounty') {
    flash(
      `<div class="flash-title hit">НАГРАДА ВАША</div>
       <div class="flash-sub">${esc(name)} и есть ${esc(res.victimNickname)}. +${res.points} очков.<br />
       Ваш контракт не тронут — цель осталась прежней.</div>`,
      4600
    );
  } else if (res.result === 'hit') {
    flash(
      `<div class="flash-title hit">ПОПАДАНИЕ</div>
       <div class="flash-sub">${esc(name)} и есть ${esc(res.victimNickname)}. ${res.points > 0 ? '+' : ''}${res.points} очков${
         res.bounty ? `, включая награду ${res.bounty} за розыск` : ''
       }.<br />
       Новая цель: <b>${esc(res.newTargetNickname ?? '—')}</b></div>`,
      4600
    );
  } else if (res.result === 'blocked') {
    flash(
      `<div class="flash-title blocked">ЗАЩИТА</div>
       <div class="flash-sub">${esc(name)} ждал именно вас. Опознали верно, но контракт провален.<br />
       Новая цель: <b>${esc(res.newTargetNickname ?? '—')}</b></div>`,
      4600
    );
  } else {
    flash(
      `<div class="flash-title miss">МИМО</div>
       <div class="flash-sub">Это не ваша цель. ${res.points < 0 ? `${res.points} очков, патрон` : 'Патрон'} потрачен.</div>`,
      2600
    );
  }
}

// Правильность ставки не сообщается — иначе можно было бы перебирать людей и
// получать информацию бесплатно. Игрок узнаёт ответ только выстрелом по нему.
function showDefenseFlash(res) {
  flash(
    `<div class="flash-title">ЗАЩИТА ПОСТАВЛЕНА</div>
     <div class="flash-sub">Ждём ${esc(res.suspectName)}. Если он и правда охотится на вас и выстрелит —
     выстрел не пройдёт, а контракт с вас снимут.<br />Угадали или нет, вы поймёте только тогда.</div>`,
    4600
  );
}

$('flash').addEventListener('click', () => $('flash').classList.add('hidden'));

/**
 * Выход из кабинета. Нужен из-за входа по PIN: зайдя со своего имени с чужого
 * телефона, человек занимает браузер владельца — токен в этом браузере один.
 * Без кнопки владелец оказался бы заперт в чужом кабинете, потому что экран
 * входа показывается только когда токена нет.
 */
$('btn-logout').addEventListener('click', () => {
  askConfirm(
    `<div class="card-label">Выйти из кабинета</div>
     <p class="center">Этот телефон забудет вас.</p>
     <p class="muted small center">Вернуться можно по имени и PIN. Очки, цель и подсказки останутся на месте —
     они хранятся на сервере, а не в телефоне.</p>`,
    async () => {
      clearInterval(pollTimer);
      localStorage.removeItem(TOKEN_KEY);
      location.href = '/';
    }
  );
});

// --- Табло и вкладки ----------------------------------------------------------

/**
 * На табло только никнейм и очки раунда. Попаданий и промахов здесь нет
 * намеренно: они не обнуляются со сменой раунда, и по ним, как и по сквозному
 * счёту, можно было бы сопоставить прежний никнейм с новым. Своя статистика
 * лежит у игрока на главной.
 */
function renderBoard(rows, myNickname) {
  $('board-list').innerHTML = rows
    .map(
      (r) => `<li class="${r.nickname === myNickname ? 'me' : ''}">
        <span>${esc(r.nickname)}</span>
        <span class="pts">${r.score}</span>
      </li>`
    )
    .join('');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    ['home', 'shoot', 'defense', 'saloon', 'board'].forEach((view) => {
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
