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
    // score — сквозной счёт на аукцион, roundScore — счёт текущего раунда для табло.
    score: 0,
    roundScore: 0,
    hits: 0,
    misses: 0,
    targetId: null,
    attempts: [],
    hintOrder: [],
    hints: [],
    ammo: state.config.ammoStart,
    ammoRegenAt: Date.now(),
    lastShotAt: 0,
    guardAgainst: null,
    guardSetAt: 0,
    identifiedHunters: [],
    bountyRound: 0,
    bountyAttempts: [],
    notes: {},
    lastChatAt: 0,
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

/**
 * Очки идут в два счётчика сразу. Сквозной `score` — деньги на аукцион, он копится
 * весь вечер и виден только ведущему. `roundScore` — счёт текущего раунда, по нему
 * строится табло у игроков и выбирается разыскиваемый.
 *
 * Разделение появилось из-за перетасовки никнеймов: если бы табло показывало
 * сквозной счёт, суммы до и после смены раунда совпали бы, и любой, кто запомнил
 * прежнее табло, сопоставил бы старый никнейм с новым по цифрам. Обнулённый счёт
 * раунда сопоставлять не с чем.
 */
function addPoints(player, amount) {
  player.score += amount;
  player.roundScore = (player.roundScore ?? 0) + amount;
}

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
  const others = activePlayers().filter((p) => p.id !== player.id);
  if (others.length === 0) {
    setTarget(player, null);
    save();
    return null;
  }
  // Прежнюю цель обходим стороной — дважды подряд охотиться на одного скучно, —
  // но когда игроков всего двое, обходить некого: лучше тот же человек снова,
  // чем игрок, оставшийся вообще без контракта.
  const candidates = others.filter((p) => p.id !== player.targetId);
  if (candidates.length === 0) candidates.push(...others);
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
    // Встраиваться не во что: контрактов ещё нет ни у кого. Раздаём их тем, кто
    // остался без цели, — иначе игрок, чью цель до этого удалили, так и стоял бы
    // без задачи, пока ведущий не перераздаст цели вручную.
    activePlayers()
      .filter((p) => p.id !== player.id && !p.targetId)
      .forEach((p) => assignTarget(p));
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

/**
 * Никнеймы уезжают к другим людям. К концу раунда половина площадки уже связала
 * ник с лицом, и второй раунд без перетасовки разгадали бы за минуту. Сдвиг по
 * кругу — перестановка без неподвижных точек: свой прежний ник не остаётся ни у
 * кого, а сам набор придуманных участниками имён сохраняется.
 */
function mixNicknames(active) {
  const ring = shuffle(active);
  const previous = ring.map((p) => p.nickname);
  ring.forEach((player, index) => {
    player.nickname = previous[(index + 1) % previous.length];
  });
}

/**
 * Никнеймы поменяли владельцев, поэтому всё, что на них ссылалось, теперь врёт:
 * личные журналы выстрелов, уведомления и салун. Это стираем. Очки, попадания и
 * блокнот живут дальше: очки идут на аукцион, а заметки писались про эмблемы, а
 * эмблемы остаются на своих владельцах.
 *
 * `state.shotLog` намеренно не трогаем: это журнал ведущего, в нём настоящие
 * имена и номер раунда, поэтому перетасовка его не портит, а нужен он за весь
 * вечер целиком.
 */
function wipeRoundTraces() {
  state.chat.length = 0;
  players().forEach((player) => {
    player.log.length = 0;
    player.inbox.length = 0;
    player.bountyAttempts = [];
    player.bountyRound = 0;
    player.guardAgainst = null;
    player.guardSetAt = 0;
    player.identifiedHunters = [];
    player.lastChatAt = 0;
  });
}

/**
 * Старт раунда. Первый раунд идёт с теми никнеймами, которые участники придумали
 * сами; каждый следующий начинается с перетасовки — счёт при этом сквозной,
 * потому что очки тратятся на аукционе в конце вечера, а не в конце раунда.
 */
