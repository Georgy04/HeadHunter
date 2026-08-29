import crypto from 'node:crypto';
import { state, save, logEvent, newId, newJoinCode } from './store.js';
import { generateEmblemSet, renderEmblem, describeEmblem, hintText, newHintOrder, shuffle } from './emblems.js';

export class GameError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const players = () => Object.values(state.players);
/** В игре участвуют только те, кто получил бейдж: без эмблемы игрока не опознать. */
export const activePlayers = () => players().filter((p) => p.slotId);
export const slotById = (id) => state.slots.find((s) => s.id === id) ?? null;
export const slotByCode = (code) => state.slots.find((s) => s.code === String(code ?? '').toUpperCase().trim()) ?? null;
export const playerByToken = (token) => players().find((p) => p.token === token) ?? null;

const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

// --- Регистрация -------------------------------------------------------------

function validateName(name, exceptId) {
  const value = norm(name).slice(0, 40);
  if (value.length < 2) throw new GameError('Имя должно быть хотя бы из двух символов');
  const lower = value.toLowerCase();
  // Имена видны всем в списке для выстрела, поэтому двух одинаковых быть не должно.
  if (players().some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)) {
    throw new GameError('Участник с таким именем уже есть. Добавьте фамилию или прозвище.', 409, 'name_taken');
  }
  return value;
}

function validateNickname(nickname, exceptId) {
  const value = norm(nickname).slice(0, 24);
  if (value.length < 2) throw new GameError('Никнейм должен быть хотя бы из двух символов');
  const lower = value.toLowerCase();
  if (players().some((p) => p.id !== exceptId && p.nickname.toLowerCase() === lower)) {
    throw new GameError('Такой никнейм уже занят, придумайте другой', 409, 'nickname_taken');
  }
  if (players().some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)) {
    throw new GameError('Никнейм совпадает с именем участника, придумайте другой', 409, 'nickname_taken');
  }
  return value;
}

// PIN нужен не против взлома, а чтобы игрок мог вернуться в свой кабинет с другого
// телефона: токен живёт в одном браузере и теряется вместе с ним. Имена участников
// публичны, поэтому подбор ограничен счётчиком попыток.
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK_MINUTES = 5;

function weakPin(value) {
  if (/^(\d)\1{3}$/.test(value)) return true;
  const digits = [...value].map(Number);
  const step = digits[1] - digits[0];
  return (step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step);
}

function validatePin(pin) {
  const value = String(pin ?? '').trim();
  if (!/^\d{4}$/.test(value)) throw new GameError('PIN — это четыре цифры', 400, 'bad_pin');
  if (weakPin(value)) throw new GameError('Такой PIN угадают с первой попытки, придумайте другой', 400, 'weak_pin');
  return value;
}

function setPin(player, pin) {
  const salt = crypto.randomBytes(16);
  player.pinSalt = salt.toString('hex');
  player.pinHash = crypto.scryptSync(pin, salt, 32).toString('hex');
  player.loginFails = 0;
  player.loginBlockedUntil = 0;
}

