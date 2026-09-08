const $ = (id) => document.getElementById(id);
const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = new URLSearchParams(location.search).get('token') || localStorage.getItem('hh_admin') || '';
let data = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(payload.error || 'Ошибка'), { status: res.status });
  return payload;
}

function toast(text, ms = 2800) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

const STATUS_TEXT = { lobby: 'лобби', running: 'идёт', paused: 'пауза', finished: 'финал' };

async function refresh() {
  try {
    data = await api('/api/admin/state');
    render();
  } catch (err) {
    if (err.status === 401) showAuth();
    else toast(err.message);
  }
}

function showAuth() {
  $('auth').classList.remove('hidden');
  $('panel').classList.add('hidden');
}

$('token-save').addEventListener('click', async () => {
  token = $('token-input').value.trim();
  localStorage.setItem('hh_admin', token);
  $('auth').classList.add('hidden');
  await refresh();
  loadQr();
});

function render() {
  $('auth').classList.add('hidden');
  $('panel').classList.remove('hidden');
  const round = data.game.round ?? 0;
  $('status-line').textContent = `Игра: ${STATUS_TEXT[data.game.status] ?? data.game.status}${
    round > 0 ? ` · раунд ${round}` : ''
  } · игроков ${data.players.length}`;
  $('print-link').href = `/print?token=${encodeURIComponent(token)}`;
  $('print-free-link').href = `/print?free=1&token=${encodeURIComponent(token)}`;
  $('board-link').href = `/board?token=${encodeURIComponent(token)}`;
  $('board-final-link').href = `/board?final=1&token=${encodeURIComponent(token)}`;

  const { slots, issued, reserved, free, shots, registered } = data.stats;
  $('stats').innerHTML = [
    ['Зарегистрировано', registered],
    ['В игре с бейджем', issued],
    ['Ждут выдачи', reserved],
    ['Бейджей свободно', free],
    ['Выстрелов', shots],
    ['Бейджей всего', slots],
  ]
    .map(([label, value]) => `<div class="stat"><b>${value}</b><span class="muted small">${label}</span></div>`)
    .join('');

  renderPending();

  $('players-count').textContent = `(${data.players.length})`;
  $('players').innerHTML = data.players
    .map((p) => {
      const stale = Date.now() - p.lastSeenAt > 30 * 60_000;
      return `<tr>
        <td>${p.emblemSvg ?? '<span class="no-badge">—</span>'}</td>
        <td>${esc(p.name)}<br /><span class="muted small">${
        p.hasBadge ? esc(p.emblemDescription) : 'ждёт выдачи бейджа'
      }</span></td>
        <td>${esc(p.nickname)}<br /><span class="muted small ${stale || p.loginBlockedUntil ? 'offline' : ''}">${
        p.loginBlockedUntil ? 'вход заблокирован' : stale ? 'давно не заходил' : 'на связи'
      }</span></td>
        <td>${esc(p.targetName ?? '—')}<br /><span class="muted small">охотников: ${p.hunters}${
        p.guardName ? ` · ждёт ${esc(p.guardName)}` : ''
      }</span></td>
        <td><b>${p.roundScore}</b><br /><span class="muted small">всего ${p.score}</span></td>
        <td class="muted">${p.hits}/${p.misses} · ${p.ammo} патр.</td>
        <td class="muted">${p.hints}</td>
        <td>
          <button class="mini-btn" data-score="${p.id}" data-delta="1000">+1000</button>
          <button class="mini-btn" data-score="${p.id}" data-delta="-1000">−1000</button>
          <button class="mini-btn" data-score-ask="${p.id}">±</button>
          <button class="mini-btn" data-hint="${p.id}">подсказка</button>
          <button class="mini-btn" data-retarget="${p.id}">цель</button>
          <button class="mini-btn" data-pin="${p.id}">PIN</button>
          <button class="mini-btn" data-remove="${p.id}">✕</button>
        </td>
      </tr>`;
    })
    .join('');

  $('codes-list').innerHTML = data.codes
    .map(
      (c) => `<span class="code-chip ${c.used >= c.maxUses ? 'spent' : ''}" title="${esc(c.note)}">
        <b>${esc(c.code)}</b> ${c.grantsHint ? '· подсказка' : ''}${c.points ? ` · ${c.points} оч.` : ''} · ${c.used}/${c.maxUses}
      </span>`
    )
    .join('');

  renderWanted();
  renderChat();

  $('events').innerHTML = data.events
    .map((e) => `<div>${new Date(e.at).toLocaleTimeString('ru-RU')} · ${esc(describeEvent(e))}</div>`)
    .join('');

  if (!$('cfg').dataset.filled) renderConfig();
}