export function startGame({ force = false } = {}) {
  const active = activePlayers();
  if (active.length < 2) throw new GameError('Нужно минимум два игрока с бейджами');
  // Иначе случайное нажатие «Старт» посреди раунда стёрло бы салун и журналы.
  // Осознанная смена раунда приходит сюда с force — за неё отвечает отдельная
  // кнопка со своим вопросом. Для перераздачи целей без потерь есть третья.
  if (!force && state.game.status === 'running') {
    throw new GameError('Раунд уже идёт: сначала завершите его, потом начинайте новый', 409, 'already_running');
  }

  const round = (state.game.round ?? 0) + 1;
  if (round > 1) {
    mixNicknames(active);
    wipeRoundTraces();
  }
  // Табло начинается с нуля у всех: по нему и выбирается разыскиваемый.
  players().forEach((player) => {
    player.roundScore = 0;
  });

  const dealt = dealContracts();

  state.game.status = 'running';
  state.game.startedAt = Date.now();
  state.game.finishedAt = null;
  state.game.wanted = null;
  state.game.wantedPauseUntil = 0;
  state.game.round = round;
  state.game.roundStartedAt = state.game.startedAt;

  if (round > 1) {
    active.forEach((player) =>
      notify(
        player,
        'nickname',
        `Раунд ${round}: теперь вы «${player.nickname}». Прежний никнейм ушёл другому участнику, а эмблема на бейдже осталась вашей.`
      )
    );
  }
  logEvent('game_started', { players: dealt, round });
  save();
}

/**
 * Раздача контрактов замкнутым кругом: каждый охотится ровно на одного и ровно
 * один охотится на него. Так у площадки нет ни безнаказанных — тех, за кем никто
 * не идёт, — ни тех, кого пасут двое.
 *
 * Тем же кругом работает и «Перераздать цели» посреди раунда: раздавать каждому
 * по отдельности было бы проще, но при этом легко получить игрока, на которого
 * не охотится никто, и он проведёт остаток раунда в безопасности, сам того не зная.
 */
export function dealContracts() {
  const active = activePlayers();
  if (active.length < 2) throw new GameError('Нужно минимум два игрока с бейджами');
  const ring = shuffle(active);
  ring.forEach((player, index) => setTarget(player, ring[(index + 1) % ring.length].id));
  save();
  return ring.length;
}

/**
 * Смена раунда одним действием: идущий раунд закрывается и тут же начинается
 * следующий. Раньше это делалось двумя кнопками — «Финал», потом «Старт», — и
 * ведущему приходилось знать, что новый раунд прячется за словом «Старт».
 */
