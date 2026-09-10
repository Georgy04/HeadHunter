import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadPool } from './pool.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Игра идёт несколько дней, поэтому темп неспешный: магазин пустой на старте,
// патрон приходит раз в час. Первый час уходит на разведку, а не на пальбу.
export const DEFAULT_CONFIG = {
  eventTitle: 'HeadHunter',
  hitPoints: 1000,
  missPenalty: 0,
  defensePoints: 2000,
  bountyPoints: 2000,
  bountyLeadPoints: 1000,
  bountyHoldMinutes: 20,
  bountyPauseMinutes: 60,
  ammoStart: 0,
  ammoMax: 3,
  ammoRegenMinutes: 60,
  shotCooldownSeconds: 120,
  notifyVictimOnMiss: true,
  wifiSsid: '',
  wifiPassword: '',
};

const STATE_VERSION = 6;

export function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function newJoinCode() {
  // Без похожих друг на друга символов: код печатается на бейдже и вводится руками.
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34679';
  let code = '';
  for (const byte of crypto.randomBytes(6)) code += alphabet[byte % alphabet.length];
  return code;
}

/**
 * Чистое состояние. Бейджи и коды берутся из заготовленного пула, если он есть:
 * они напечатаны заранее и лежат в коробке, поэтому и новая игра, и сброс должны
 * давать ровно тот же набор, что на бумаге. Без пула набор выпускается в пульте,
 * как раньше.
 */
function emptyState() {
  const pool = loadPool();
  if (pool) {
    console.log(`[pool] набор из pool/pool.json: бейджей ${pool.slots.length}, кодов ${pool.codes.length}`);
  }
  return {
    version: STATE_VERSION,
    adminToken: newId(12),
    config: { ...DEFAULT_CONFIG },
    game: {
      status: 'lobby',
      startedAt: null,
      finishedAt: null,
      // Раунд считается от нуля: первый старт даёт первый раунд и не тасует
      // никнеймы, каждый следующий — тасует.
      round: 0,
      roundStartedAt: 0,
      wanted: null,
      wantedPauseUntil: 0,
    },
    slots: pool?.slots ?? [],
    players: {},
    codes: pool?.codes ?? [],
    chat: [],
    // Журнал выстрелов ведущего живёт весь вечер и не стирается сменой раунда —
    // в отличие от личных журналов игроков. См. server/game.js: logShot.
    shotLog: [],
    events: [],
  };
}

let firstRun = false;

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Правила игры менялись сильно; старое сохранение не переживёт новую логику.
    if (parsed.version !== STATE_VERSION) {
      console.warn(`[store] state.json version ${parsed.version} is outdated, archiving and starting fresh`);
      fs.renameSync(STATE_FILE, `${STATE_FILE}.v${parsed.version}-${Date.now()}`);
      firstRun = true;
      const fresh = emptyState();
      fresh.adminToken = parsed.adminToken ?? fresh.adminToken;
      return fresh;
    }
    parsed.config = { ...DEFAULT_CONFIG, ...parsed.config };
    parsed.codes ??= [];
    parsed.chat ??= [];
    parsed.shotLog ??= [];

    // Кулдаун перестал быть абсолютной меткой: теперь он считается от времени
    // выстрела, чтобы правка настроек действовала и на тех, кто уже отстрелялся.
    Object.values(parsed.players ?? {}).forEach((player) => {
      player.lastShotAt ??= 0;
      delete player.cooldownUntil;
    });

    // Нетронутая игра подхватывает заготовленный пул. Иначе он появлялся бы
    // только после сброса, и сервер, обновлённый между играми, встречал бы
    // гостей без единого бейджа. Терять при этом нечего: ни игроков, ни набора.
    if (parsed.slots.length === 0 && parsed.codes.length === 0 && Object.keys(parsed.players).length === 0) {
      const pool = loadPool();
      if (pool) {
        parsed.slots = pool.slots;
        parsed.codes = pool.codes;
        console.log(`[pool] набор из pool/pool.json: бейджей ${pool.slots.length}, кодов ${pool.codes.length}`);
      }
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] state.json is unreadable (${err.message}), starting from scratch`);
      try {
        fs.renameSync(STATE_FILE, `${STATE_FILE}.broken-${Date.now()}`);
      } catch {}
    }
    firstRun = true;
    return emptyState();
  }
}

export const state = load();

if (process.env.ADMIN_TOKEN) state.adminToken = process.env.ADMIN_TOKEN;

let saveTimer = null;
let saving = false;
let saveAgain = false;

function writeNow() {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  const tmp = `${STATE_FILE}.tmp`;
  fs.promises
    .mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, JSON.stringify(state, null, 2)))
    .then(() => fs.promises.rename(tmp, STATE_FILE))
    .catch((err) => console.error(`[store] save failed: ${err.message}`))
    .finally(() => {
      saving = false;
      if (saveAgain) {
        saveAgain = false;
        writeNow();
      }
    });
}

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 200);
}

export function saveSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[store] final save failed: ${err.message}`);
  }
}

export function resetState() {
  // Сброс отменить нельзя, а бейджи к этому моменту уже напечатаны: новый набор
  // получит другие коды, и бумага станет мусором. Поэтому прежнее состояние
  // откладываем рядом с файлом — игру можно вернуть, положив копию на место.
  try {
    saveSync();
    fs.copyFileSync(STATE_FILE, `${STATE_FILE}.before-reset-${Date.now()}`);
  } catch (err) {
    console.error(`[store] reset backup failed: ${err.message}`);
  }

  const fresh = emptyState();
  fresh.adminToken = state.adminToken;
  fresh.config = { ...state.config };
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, fresh);
  // Пишем сразу, а не с обычной задержкой: сбросом заканчивают работу и следом
  // закрывают сервер, а stop.cmd убивает процесс жёстко. Отложенная запись в
  // этот момент теряется, и после запуска возвращается игра, которую только что
  // стёрли, — самое неприятное недоразумение из возможных.
  saveSync();
}

// Токен ведущего печатается в консоли при старте. Фиксируем его на диске сразу,
// иначе после перезапуска ноутбука ссылка на админку перестанет работать.
if (firstRun) saveSync();

export function logEvent(type, data = {}) {
  state.events.unshift({ id: newId(6), at: Date.now(), type, ...data });
  if (state.events.length > 500) state.events.length = 500;
  save();
}