function pinMatches(player, pin) {
  if (!player.pinHash || !player.pinSalt) return false;
  const expected = Buffer.from(player.pinHash, 'hex');
  const actual = crypto.scryptSync(String(pin ?? ''), Buffer.from(player.pinSalt, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const freeSlot = (exceptId = null) =>
  state.slots.find((s) => !s.claimedBy && !s.reservedBy && s.id !== exceptId) ?? null;

/**
 * Эмблему выбирает сервер сразу при регистрации и показывает игроку: с этим
 * экраном человек идёт к ведущему и получает свой бейдж. Бейдж не выдан —
 * игрока в игре нет: его нельзя опознать, назначить целью и он не может стрелять.
 */
export function registerPlayer(name, nickname, pin) {
  const cleanName = validateName(name);
  const cleanNickname = validateNickname(nickname);
  const cleanPin = validatePin(pin);
  if (cleanName.toLowerCase() === cleanNickname.toLowerCase()) {
    throw new GameError('Никнейм не должен совпадать с вашим именем — иначе вас вычислят за минуту');
  }

  const slot = freeSlot();
  if (!slot) {
    throw new GameError('Свободных бейджей нет — попросите ведущего выпустить ещё', 409, 'no_slots');
  }

  const player = {
    id: newId(8),
    token: newId(16),
    name: cleanName,
    nickname: cleanNickname,
    slotId: null,
    reservedSlotId: slot.id,
    score: 0,
    hits: 0,
    misses: 0,
    targetId: null,
    attempts: [],
    hintOrder: [],
    hints: [],
    ammo: state.config.ammoStart,
    ammoRegenAt: Date.now(),
    cooldownUntil: 0,
    shieldAgainst: null,
    identifiedHunters: [],
    lastDefenseAt: 0,
    usedCodes: [],
    inbox: [],
    log: [],
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  setPin(player, cleanPin);

  state.players[player.id] = player;
  slot.reservedBy = player.id;
  logEvent('player_registered', { playerId: player.id, name: cleanName, nickname: cleanNickname, code: slot.code });
  save();
  return player;
}

/**
 * Возврат в свой кабинет с другого телефона или после очистки браузера.
 * Имя не тайна, поэтому единственная преграда — PIN, и попытки ограничены.
 */
export function loginWithPin(name, pin) {
  const wanted = norm(name).toLowerCase();
  const player = players().find((p) => p.name.toLowerCase() === wanted);
  if (!player) throw new GameError('Участника с таким именем нет', 404, 'no_player');
  if (!player.pinHash) throw new GameError('У этого участника нет PIN — подойдите к ведущему', 409, 'no_pin');

  const now = Date.now();
  const blockLeft = Math.ceil(((player.loginBlockedUntil ?? 0) - now) / 60000);
  if (blockLeft > 0) {
    throw new GameError(`Слишком много попыток. Ещё ${blockLeft} мин или подойдите к ведущему`, 429, 'locked');
  }

  if (!pinMatches(player, pin)) {
    player.loginFails = (player.loginFails ?? 0) + 1;
    if (player.loginFails >= LOGIN_MAX_FAILS) {
      player.loginFails = 0;
      player.loginBlockedUntil = now + LOGIN_BLOCK_MINUTES * 60_000;
      logEvent('login_blocked', { playerId: player.id, name: player.name });
      save();
      throw new GameError(
        `Слишком много попыток. Ещё ${LOGIN_BLOCK_MINUTES} мин или подойдите к ведущему`,
        429,
        'locked'
      );
    }
    const left = LOGIN_MAX_FAILS - player.loginFails;
    logEvent('login_failed', { playerId: player.id, name: player.name, left });
    save();
    throw new GameError(`PIN не подходит. Осталось попыток: ${left}`, 401, 'bad_pin');
  }

  player.loginFails = 0;
  player.loginBlockedUntil = 0;
  player.lastSeenAt = now;
  logEvent('login_ok', { playerId: player.id, name: player.name });
  save();
  return player;
}

/**
 * Забытый PIN. Ведущий видит человека с бейджем, поэтому просто выдаёт новый:
 * это то же личное подтверждение, на котором держится выдача бейджей.
 */
export function resetPin(playerId) {
  const player = state.players[playerId];
  if (!player) throw new GameError('Игрок не найден', 404);
  let pin;
  do {
    pin = String(crypto.randomInt(1000, 10000));
  } while (weakPin(pin));
  setPin(player, pin);
  logEvent('pin_reset', { playerId: player.id, name: player.name });
  save();
  return pin;
}

/**
 * Ведущий отдал физический бейдж и подтвердил это в пульте — только теперь
 * человек становится полноценным игроком. Код можно передать явно: если ведущий
 * выдал не зарезервированный бейдж, а другой, запись подстраивается под реальность.
 */
export function issueBadge(playerId, code) {
  const player = state.players[playerId];
  if (!player) throw new GameError('Игрок не найден', 404);
  if (player.slotId) throw new GameError('Бейдж этому игроку уже выдан', 409, 'has_badge');

  const reserved = slotById(player.reservedSlotId);
  const slot = code ? slotByCode(code) : reserved;
  if (!slot) throw new GameError('Такого бейджа нет. Проверьте код.', 404, 'no_slot');
  if (slot.claimedBy) {
    const owner = state.players[slot.claimedBy];
    throw new GameError(`Этот бейдж уже выдан${owner ? `: ${owner.name}` : ''}`, 409, 'slot_taken');
  }
  if (slot.reservedBy && slot.reservedBy !== player.id) {
    const other = state.players[slot.reservedBy];
    throw new GameError(
      `Этот бейдж зарезервирован за другим игроком${other ? `: ${other.name}` : ''}`,
      409,
      'slot_reserved'
    );
  }

  if (reserved && reserved.id !== slot.id) reserved.reservedBy = null;
  slot.reservedBy = null;
  slot.claimedBy = player.id;
  player.slotId = slot.id;
  player.reservedSlotId = null;
  // Отсчёт патронов начинается с момента входа в игру, а не с регистрации:
  // иначе тот, кто зарегистрировался и ушёл, вернулся бы с полным магазином.
  player.ammo = state.config.ammoStart;
  player.ammoRegenAt = Date.now();
  logEvent('badge_issued', { playerId: player.id, name: player.name, code: slot.code });

  if (state.game.status === 'running') insertIntoChain(player);
  save();
  return slot;
}

/** Зарезервированный бейдж потерялся или испорчен — выдаём другую эмблему. */
export function reassignBadge(playerId) {
  const player = state.players[playerId];
  if (!player) throw new GameError('Игрок не найден', 404);
  if (player.slotId) throw new GameError('Бейдж уже выдан, менять нечего', 409, 'has_badge');

  const current = slotById(player.reservedSlotId);
  const next = freeSlot(current?.id ?? null);
  if (!next) throw new GameError('Других свободных бейджей нет — выпустите ещё', 409, 'no_slots');

  if (current) current.reservedBy = null;
  next.reservedBy = player.id;
  player.reservedSlotId = next.id;
  logEvent('badge_reassigned', { playerId: player.id, name: player.name, code: next.code });
  save();
  return next;
}

// --- Контракты ---------------------------------------------------------------

function hunterCounts() {
  const counts = new Map(activePlayers().map((p) => [p.id, 0]));
  activePlayers().forEach((p) => {
    if (p.targetId && counts.has(p.targetId)) counts.set(p.targetId, counts.get(p.targetId) + 1);
  });
  return counts;
}

export const huntersOf = (playerId) => activePlayers().filter((p) => p.targetId === playerId);

function setTarget(player, targetId) {
  player.targetId = targetId;
  player.attempts = [];
  player.hints = [];
  player.hintOrder = newHintOrder();
}

/**
 * Новый контракт после попадания. Цель выбирается среди наименее преследуемых,
 * чтобы охотники распределялись равномерно и никто не остался без преследователя.
 */
export function assignTarget(player) {
  const counts = hunterCounts();
  const candidates = activePlayers().filter((p) => p.id !== player.id && p.id !== player.targetId);
  if (candidates.length === 0) {
    setTarget(player, null);
    save();
    return null;
  }
  const fewest = Math.min(...candidates.map((p) => counts.get(p.id) ?? 0));
  const pool = candidates.filter((p) => (counts.get(p.id) ?? 0) === fewest);
  setTarget(player, pool[Math.floor(Math.random() * pool.length)].id);
  save();
  return player.targetId;
}

/**
 * Поздний участник встраивается в цепочку: он берёт контракт того, кто меньше
 * всех вложился в поиск, а тот начинает охотиться на новичка. Так новичок сразу
 * и охотник, и добыча, а из уже собранных подсказок никто ничего не теряет.
 */
function insertIntoChain(player) {
  const others = activePlayers().filter((p) => p.id !== player.id && p.targetId);
  if (others.length === 0) {
    assignTarget(player);
    return;
  }
  const minHints = Math.min(...others.map((p) => p.hints.length));
  const pool = others.filter((p) => p.hints.length === minHints);
  const host = pool[Math.floor(Math.random() * pool.length)];

  setTarget(player, host.targetId);
  setTarget(host, player.id);
  notify(host, 'contract', 'В игру вошёл новый участник, ваш контракт изменился. Подсказки начинаются заново.');
  logEvent('player_inserted', { playerId: player.id, name: player.name, hostNickname: host.nickname });
  save();
}

export function startGame() {
  const active = activePlayers();
  if (active.length < 2) throw new GameError('Нужно минимум два игрока с бейджами');

  // Стартовая раздача — замкнутый круг: каждый охотится ровно на одного
  // и ровно один охотится на него.
  const ring = shuffle(active);
  ring.forEach((player, index) => setTarget(player, ring[(index + 1) % ring.length].id));

  state.game.status = 'running';
  state.game.startedAt = Date.now();
  state.game.finishedAt = null;
  logEvent('game_started', { players: ring.length });
  save();
}

export function setGameStatus(status) {
  if (!['lobby', 'running', 'paused', 'finished'].includes(status)) {
    throw new GameError('Неизвестный статус игры');
  }
  state.game.status = status;
  if (status === 'finished') state.game.finishedAt = Date.now();
  logEvent('game_status', { status });
  save();
}

// --- Патроны и уведомления ---------------------------------------------------

function notify(player, kind, text) {
  player.inbox.unshift({ id: newId(4), at: Date.now(), kind, text, read: false });
  if (player.inbox.length > 30) player.inbox.length = 30;
}

export function refreshAmmo(player, now = Date.now()) {
  const { ammoMax, ammoRegenMinutes } = state.config;
  const regenMs = Math.max(1, ammoRegenMinutes) * 60_000;

  if (player.ammo >= ammoMax) {
    player.ammoRegenAt = now;
    return player;
  }
  const gained = Math.floor((now - player.ammoRegenAt) / regenMs);
  if (gained > 0) {
    player.ammo = Math.min(ammoMax, player.ammo + gained);
    player.ammoRegenAt = player.ammo >= ammoMax ? now : player.ammoRegenAt + gained * regenMs;
  }
  return player;
}

function requireRunning() {
  if (state.game.status !== 'running') throw new GameError('Игра сейчас не идёт', 409, 'not_running');
}

// --- Выстрел -----------------------------------------------------------------

export function shoot(player, targetPlayerId) {
  const now = Date.now();
  requireRunning();
  if (!player.slotId) throw new GameError('Сначала получите бейдж у ведущего', 409, 'no_badge');
  if (!player.targetId) throw new GameError('У вас пока нет контракта', 409, 'no_target');

  refreshAmmo(player, now);
  if (player.ammo < 1) throw new GameError('Патроны кончились. Дождитесь перезарядки.', 409, 'no_ammo');
  if (player.cooldownUntil > now) {
    throw new GameError(`Ствол ещё горячий: ${Math.ceil((player.cooldownUntil - now) / 60_000)} мин`, 409, 'cooldown');
  }

  const victim = state.players[targetPlayerId];
  if (!victim || !victim.slotId) throw new GameError('Такого участника нет в игре', 404, 'no_player');
  if (victim.id === player.id) throw new GameError('В себя стрелять не надо', 400, 'self_shot');
  if (player.attempts.includes(victim.id)) {
    throw new GameError('По этому участнику вы уже стреляли в рамках текущего контракта', 409, 'already_tried');
  }

  player.ammo -= 1;
  player.ammoRegenAt = Math.max(player.ammoRegenAt, player.ammo >= state.config.ammoMax ? now : player.ammoRegenAt);
  player.cooldownUntil = now + state.config.shotCooldownSeconds * 1000;

  const entry = { at: now, targetName: victim.name, points: 0 };
  let outcome;

  if (victim.id !== player.targetId) {
    const penalty = state.config.missPenalty;
    player.score -= penalty;
    player.misses += 1;
    player.attempts.push(victim.id);
    entry.result = 'miss';
    entry.points = -penalty;
    if (state.config.notifyVictimOnMiss) {
      notify(victim, 'miss', `По вам стреляли и промахнулись: кто-то принял вас за свою цель.`);
    }
    logEvent('miss', { playerId: player.id, nickname: player.nickname, penalty });
    outcome = { result: 'miss', points: -penalty };
  } else if (victim.shieldAgainst === player.id) {
    // Цель вычислила своего охотника заранее — выстрел уходит в молоко,
    // но врать стрелку не нужно: он опознал человека верно.
    victim.shieldAgainst = null;
    entry.result = 'blocked';
    notify(victim, 'defense', 'Ваша защита сработала: охотник выстрелил, но промахнулся мимо вас.');
    notify(player, 'blocked', 'Цель успела выставить защиту. Опознали верно, но выстрел не прошёл.');
    logEvent('blocked', { playerId: player.id, nickname: player.nickname, victimNickname: victim.nickname });
    outcome = { result: 'blocked', points: 0 };
  } else {
    const points = state.config.hitPoints;
    player.score += points;
    player.hits += 1;
    entry.result = 'hit';
    entry.points = points;
    entry.targetNickname = victim.nickname;
    // С жертвой ничего не происходит: очки она не теряет, из игры не выходит.
    // Уведомление нужно только чтобы человек знал, что его эмблему раскрыли.
    notify(victim, 'hit', 'В вас попали: кто-то вычислил, что вы и есть его цель. Ваши очки не тронуты, игра продолжается.');
    logEvent('hit', { playerId: player.id, nickname: player.nickname, victimNickname: victim.nickname, points });

    assignTarget(player);
    outcome = {
      result: 'hit',
      points,
      victimNickname: victim.nickname,
      newTargetNickname: player.targetId ? state.players[player.targetId].nickname : null,
    };
  }

  player.log.unshift(entry);
  if (player.log.length > 50) player.log.length = 50;
  save();
  return { ...outcome, cooldownUntil: player.cooldownUntil, ammo: player.ammo };
}

// --- Защита ------------------------------------------------------------------

export function defend(player, suspectId) {
  const now = Date.now();
  requireRunning();
  if (!player.slotId) throw new GameError('Сначала получите бейдж у ведущего', 409, 'no_badge');

  const cooldownUntil = player.lastDefenseAt + state.config.defenseCooldownMinutes * 60_000;
  if (cooldownUntil > now) {
    throw new GameError(`Следующая попытка через ${Math.ceil((cooldownUntil - now) / 60_000)} мин`, 409, 'cooldown');
  }

  const suspect = state.players[suspectId];
  if (!suspect || !suspect.slotId) throw new GameError('Такого участника нет в игре', 404, 'no_player');
  if (suspect.id === player.id) throw new GameError('Вы не охотитесь на самого себя', 400, 'self_defense');

  const hunters = huntersOf(player.id);
  if (hunters.length === 0) {
    // Попытку не тратим: угадывать несуществующего охотника нечестно.
    return { result: 'no_hunters' };
  }

  if (!hunters.some((h) => h.id === suspect.id)) {
    player.lastDefenseAt = now;
    logEvent('defense_wrong', { playerId: player.id, nickname: player.nickname });
    save();
    return { result: 'wrong', nextTryAt: now + state.config.defenseCooldownMinutes * 60_000 };
  }

  player.lastDefenseAt = now;
  player.shieldAgainst = suspect.id;

  let points = 0;
  if (!player.identifiedHunters.includes(suspect.id)) {
    points = state.config.defensePoints;
    player.score += points;
    player.identifiedHunters.push(suspect.id);
  }
  notify(suspect, 'exposed', 'Ваша цель вас вычислила и выставила защиту. Ближайший выстрел по ней не пройдёт.');
  logEvent('defense_right', { playerId: player.id, nickname: player.nickname, points });
  save();
  return { result: 'right', points, suspectName: suspect.name };
}

// --- Коды активностей --------------------------------------------------------

export function createCodes({ count = 1, points = 0, grantsHint = true, maxUses = 1, note = '' }) {
  const total = Number(count);
  if (!Number.isInteger(total) || total < 1 || total > 200) throw new GameError('Кодов должно быть от 1 до 200');

  const taken = new Set(state.codes.map((c) => c.code));
  const created = [];
  for (let i = 0; i < total; i++) {
    let code = newJoinCode().slice(0, 5);
    while (taken.has(code)) code = newJoinCode().slice(0, 5);
    taken.add(code);
    const entry = {
      code,
      points: Math.round(Number(points) || 0),
      grantsHint: Boolean(grantsHint),
      maxUses: Math.max(1, Math.round(Number(maxUses) || 1)),
      note: String(note ?? '').slice(0, 60),
      usedBy: [],
      createdAt: Date.now(),
    };
    state.codes.push(entry);
    created.push(entry);
  }
  logEvent('codes_created', { count: total, points, grantsHint });
  save();
  return created;
}

function revealHint(player) {
  const target = player.targetId ? state.players[player.targetId] : null;
  if (!target) return null;
  const slot = slotById(target.slotId);
  if (!slot) return null;

  if (!player.hintOrder?.length) player.hintOrder = newHintOrder();
  const nextId = player.hintOrder.find((id) => !player.hints.some((h) => h.id === id));
  if (!nextId) return null;

  const hint = { id: nextId, at: Date.now(), text: hintText(slot.emblem, nextId) };
  player.hints.push(hint);
  return hint;
}

export function redeemCode(player, rawCode) {
  requireRunning();
  if (!player.slotId) throw new GameError('Сначала получите бейдж у ведущего', 409, 'no_badge');

  const code = String(rawCode ?? '').toUpperCase().trim();
  const entry = state.codes.find((c) => c.code === code);
  if (!entry) throw new GameError('Такого кода нет', 404, 'no_code');
  if (entry.usedBy.includes(player.id)) throw new GameError('Вы уже вводили этот код', 409, 'code_used');
  if (entry.usedBy.length >= entry.maxUses) throw new GameError('Код уже отработал своё', 409, 'code_spent');

  // Код, который даёт только подсказку, не должен сгорать впустую,
  // если подсказки по текущей цели уже кончились.
  const hint = entry.grantsHint ? revealHint(player) : null;
  if (entry.grantsHint && !hint && !entry.points) {
    throw new GameError('Подсказки по текущей цели кончились — код не потрачен, сохраните его', 409, 'hints_done');
  }

  entry.usedBy.push(player.id);
  if (entry.points) player.score += entry.points;

  logEvent('code_redeemed', { playerId: player.id, nickname: player.nickname, code, points: entry.points });
  save();
  return {
    points: entry.points,
    hint,
    hintsExhausted: entry.grantsHint && !hint,
    hintsLeft: player.hintOrder.length - player.hints.length,
  };
}

// --- Ведущий -----------------------------------------------------------------

/**
 * Выпуск бейджей. append дописывает набор, не задевая выданные и зарезервированные:
 * если бейджи кончились посреди игры, добирать их приходится на ходу, а сброс
 * ради этого означал бы потерю всей игры.
 */
export function createSlots(count, { append = false } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 300) {
    throw new GameError('Количество бейджей должно быть от 1 до 300');
  }
  if (!append && state.slots.some((s) => s.claimedBy || s.reservedBy)) {
    throw new GameError('Бейджи уже в работе. Добавьте дополнительные или сбросьте игру, чтобы выпустить новый набор.');
  }

  let emblems;
  try {
    emblems = generateEmblemSet(count, append ? state.slots.length : 0);
  } catch (err) {
    throw new GameError(err.message);
  }

  const taken = new Set(state.slots.map((s) => s.code));
  const fresh = emblems.map((emblem) => {
    let code = newJoinCode();
    while (taken.has(code)) code = newJoinCode();
    taken.add(code);
    return { id: newId(6), code, emblem, claimedBy: null, reservedBy: null };
  });

  state.slots = append ? [...state.slots, ...fresh] : fresh;
  logEvent('slots_created', { count: fresh.length, append });
  save();
  return fresh;
}

export function adjustScore(playerId, delta, reason = 'вручную') {
  const player = state.players[playerId];
  if (!player) throw new GameError('Игрок не найден', 404);
  const amount = Number(delta);
  if (!Number.isFinite(amount)) throw new GameError('Некорректное количество очков');
  player.score += Math.round(amount);
  logEvent('score_adjusted', { playerId, nickname: player.nickname, delta: Math.round(amount), reason });
  notify(player, 'score', `Ведущий изменил ваш счёт: ${amount > 0 ? '+' : ''}${Math.round(amount)}`);
  save();
  return player;
}

export function grantHint(playerId) {
  const player = state.players[playerId];
  if (!player) throw new GameError('Игрок не найден', 404);
  const hint = revealHint(player);
  if (!hint) throw new GameError('Подсказки по текущей цели кончились');
  notify(player, 'hint', `Новая подсказка: ${hint.text}`);
  logEvent('hint_granted', { playerId, nickname: player.nickname });
  save();
  return hint;
}

export function removePlayer(playerId) {
  const player = state.players[playerId];
  if (!player) throw new GameError('Игрок не найден', 404);
  const slot = slotById(player.slotId);
  if (slot) slot.claimedBy = null;
  const reserved = slotById(player.reservedSlotId);
  if (reserved) reserved.reservedBy = null;
  delete state.players[playerId];

  activePlayers().forEach((p) => {
    if (p.targetId === playerId) assignTarget(p);
    if (p.shieldAgainst === playerId) p.shieldAgainst = null;
  });
  logEvent('player_removed', { playerId, nickname: player.nickname });
  save();
}

// --- Представления -----------------------------------------------------------

export const emblemSvg = (slot, options) => renderEmblem(slot.emblem, options);

export function board() {
  return activePlayers()
    .map((p) => ({ nickname: p.nickname, score: p.score, hits: p.hits, misses: p.misses }))
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.nickname.localeCompare(b.nickname));
}

/** Список реальных имён — по нему стреляют и в нём же ищут своего охотника. */
export function roster() {
  return activePlayers()
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function playerView(player) {
  const now = Date.now();
  refreshAmmo(player, now);
  player.lastSeenAt = now;

  const slot = slotById(player.slotId);
  // До выдачи показываем зарезервированную эмблему: с этим экраном игрок идёт
  // к ведущему за своим бейджем.
  const badge = slot ?? slotById(player.reservedSlotId);
  const target = player.targetId ? state.players[player.targetId] : null;
  const regenMs = Math.max(1, state.config.ammoRegenMinutes) * 60_000;

  return {
    game: { status: state.game.status, title: state.config.eventTitle },
    rules: {
      hitPoints: state.config.hitPoints,
      missPenalty: state.config.missPenalty,
      defensePoints: state.config.defensePoints,
      ammoMax: state.config.ammoMax,
      ammoRegenMinutes: state.config.ammoRegenMinutes,
    },
    me: {
      id: player.id,
      name: player.name,
      nickname: player.nickname,
      score: player.score,
      hits: player.hits,
      misses: player.misses,
      hasBadge: Boolean(slot),
      emblem: badge
        ? { svg: emblemSvg(badge, { size: 160 }), description: describeEmblem(badge.emblem), code: badge.code }
        : null,
      ammo: player.ammo,
      nextAmmoAt: player.ammo >= state.config.ammoMax ? null : player.ammoRegenAt + regenMs,
      cooldownUntil: player.cooldownUntil,
      target: target ? { nickname: target.nickname } : null,
      hints: player.hints,
      hintsLeft: Math.max(0, (player.hintOrder?.length ?? 0) - player.hints.length),
      attempts: player.attempts,
      defense: {
        shielded: Boolean(player.shieldAgainst),
        nextTryAt: player.lastDefenseAt + state.config.defenseCooldownMinutes * 60_000,
        identified: player.identifiedHunters.length,
      },
      log: player.log.slice(0, 20),
      inbox: player.inbox.slice(0, 10),
    },
    roster: roster(),
    board: board(),
    serverTime: now,
  };
}

export function adminView() {
  const issued = state.slots.filter((s) => s.claimedBy).length;
  const reserved = state.slots.filter((s) => s.reservedBy).length;
  const counts = hunterCounts();

  return {
    game: state.game,
    config: state.config,
    stats: {
      slots: state.slots.length,
      issued,
      reserved,
      free: state.slots.length - issued - reserved,
      registered: players().length,
      shots: players().reduce((sum, p) => sum + p.hits + p.misses, 0),
    },
    // Очередь на выдачу: ведущий сверяет эмблему с бейджем в руках и подтверждает.
    pending: players()
      .filter((p) => !p.slotId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => {
        const slot = slotById(p.reservedSlotId);
        return {
          id: p.id,
          name: p.name,
          nickname: p.nickname,
          since: p.createdAt,
          code: slot?.code ?? null,
          emblemSvg: slot ? emblemSvg(slot, { size: 68 }) : null,
          emblemDescription: slot ? describeEmblem(slot.emblem) : null,
        };
      }),
    players: players()
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'))
      .map((p) => {
        const slot = slotById(p.slotId);
        refreshAmmo(p);
        return {
          id: p.id,
          name: p.name,
          nickname: p.nickname,
          score: p.score,
          hits: p.hits,
          misses: p.misses,
          ammo: p.ammo,
          hasBadge: Boolean(slot),
          code: slot?.code ?? null,
          emblemSvg: slot ? emblemSvg(slot, { size: 44 }) : null,
          emblemDescription: slot ? describeEmblem(slot.emblem) : null,
          targetName: p.targetId ? state.players[p.targetId]?.name ?? null : null,
          hunters: counts.get(p.id) ?? 0,
          hints: p.hints.length,
          shielded: Boolean(p.shieldAgainst),
          lastSeenAt: p.lastSeenAt,
          loginBlockedUntil: (p.loginBlockedUntil ?? 0) > Date.now() ? p.loginBlockedUntil : 0,
        };
      }),
    codes: state.codes
      .slice()
      .reverse()
      .map((c) => ({ ...c, used: c.usedBy.length })),
    events: state.events.slice(0, 60),
  };
}