export function startNextRound() {
  if (activePlayers().length < 2) throw new GameError('Нужно минимум два игрока с бейджами');
  return startGame({ force: true });
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

// --- Розыск ------------------------------------------------------------------

/**
 * Лидер раунда попадает в розыск: его никнейм и награда видны всем, и стрелять в
 * него может каждый, а не только его охотник. Имя не объявляется намеренно —
 * иначе награду забирал бы тот, у кого просто оказался патрон, а так двадцать
 * девять человек получают общую задачу вычислить одного.
 *
 * Считаем по очкам раунда, а не по сквозному счёту: сквозной не обнуляется, и
 * розыск после перетасовки никнеймов указывал бы на того же человека под новым
 * именем — половина площадки получила бы связку даром.
 */
function soleLeader() {
  const active = activePlayers();
  if (active.length < 2) return null;
  const sorted = active.slice().sort((a, b) => (b.roundScore ?? 0) - (a.roundScore ?? 0));
  const best = sorted[0].roundScore ?? 0;
  // На нуле лидера нет: в начале раунда все равны, и розыск был бы случайным.
  if (best <= 0) return null;
  // Лидерство должно быть заметным. Отрыв в одно попадание — это ещё не лидер, а
  // тот, кто выстрелил первым: розыск скакал бы за каждым попаданием по площадке
  // и обесценился. Порог заодно решает и ничью — при равенстве отрыва нет.
  if (best - (sorted[1].roundScore ?? 0) <= state.config.bountyLeadPoints) return null;
  return sorted[0];
}

export function refreshWanted(now = Date.now()) {
  const game = state.game;
  const clear = (reason) => {
    if (!game.wanted) return;
    const previous = state.players[game.wanted.playerId];
    if (previous) notify(previous, 'wanted_off', 'Розыск с вас снят.');
    logEvent('wanted_cleared', { nickname: game.wanted.nickname, reason });
    game.wanted = null;
    save();
  };

  if (game.status !== 'running') return clear('game_stopped');
  if ((game.wantedPauseUntil ?? 0) > now) return clear('pause');

  // Награду платит payBounty по текущим настройкам, поэтому и плакат обещает их
  // же: иначе поправленная по ходу игры награда расходилась бы с объявленной.
  if (game.wanted) game.wanted.bounty = state.config.bountyPoints;

  // Объявление держится не меньше `bountyHoldMinutes`, даже если лидер за это время
  // сменился. Иначе розыск мигал бы: ведущий начисляет очки за активности пачками,
  // и наверху табло за минуту успевает побывать полдюжины человек. Мигающее
  // объявление хуже отсутствующего — за ним не успеть, а тому, кого объявили и
  // тут же отменили, механика просто непонятна.
  if (game.wanted && now - game.wanted.since < Math.max(0, state.config.bountyHoldMinutes) * 60_000) return;

  const leader = soleLeader();
  if (!leader) return clear('no_leader');
  if (game.wanted?.playerId === leader.id) return;

  const previous = game.wanted ? state.players[game.wanted.playerId] : null;
  if (previous) notify(previous, 'wanted_off', 'Розыск с вас снят: наверху табло теперь другой.');

  game.wanted = {
    playerId: leader.id,
    nickname: leader.nickname,
    bounty: state.config.bountyPoints,
    since: now,
  };
  notify(
    leader,
    'wanted',
    `Вы в розыске. Ваш никнейм объявлен всем, награда за вашу голову — ${state.config.bountyPoints}. Стрелять в вас теперь может любой.`
  );
  logEvent('wanted_declared', { nickname: leader.nickname, bounty: state.config.bountyPoints });
  save();
}

/** Награда приходит сверху: разыскиваемый ничего не теряет, деньги на аукцион не сгорают. */
function payBounty(player, victim, now) {
  const points = state.config.bountyPoints;
  addPoints(player, points);
  state.game.wanted = null;
  state.game.wantedPauseUntil = now + Math.max(0, state.config.bountyPauseMinutes) * 60_000;

  notify(
    victim,
    'bounty',
    `Награду за вашу голову забрали: вас вычислили, пока вы были в розыске. Очки при этом не тронуты.`
  );
  logEvent('bounty_claimed', {
    playerId: player.id,
    nickname: player.nickname,
    victimNickname: victim.nickname,
    points,
  });
  return points;
}

// --- Выстрел -----------------------------------------------------------------

/**
 * Пауза между выстрелами считается от времени выстрела, а не запоминается меткой
 * «свободен с такого-то часа». Так правка `shotCooldownSeconds` действует сразу и
 * на тех, кто уже стрелял: ведущий, подкручивающий темп по ходу вечера, не должен
 * ждать, пока догорят прежние кулдауны.
 */
const cooldownUntil = (player) =>
  (player.lastShotAt ?? 0) + Math.max(0, state.config.shotCooldownSeconds) * 1000;

const SHOT_LOG_LIMIT = 1000;

/**
 * Общий журнал выстрелов для ведущего. Настоящие имена и номер раунда, живёт весь
 * вечер и смену раунда переживает — в отличие от личных журналов игроков, которые
 * стираются: там никнеймы, а после перетасовки они указывают на других людей.
 * Здесь имена, поэтому врать журнал не может, а ведущему он нужен целиком — по
 * нему разбирают спорные ситуации и подводят итоги вечера.
 */
function logShot(player, victim, entry, asBounty) {
  state.shotLog.unshift({
    id: newId(4),
    at: entry.at,
    round: state.game.round ?? 0,
    shooter: player.name,
    victim: victim.name,
    result: entry.result,
    points: entry.points,
    bounty: asBounty,
  });
  if (state.shotLog.length > SHOT_LOG_LIMIT) state.shotLog.length = SHOT_LOG_LIMIT;
}

export function shoot(player, targetPlayerId, { bounty = false } = {}) {
  const now = Date.now();
  requireRunning();
  if (!player.slotId) throw new GameError('Сначала получите бейдж у ведущего', 409, 'no_badge');

  refreshWanted(now);
  const wanted = state.game.wanted;

  const victim = state.players[targetPlayerId];
  if (!victim || !victim.slotId) throw new GameError('Такого участника нет в игре', 404, 'no_player');
  if (victim.id === player.id) throw new GameError('В себя стрелять не надо', 400, 'self_shot');

  // Выстрел за награду — это заявление «вот этот человек и есть разыскиваемый»,
  // и промах в нём остаётся промахом, даже если под руку попала собственная цель:
  // про неё игрок ничего не утверждал. А вот когда разыскиваемый и есть ваша цель,
  // считаем выстрел контрактным: там начислят и очки за попадание, и награду.
  const asBounty = bounty && !(victim.id === player.targetId && wanted?.playerId === victim.id);

  if (asBounty) {
    if (!wanted) throw new GameError('Сейчас никто не в розыске', 409, 'no_wanted');
    if (wanted.playerId === player.id) {
      throw new GameError('В розыске вы сами — награду за себя не получить', 400, 'self_bounty');
    }
  } else if (!player.targetId) {
    throw new GameError('У вас пока нет контракта', 409, 'no_target');
  }

  refreshAmmo(player, now);
  if (player.ammo < 1) throw new GameError('Патроны кончились. Дождитесь перезарядки.', 409, 'no_ammo');
  const hot = cooldownUntil(player);
  if (hot > now) {
    const left = Math.ceil((hot - now) / 1000);
    throw new GameError(`Ствол ещё горячий: ${left < 60 ? `${left} с` : `${Math.ceil(left / 60)} мин`}`, 409, 'cooldown');
  }

  // У контракта свой список отработанных вариантов, у каждого объявления розыска —
  // свой: промах в охоте за наградой не должен вычёркивать человека из контракта.
  if (asBounty && player.bountyRound !== wanted.since) {
    player.bountyRound = wanted.since;
    player.bountyAttempts = [];
  }
  const tried = asBounty ? (player.bountyAttempts ??= []) : player.attempts;
  if (tried.includes(victim.id)) {
    throw new GameError(
      asBounty
        ? 'По этому участнику вы уже стреляли в этом розыске'
        : 'По этому участнику вы уже стреляли в рамках текущего контракта',
      409,
      'already_tried'
    );
  }

  player.ammo -= 1;
  player.ammoRegenAt = Math.max(player.ammoRegenAt, player.ammo >= state.config.ammoMax ? now : player.ammoRegenAt);
  player.lastShotAt = now;

  const entry = { at: now, targetName: victim.name, points: 0 };
  let outcome;

  if (asBounty) {
    if (victim.id === wanted.playerId) {
      const points = payBounty(player, victim, now);
      entry.result = 'bounty';
      entry.points = points;
      entry.targetNickname = victim.nickname;
      outcome = { result: 'bounty', points, victimNickname: victim.nickname };
    } else {
      const penalty = state.config.missPenalty;
      addPoints(player, -penalty);
      player.misses += 1;
      player.bountyAttempts.push(victim.id);
      entry.result = 'miss';
      entry.points = -penalty;
      if (state.config.notifyVictimOnMiss) {
        notify(victim, 'miss', 'По вам стреляли и промахнулись: кто-то принял вас за разыскиваемого.');
      }
      logEvent('bounty_miss', { playerId: player.id, nickname: player.nickname, penalty });
      outcome = { result: 'miss', points: -penalty };
    }

    logShot(player, victim, entry, true);
    player.log.unshift(entry);
    if (player.log.length > 50) player.log.length = 50;
    save();
    return { ...outcome, cooldownUntil: cooldownUntil(player), ammo: player.ammo };
  }

  if (victim.id !== player.targetId) {
    const penalty = state.config.missPenalty;
    addPoints(player, -penalty);
    player.misses += 1;
    player.attempts.push(victim.id);
    entry.result = 'miss';
    entry.points = -penalty;
    if (state.config.notifyVictimOnMiss) {
      notify(victim, 'miss', `По вам стреляли и промахнулись: кто-то принял вас за свою цель.`);
    }
    logEvent('miss', { playerId: player.id, nickname: player.nickname, penalty });
    outcome = { result: 'miss', points: -penalty };
  } else if (victim.guardAgainst === player.id) {
    // Жертва поставила защиту именно на этого охотника и переиграла его: выстрел
    // не проходит, а контракт снимается. Стрелку врать не нужно — цель он опознал
    // верно, — но подсказки уходят вместе с контрактом: они про прежнюю эмблему.
    victim.guardAgainst = null;
    victim.guardSetAt = 0;
    entry.result = 'blocked';

    let points = 0;
    if (!victim.identifiedHunters.includes(player.id)) {
      points = state.config.defensePoints;
      addPoints(victim, points);
      victim.identifiedHunters.push(player.id);
    }

    notify(
      victim,
      'defense',
      `Защита сработала: ${player.name} действительно охотился на вас и выстрелил. Выстрел не прошёл, контракт с вас снят.`
    );
    notify(
      player,
      'blocked',
      'Цель ждала именно вас: выстрел не прошёл, контракт провален. Вы опознали человека верно, но подсказки начинаются заново с новой целью.'
    );
    logEvent('blocked', {
      playerId: player.id,
      nickname: player.nickname,
      victimNickname: victim.nickname,
      points,
    });

    assignTarget(player);
    outcome = {
      result: 'blocked',
      points: 0,
      newTargetNickname: player.targetId ? state.players[player.targetId].nickname : null,
    };
  } else {
    let points = state.config.hitPoints;
    // Цель оказалась в розыске — награда идёт сверх очков за контракт.
    const alsoWanted = wanted?.playerId === victim.id ? payBounty(player, victim, now) : 0;
    points += alsoWanted;
    addPoints(player, state.config.hitPoints);
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
      bounty: alsoWanted,
      victimNickname: victim.nickname,
      newTargetNickname: player.targetId ? state.players[player.targetId].nickname : null,
    };
  }

  logShot(player, victim, entry, false);
  player.log.unshift(entry);
  if (player.log.length > 50) player.log.length = 50;
  save();
  return { ...outcome, cooldownUntil: cooldownUntil(player), ammo: player.ammo };
}