/** Розыск ведущий объявляет голосом, поэтому здесь и никнейм для объявления, и имя для себя. */
function renderWanted() {
  const box = $('wanted-box');
  if (data.wanted) {
    box.innerHTML = `<div class="wanted-live">Разыскивается <b>«${esc(data.wanted.nickname)}»</b>,
      награда ${data.wanted.bounty}</div>
      <div class="muted small">это ${esc(data.wanted.name)} · объявлено в ${new Date(
      data.wanted.since
    ).toLocaleTimeString('ru-RU')} · стрелять по нему может любой</div>`;
    return;
  }
  const pause = data.wantedPauseUntil;
  box.innerHTML = pause
    ? `<span class="muted">Пауза после награды до ${new Date(pause).toLocaleTimeString('ru-RU')}</span>`
    : '<span class="muted">Никого: в табло раунда нет единственного лидера</span>';
}

function renderChat() {
  const list = data.chat ?? [];
  $('chat-count').textContent = list.length ? `(${list.length})` : '';
  $('chat-mod').innerHTML = list.length
    ? list
        .slice()
        .reverse()
        .map(
          (m) => `<div class="msg">
            <div><span class="who">${esc(m.nickname)}</span> <span class="real">(${esc(m.name)})</span><br />${esc(m.text)}</div>
            <button class="mini-btn" data-chat-del="${m.id}">✕</button>
          </div>`
        )
        .join('')
    : '<div class="muted small">В салуне тихо</div>';
}

$('chat-mod').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-chat-del]');
  if (!btn) return;
  try {
    data = await api(`/api/admin/chat/${btn.dataset.chatDel}`, { method: 'DELETE' });
    render();
    toast('Сообщение удалено');
  } catch (err) {
    toast(err.message, 5000);
  }
});

/**
 * Очередь на выдачу. Ведущий сверяет эмблему на экране с бейджем в руках; код
 * подставлен, но его можно исправить, если в руки лёг другой бейдж.
 */
function renderPending() {
  const list = data.pending ?? [];
  $('pending-count').textContent = list.length ? `(${list.length})` : '';
  // Пульт сам обновляется раз в пять секунд — не затираем код, который печатают.
  if ($('pending-list').contains(document.activeElement)) return;
  if (list.length === 0) {
    $('pending-list').innerHTML = '<div class="muted small">Никто не ждёт. Все зарегистрированные получили бейджи.</div>';
    return;
  }

  $('pending-list').innerHTML = list
    .map((p) => {
      const mins = Math.floor((Date.now() - p.since) / 60_000);
      const waiting = mins < 1 ? 'только что' : `${mins} мин назад`;
      return `<div class="pend">
        <div>${p.emblemSvg ?? '<span class="no-badge">нет бейджей</span>'}</div>
        <div>
          <b>${esc(p.name)}</b><br />
          <span class="muted small">«${esc(p.nickname)}» · ${esc(p.emblemDescription ?? '')} · ${waiting}</span>
        </div>
        <div><input class="code-input" data-code-for="${p.id}" value="${esc(p.code ?? '')}" /></div>
        <div class="acts">
          <button class="btn primary" data-issue="${p.id}">Выдал</button>
          <button class="btn ghost" data-reassign="${p.id}">Другой</button>
        </div>
      </div>`;
    })
    .join('');
}

$('pending-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.issue) {
      const code = document.querySelector(`[data-code-for="${btn.dataset.issue}"]`)?.value.trim();
      data = await api(`/api/admin/player/${btn.dataset.issue}/badge`, { method: 'POST', body: { code } });
      toast(`Бейдж ${data.code} выдан`);
    } else if (btn.dataset.reassign) {
      data = await api(`/api/admin/player/${btn.dataset.reassign}/badge/reassign`, { method: 'POST' });
      toast(`Новая эмблема, код ${data.code}`, 5000);
    }
    render();
  } catch (err) {
    toast(err.message, 5000);
  }
});