// --- Защита ------------------------------------------------------------------

/**
 * Защита — не догадка с ответом, а ставка: игрок называет того, кого считает своим
 * охотником, и меняет её когда захочет. Правильность не сообщается, поэтому тыкать
 * наугад бессмысленно: случайная ставка не приносит ни очков, ни информации.
 * Выяснится всё только в момент выстрела — см. `shoot`.
 */
export function defend(player, suspectId) {
  requireRunning();
  if (!player.slotId) throw new GameError('Сначала получите бейдж у ведущего', 409, 'no_badge');

  const suspect = state.players[suspectId];
  if (!suspect || !suspect.slotId) throw new GameError('Такого участника нет в игре', 404, 'no_player');
  if (suspect.id === player.id) throw new GameError('Вы не охотитесь на самого себя', 400, 'self_defense');
  if (player.guardAgainst === suspect.id) {
    throw new GameError('Защита уже поставлена на этого участника', 409, 'same_guard');
  }

  player.guardAgainst = suspect.id;
  player.guardSetAt = Date.now();
  // В ленту попадает только сам факт: имя подозреваемого — тайна игрока, и
  // ведущему оно нужно в таблице, а не в общей истории.
  logEvent('guard_set', { playerId: player.id, nickname: player.nickname });
  save();
  return { result: 'set', suspectName: suspect.name };
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
  if (entry.points) addPoints(player, entry.points);

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
  addPoints(player, Math.round(amount));
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

  if (state.game.wanted?.playerId === playerId) state.game.wanted = null;

  activePlayers().forEach((p) => {
    if (p.targetId === playerId) assignTarget(p);
    if (p.guardAgainst === playerId) {
      p.guardAgainst = null;
      p.guardSetAt = 0;
    }
    if (p.notes) delete p.notes[playerId];
  });
  logEvent('player_removed', { playerId, nickname: player.nickname });
  save();
}

// --- Салун: общий чат и обезличенный пульс -----------------------------------

const CHAT_LIMIT = 200;
const CHAT_PAUSE_MS = 4000;

/** Сообщения подписаны никнеймом: это позволяет и хвастаться, и врать, не выдавая себя. */
export function postChat(player, rawText) {
  requireRunning();
  if (!player.slotId) throw new GameError('Сначала получите бейдж у ведущего', 409, 'no_badge');

  const text = norm(rawText).slice(0, 200);
  if (text.length < 1) throw new GameError('Пустое сообщение отправлять некуда', 400, 'empty_message');

  const now = Date.now();
  if (now - (player.lastChatAt ?? 0) < CHAT_PAUSE_MS) {
    throw new GameError('Слишком часто. Подождите пару секунд.', 429, 'too_fast');
  }

  player.lastChatAt = now;
  state.chat.push({ id: newId(4), at: now, playerId: player.id, nickname: player.nickname, text });
  if (state.chat.length > CHAT_LIMIT) state.chat.splice(0, state.chat.length - CHAT_LIMIT);
  save();
  return { at: now, nickname: player.nickname, text };
}

export function deleteChatMessage(id) {
  const index = state.chat.findIndex((m) => m.id === id);
  if (index === -1) throw new GameError('Сообщение не найдено', 404, 'no_message');
  const [removed] = state.chat.splice(index, 1);
  logEvent('chat_removed', { nickname: removed.nickname });
  save();
  return removed;
}