function describeEvent(e) {
  switch (e.type) {
    case 'player_registered': return `${e.name} зарегистрировался как «${e.nickname}», бейдж ${e.code}`;
    case 'badge_issued': return `${e.name} получил бейдж ${e.code}`;
    case 'badge_reassigned': return `${e.name} переведён на другой бейдж ${e.code}`;
    case 'player_inserted': return `новый участник встроен в цепочку (контракт «${e.hostNickname}» изменён)`;
    case 'hit': return `${e.nickname} вычислил ${e.victimNickname} (+${e.points})`;
    case 'miss': return `${e.nickname} промахнулся (−${e.penalty})`;
    case 'blocked': return `${e.victimNickname} ждал ${e.nickname} и остановил его (+${e.points}), контракт снят`;
    case 'guard_set': return `${e.nickname} поставил защиту`;
    case 'wanted_declared': return `объявлен розыск: «${e.nickname}», награда ${e.bounty}`;
    case 'wanted_cleared': return `розыск снят (${WANTED_CLEAR_REASON[e.reason] ?? e.reason})`;
    case 'bounty_claimed': return `${e.nickname} забрал награду за «${e.victimNickname}» (+${e.points})`;
    case 'bounty_miss': return `${e.nickname} промахнулся в охоте за наградой (−${e.penalty})`;
    case 'chat_removed': return `сообщение «${e.nickname}» удалено из салуна`;
    case 'code_redeemed': return `${e.nickname} ввёл код ${e.code}`;
    case 'codes_created': return `выпущено кодов: ${e.count}`;
    case 'hint_granted': return `${e.nickname} получил подсказку от ведущего`;
    case 'game_started':
      return (e.round ?? 1) > 1
        ? `раунд ${e.round} начался, никнеймы перетасованы, игроков: ${e.players}`
        : `игра началась, игроков: ${e.players}`;
    case 'game_status': return `статус игры: ${STATUS_TEXT[e.status] ?? e.status}`;
    case 'slots_created': return e.append ? `добавлено бейджей: ${e.count}` : `создано бейджей: ${e.count}`;
    case 'targets_reshuffled': return 'цели перераспределены';
    case 'score_adjusted': return `${e.nickname}: ${e.delta > 0 ? '+' : ''}${e.delta} очков (${e.reason})`;
    case 'player_removed': return `${e.nickname} удалён из игры`;
    case 'login_ok': return `${e.name} вошёл по PIN`;
    case 'login_failed': return `неверный PIN для ${e.name} (осталось попыток: ${e.left})`;
    case 'login_blocked': return `вход для ${e.name} заблокирован на 5 минут: слишком много попыток`;
    case 'pin_reset': return `${e.name} получил новый PIN от ведущего`;
    default: return e.type;
  }
}

const WANTED_CLEAR_REASON = {
  game_stopped: 'игра не идёт',
  pause: 'пауза после награды',
  no_leader: 'нет единственного лидера',
};

const CONFIG_LABELS = {
  eventTitle: 'Название игры',
  hitPoints: 'Очков за попадание',
  missPenalty: 'Штраф за промах',
  defensePoints: 'Очков за сработавшую защиту',
  bountyPoints: 'Награда за розыск',
  bountyHoldMinutes: 'Розыск держится не меньше, мин',
  bountyPauseMinutes: 'Пауза розыска после награды, мин',
  ammoStart: 'Патронов на старте',
  ammoMax: 'Максимум патронов',
  ammoRegenMinutes: 'Минут на патрон',
  shotCooldownSeconds: 'Пауза между выстрелами, с',
  wifiSsid: 'Wi-Fi (для листа бейджей)',
  wifiPassword: 'Пароль Wi-Fi',
};

function renderConfig() {
  $('cfg').innerHTML = Object.entries(CONFIG_LABELS)
    .map(
      ([key, label]) =>
        `<label class="muted">${label}</label><input data-cfg="${key}" value="${esc(data.config[key] ?? '')}" />`
    )
    .join('');
  $('cfg').dataset.filled = '1';
}

$('btn-cfg').addEventListener('click', async () => {
  const patch = {};
  document.querySelectorAll('[data-cfg]').forEach((input) => {
    patch[input.dataset.cfg] = input.value;
  });
  await api('/api/admin/config', { method: 'PATCH', body: patch });
  toast('Настройки сохранены');
  refresh();
});

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    // Второй и следующие старты — это новый раунд с перетасовкой никнеймов:
    // ведущий должен понимать, что стирает салун и журналы участников.
    if (btn.dataset.action === 'start' && (data?.game?.round ?? 0) > 0) {
      const next = (data.game.round ?? 0) + 1;
      const ok = confirm(
        `Начать раунд ${next}? Никнеймы перетасуются между участниками, цели раздадутся заново, ` +
          `салун и журналы выстрелов очистятся. Очки, попадания и заметки останутся.`
      );
      if (!ok) return;
    }
    try {
      data = await api(`/api/admin/game/${btn.dataset.action}`, { method: 'POST' });
      render();
      toast('Готово');
    } catch (err) {
      toast(err.message);
    }
  });
});