/** Игроку — только никнейм и текст: связку с реальным именем видит один ведущий. */
const chatView = () => state.chat.slice(-60).map(({ id, at, nickname, text }) => ({ id, at, nickname, text }));

/**
 * Пульс — обезличенная лента для игроков: без неё человек не знает, идёт ли вокруг
 * хоть что-то. Имена и никнеймы здесь не звучат, кроме розыска, который публичен
 * по замыслу.
 */
const PULSE = {
  hit: () => 'кого-то подстрелили',
  miss: () => 'кто-то выстрелил и промахнулся',
  bounty_miss: () => 'кто-то промахнулся в охоте за наградой',
  blocked: () => 'чья-то защита сработала: контракт снят',
  code_redeemed: () => 'кто-то получил подсказку за активность',
  badge_issued: () => 'в игру вошёл новый участник',
  game_started: (e) =>
    (e.round ?? 1) > 1 ? `раунд ${e.round} начался, никнеймы перетасованы` : `игра началась, участников ${e.players}`,
  wanted_declared: (e) => `в розыске: ${e.nickname}, награда ${e.bounty}`,
  wanted_cleared: () => 'розыск снят',
  bounty_claimed: (e) => `награду за ${e.victimNickname} забрали`,
};

// Лента событий хранится новыми вперёд, поэтому берём начало, а не конец. Пульс
// обрезан текущим раундом: события прошлого раунда называют никнеймы, которые с
// перетасовкой достались другим людям, и лента вводила бы в заблуждение.
const pulse = () =>
  state.events
    .filter((e) => PULSE[e.type] && e.at >= (state.game.roundStartedAt ?? 0))
    .slice(0, 25)
    .map((e) => ({ at: e.at, text: PULSE[e.type](e) }));