$('btn-slots').addEventListener('click', async () => {
  const count = Number($('slot-count').value);
  if (!confirm(`Создать ${count} бейджей? Прошлый набор будет заменён.`)) return;
  try {
    await api('/api/admin/slots', { method: 'POST', body: { count } });
    toast('Бейджи готовы, откройте лист печати');
    refresh();
  } catch (err) {
    toast(err.message, 4000);
  }
});

$('btn-slots-add').addEventListener('click', async () => {
  const count = Number($('slot-count').value);
  try {
    const res = await api('/api/admin/slots', { method: 'POST', body: { count, append: true } });
    toast(`Добавлено бейджей: ${res.count}. Распечатайте только невыданные.`, 6000);
    refresh();
  } catch (err) {
    toast(err.message, 5000);
  }
});

$('btn-codes').addEventListener('click', async () => {
  try {
    const res = await api('/api/admin/codes', {
      method: 'POST',
      body: {
        count: Number($('code-count').value),
        points: Number($('code-points').value),
        maxUses: Number($('code-uses').value),
        grantsHint: $('code-hint').checked,
        note: $('code-note').value,
      },
    });
    data = res;
    render();
    toast(`Коды готовы: ${res.created.join(', ')}`, 8000);
  } catch (err) {
    toast(err.message, 4000);
  }
});

$('btn-reset').addEventListener('click', async () => {
  if (
    prompt(
      'Это удалит игроков, очки и бейджи: коды на напечатанных бейджах станут чужими. ' +
        'Копия игры останется в папке data. Введите RESET для подтверждения'
    ) !== 'RESET'
  ) {
    return;
  }
  await api('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' } });
  $('cfg').dataset.filled = '';
  toast('Игра сброшена');
  refresh();
});

$('players').addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.score) {
      data = await api(`/api/admin/player/${btn.dataset.score}/score`, {
        method: 'POST',
        body: { delta: Number(btn.dataset.delta), reason: 'активность' },
      });
    } else if (btn.dataset.scoreAsk) {
      // Лоты аукциона стоят произвольные суммы, а списывать их приходится
      // здесь же: кнопок на все случаи не наделать.
      const raw = prompt('Сколько очков начислить? Со знаком минус — списать.', '1000');
      if (raw === null) return;
      const delta = Number(raw.replace(',', '.').trim());
      if (!Number.isFinite(delta) || delta === 0) return toast('Нужно число, например 2500 или −500');
      const reason = prompt('За что? Попадёт в журнал.', 'аукцион') ?? 'вручную';
      data = await api(`/api/admin/player/${btn.dataset.scoreAsk}/score`, {
        method: 'POST',
        body: { delta, reason },
      });
      toast(`${delta > 0 ? '+' : ''}${delta} очков записано`);
    } else if (btn.dataset.hint) {
      const res = await api(`/api/admin/player/${btn.dataset.hint}/hint`, { method: 'POST' });
      data = res;
      toast(`Выдана подсказка: ${res.hint.text}`, 6000);
    } else if (btn.dataset.retarget) {
      data = await api(`/api/admin/player/${btn.dataset.retarget}/retarget`, { method: 'POST' });
    } else if (btn.dataset.pin) {
      if (!confirm('Выдать игроку новый PIN? Прежний перестанет работать.')) return;
      const res = await api(`/api/admin/player/${btn.dataset.pin}/pin/reset`, { method: 'POST' });
      data = res;
      // PIN нужно назвать игроку голосом, поэтому висит на экране дольше обычного.
      toast(`Новый PIN: ${res.pin} — назовите его игроку`, 20000);
    } else if (btn.dataset.remove) {
      if (!confirm('Удалить игрока из игры?')) return;
      data = await api(`/api/admin/player/${btn.dataset.remove}`, { method: 'DELETE' });
    }
    render();
  } catch (err) {
    toast(err.message);
  }
});

async function loadQr() {
  try {
    const qr = await api('/api/admin/join-qr');
    $('qr').src = qr.dataUrl;
    // Адаптеров у ноутбука обычно несколько, а QR ведёт только на один адрес.
    // Подписываем каждый адрес адаптером: иначе не понять, какая это сеть.
    const lines = (qr.interfaces ?? []).map((i) => `${esc(i.address)} — ${esc(i.name)}`);
    const warning =
      lines.length > 1 ? '<br />QR ведёт на первый адрес. Телефоны должны быть в той же сети.' : '';
    $('join-url').innerHTML = `${esc(qr.url)}<br />Адреса ноутбука:<br />${
      lines.join('<br />') || 'нет сети'
    }${warning}`;
  } catch {}
}

if (!token) {
  showAuth();
} else {
  refresh();
  loadQr();
  setInterval(refresh, 5000);
}