// --- Блокнот -----------------------------------------------------------------

/**
 * Заметка против имени: за двенадцать часов игрок увидит десятки бейджей и всё
 * перезабудет. Текст свободный, потому что поиск по списку ищет и по нему: пометив
 * «алый круг», человек потом находит всех помеченных так одним словом.
 */
export function setNote(player, otherId, rawText) {
  if (!state.players[otherId]) throw new GameError('Такого участника нет в игре', 404, 'no_player');
  if (otherId === player.id) throw new GameError('Заметку о себе оставлять незачем', 400, 'self_note');

  player.notes ??= {};
  const text = norm(rawText).slice(0, 40);
  if (text) player.notes[otherId] = text;
  else delete player.notes[otherId];
  save();
  return { playerId: otherId, note: text };
}

// --- Представления -----------------------------------------------------------

export const emblemSvg = (slot, options) => renderEmblem(slot.emblem, options);

/**
 * Табло у игроков — очки текущего раунда и ничего больше. Сквозной счёт сюда не
 * попадает намеренно: с перетасовкой никнеймов совпадающие суммы до и после
 * смены раунда выдали бы, кто теперь под каким именем. Попадания и промахи по
 * той же причине остались личной статистикой — они тоже не обнуляются.
 */
export function board() {
  return activePlayers()
    .map((p) => ({ nickname: p.nickname, score: p.roundScore ?? 0 }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
}

/**
 * Список реальных имён — по нему стреляют и в нём же ищут своего охотника.
 * Заметки из блокнота идут рядом с именем: они личные, у каждого свои.
 */
export function roster(player = null) {
  const notes = player?.notes ?? {};
  return activePlayers()
    .map((p) => ({ id: p.id, name: p.name, note: notes[p.id] ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function playerView(player) {
  const now = Date.now();
  refreshAmmo(player, now);
  refreshWanted(now);
  player.lastSeenAt = now;

  const slot = slotById(player.slotId);
  // До выдачи показываем зарезервированную эмблему: с этим экраном игрок идёт
  // к ведущему за своим бейджем.
  const badge = slot ?? slotById(player.reservedSlotId);
  const target = player.targetId ? state.players[player.targetId] : null;
  const regenMs = Math.max(1, state.config.ammoRegenMinutes) * 60_000;

  return {
    game: { status: state.game.status, title: state.config.eventTitle, round: state.game.round ?? 0 },
    rules: {
      hitPoints: state.config.hitPoints,
      missPenalty: state.config.missPenalty,
      defensePoints: state.config.defensePoints,
      bountyPoints: state.config.bountyPoints,
      ammoMax: state.config.ammoMax,
      ammoRegenMinutes: state.config.ammoRegenMinutes,
    },
    // Розыск публичен: никнейм и награда видны всем, имя — нет. Разыскиваемый
    // узнаёт себя по флагу, остальные видят задачу.
    wanted: state.game.wanted
      ? {
          nickname: state.game.wanted.nickname,
          bounty: state.game.wanted.bounty,
          since: state.game.wanted.since,
          isMe: state.game.wanted.playerId === player.id,
          isMyTarget: state.game.wanted.playerId === player.targetId,
        }
      : null,
    me: {
      id: player.id,
      name: player.name,
      nickname: player.nickname,
      // Свой счёт игрок видит целиком: очки раунда — то, за что идёт борьба на
      // табло, сквозной — его деньги на аукцион. Про чужой сквозной счёт он не
      // узнаёт ничего, и связка «ник — человек» через цифры не восстанавливается.
      score: player.roundScore ?? 0,
      totalScore: player.score,
      hits: player.hits,
      misses: player.misses,
      hasBadge: Boolean(slot),
      emblem: badge
        ? { svg: emblemSvg(badge, { size: 160 }), description: describeEmblem(badge.emblem), code: badge.code }
        : null,
      ammo: player.ammo,
      nextAmmoAt: player.ammo >= state.config.ammoMax ? null : player.ammoRegenAt + regenMs,
      cooldownUntil: cooldownUntil(player),
      target: target ? { nickname: target.nickname } : null,
      hints: player.hints,
      hintsLeft: Math.max(0, (player.hintOrder?.length ?? 0) - player.hints.length),
      attempts: player.attempts,
      // Кто на игрока охотится и сколько их — не сообщаем: это он и должен
      // выяснить. Отдаём только его собственную ставку.
      defense: {
        guardId: player.guardAgainst,
        guardName: player.guardAgainst ? state.players[player.guardAgainst]?.name ?? null : null,
        guardSetAt: player.guardSetAt ?? 0,
        blocked: player.identifiedHunters.length,
      },
      bountyAttempts: player.bountyAttempts ?? [],
      log: player.log.slice(0, 20),
      inbox: player.inbox.slice(0, 10),
    },
    roster: roster(player),
    board: board(),
    pulse: pulse(),
    chat: chatView(),
    serverTime: now,
  };
}

export function adminView() {
  const issued = state.slots.filter((s) => s.claimedBy).length;
  const reserved = state.slots.filter((s) => s.reservedBy).length;
  const counts = hunterCounts();
  refreshWanted();
  const wanted = state.game.wanted ? state.players[state.game.wanted.playerId] : null;

  return {
    game: state.game,
    config: state.config,
    // Ведущему розыск виден с реальным именем: он объявляет его голосом на площадке.
    wanted: wanted
      ? { name: wanted.name, nickname: wanted.nickname, bounty: state.game.wanted.bounty, since: state.game.wanted.since }
      : null,
    wantedPauseUntil: (state.game.wantedPauseUntil ?? 0) > Date.now() ? state.game.wantedPauseUntil : 0,
    // Чат ведущий видит с именами: анонимность нужна против игроков, не против него.
    chat: state.chat.slice(-40).map((m) => ({
      ...m,
      name: state.players[m.playerId]?.name ?? '—',
    })),
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
      // Сначала счёт раунда: по нему идёт игра и выбирается разыскиваемый.
      // Сквозной — валюта аукциона, он важен в конце вечера, а не по ходу.
      .sort(
        (a, b) =>
          (b.roundScore ?? 0) - (a.roundScore ?? 0) || b.score - a.score || a.name.localeCompare(b.name, 'ru')
      )
      .map((p) => {
        const slot = slotById(p.slotId);
        refreshAmmo(p);
        return {
          id: p.id,
          name: p.name,
          nickname: p.nickname,
          // Ведущий видит оба счёта: сквозной нужен для аукциона, счёт раунда —
          // чтобы понимать, кто наверху табло и почему объявлен в розыск.
          score: p.score,
          roundScore: p.roundScore ?? 0,
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
          guardName: p.guardAgainst ? state.players[p.guardAgainst]?.name ?? null : null,
          lastSeenAt: p.lastSeenAt,
          loginBlockedUntil: (p.loginBlockedUntil ?? 0) > Date.now() ? p.loginBlockedUntil : 0,
        };
      }),
    codes: state.codes
      .slice()
      .reverse()
      .map((c) => ({ ...c, used: c.usedBy.length })),
    // Журнал выстрелов — за весь вечер, включая прошлые раунды.
    shotLog: state.shotLog.slice(0, 150),
    events: state.events.slice(0, 60),
  };
}
