// Стенд с ботами: репетиция полным составом без тридцати живых телефонов.
//
//   node scripts/bots.mjs setup --count=25   сброс, регистрация, выдача бейджей, старт
//   node scripts/bots.mjs play               боты играют, пока не остановишь
//   node scripts/bots.mjs join --count=5     опоздавшие в идущую игру (бейджи выдаёт ведущий)
//   node scripts/bots.mjs join --count=5 --issue   то же, но бейджи выдаются сами
//
// Боты знают правду: свою цель, своего охотника и разыскиваемого они берут из
// состояния сервера. Иначе они стреляли бы наугад, попадали раз в тридцать
// выстрелов, и в журнале ведущего не было бы ни попаданий, ни сработавших защит.
// Ошибаются они поэтому нарочно и в заданной доле — стенд должен показывать
// живую смесь попаданий, промахов, блоков и охоты за наградой.
//
// Состояние стенда (токены ботов) лежит в data/bots.json, поэтому `play` в одном
// окне подхватывает ботов, добавленных `join` в другом.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.HH_URL ?? 'http://127.0.0.1:3000';
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const BOTS_FILE = path.join(ROOT, 'data', 'bots.json');

const command = process.argv[2] ?? 'help';
const args = process.argv.slice(3);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

// PIN один на всех: ведущий может войти под любым ботом со своего телефона и
// посмотреть игру его глазами. Четыре одинаковые или подряд идущие цифры сервер
// не принимает — они угадываются с первой попытки.
const PIN = '2609';

const NAMES = [
  'Аня Смирнова', 'Борис Ким', 'Вера Ли', 'Глеб Орлов', 'Дима Ветров',
  'Егор Пахомов', 'Жанна Крылова', 'Зоя Панина', 'Игорь Мещеряков', 'Катя Родионова',
  'Лёва Гущин', 'Марина Соболева', 'Никита Юдин', 'Оля Забела', 'Павел Ершов',
  'Рита Чернова', 'Семён Грачёв', 'Таня Белова', 'Улан Досжанов', 'Фёдор Лапин',
  'Хава Ибрагимова', 'Чулпан Ахметова', 'Шамиль Гаджиев', 'Эдик Варданян', 'Юля Тихонова',
  'Яна Ковалёва', 'Артём Носов', 'Богдан Швец', 'Влада Гринько', 'Гоша Титов',
  'Даша Ефимова', 'Женя Лобанов', 'Злата Романюк', 'Ирина Полякова', 'Костя Дёмин',
  'Люба Савина', 'Максим Ерохин', 'Настя Гуляева', 'Олег Пирогов', 'Полина Жук',
];

const CHAT = [
  'кто-нибудь видел красную звезду у бара?',
  'меня сегодня уже дважды пытались снять',
  'обменяю подсказку на молчание',
  'у сцены стоит тип с золотым кругом, я его запомнил',
  'если это ты за мной ходишь — я тебя вижу',
  'три зелёных креста в зале, и все ведут себя странно',
  'кто заберёт награду, с того виски',
  'моя цель точно не пьёт — весь вечер у стола с водой',
  'жду патрон как манны небесной',
  'снял свою цель, спасибо за подсказку, незнакомец',
  'треугольники, вас слишком много',
  'ведущий, ещё активность!',
  'я поставил защиту и сплю спокойно',
  'кто-то промахнулся по мне, слышу шаги',
];

const NOTES = ['похож на охотника', 'красный круг?', 'видел у сцены', 'слишком тихий', 'звезда на бейдже', 'не он'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('ru-RU');

async function call(url, { method = 'GET', body, token, admin } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-player-token'] = token;
  if (admin) headers['x-admin-token'] = admin;
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

const readState = async () => JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
const readBots = async () => JSON.parse(await fs.readFile(BOTS_FILE, 'utf8').catch(() => '[]'));
const writeBots = (bots) => fs.writeFile(BOTS_FILE, `${JSON.stringify(bots, null, 2)}\n`, 'utf8');

async function adminToken() {
  const state = await readState();
  return state.adminToken;
}

/** Регистрирует ботов, начиная с первого свободного имени. */
async function register(count, { admin, issue }) {
  const bots = await readBots();
  const taken = new Set(bots.map((b) => b.name));
  const free = NAMES.filter((n) => !taken.has(n));
  if (free.length < count) throw new Error(`имён хватит только на ${free.length} ботов`);

  const fresh = [];
  for (const name of free.slice(0, count)) {
    const suggested = await call('/api/nickname');
    const nickname = suggested.data.nickname ?? `Тень ${Math.floor(Math.random() * 1000)}`;
    const res = await call('/api/register', { method: 'POST', body: { name, nickname, pin: PIN } });
    if (!res.ok) {
      console.log(`  ! ${name}: ${res.data.error ?? res.status}`);
      continue;
    }
    const bot = { id: res.data.me.id, name, nickname: res.data.me.nickname, token: res.data.token };
    fresh.push(bot);
    bots.push(bot);

    if (issue) {
      const issued = await call(`/api/admin/player/${bot.id}/badge`, { method: 'POST', admin });
      if (!issued.ok) console.log(`  ! бейдж ${name}: ${issued.data.error}`);
    }
  }
  await writeBots(bots);
  return fresh;
}

async function setup() {
  const count = value('count', 25);
  const admin = await adminToken();

  const before = await call('/api/admin/state', { admin });
  if (!before.ok) throw new Error(`пульт не отвечает: ${before.data.error ?? before.status}`);
  if (before.data.players.length > 0 && !flag('force')) {
    console.error(`В игре уже ${before.data.players.length} участников. Если это стенд, повторите с --force.`);
    process.exit(1);
  }

  await call('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' }, admin });
  await fs.rm(BOTS_FILE, { force: true });
  const freshAdmin = await adminToken();

  // Темп репетиции: выстрел раз в двадцать секунд, патрон раз в минуту, розыск
  // держится три минуты и через две может вернуться. На боевой игре всё это
  // считается в часах, но тогда стенд пришлось бы смотреть до утра.
  const tempo = {
    shotCooldownSeconds: 20,
    ammoStart: 3,
    ammoMax: 4,
    ammoRegenMinutes: 1,
    bountyHoldMinutes: 3,
    bountyPauseMinutes: 2,
  };
  await call('/api/admin/config', { method: 'PATCH', body: tempo, admin: freshAdmin });

  console.log(`Регистрирую ${count} ботов и выдаю бейджи…`);
  const bots = await register(count, { admin: freshAdmin, issue: true });
  console.log(`Готово: ${bots.length} игроков с бейджами.`);

  const started = await call('/api/admin/game/start', { method: 'POST', admin: freshAdmin });
  if (!started.ok) throw new Error(`старт не удался: ${started.data.error}`);

  console.log('');
  console.log(`  пульт   : ${BASE}/admin?token=${freshAdmin}`);
  console.log(`  табло   : ${BASE}/board?token=${freshAdmin}`);
  console.log(`  игроки  : ${BASE}`);
  console.log('');
  console.log(`  PIN у всех ботов: ${PIN} — можно войти под любым с телефона («Я уже регистрировался»).`);
  console.log(`  Темп: выстрел раз в ${tempo.shotCooldownSeconds} с, патрон раз в ${tempo.ammoRegenMinutes} мин.`);
  console.log('  Дальше: node scripts/bots.mjs play');
  console.log('');
  // Сброс игры настройки сохраняет намеренно, поэтому репетиционный темп сам по
  // себе не уйдёт и доживёт до настоящего вечера, если о нём не вспомнить.
  console.log('  ВАЖНО: перед настоящей игрой верните боевой темп — прогоните');
  console.log('  node scripts/smoke.mjs, он возвращает все настройки в исходные.');
}

async function join() {
  const count = value('count', 5);
  const admin = await adminToken();
  const issue = flag('issue');
  const bots = await register(count, { admin, issue });
  console.log(
    `Зарегистрировано ${bots.length}: ${bots.map((b) => b.name).join(', ')}.\n` +
      (issue
        ? 'Бейджи выданы — боты уже в игре и встроились в цепочку контрактов.'
        : 'Бейджи не выданы: они висят в пульте в «Ожидают выдачи», нажмите «Выдал».')
  );
}

// --- Игра -------------------------------------------------------------------

const counters = { shots: 0, hits: 0, misses: 0, blocked: 0, bounty: 0, guards: 0, chat: 0, codes: 0, notes: 0 };
let truth = { at: 0, state: null };

/** Правда о игре: цели, охотники, разыскиваемый. Читаем с диска не чаще раза в 3 с. */
async function groundTruth() {
  if (Date.now() - truth.at < 3000 && truth.state) return truth.state;
  truth = { at: Date.now(), state: await readState() };
  return truth.state;
}

async function actFor(bot) {
  const me = await call('/api/me', { token: bot.token });
  if (!me.ok) return;
  const view = me.data;
  if (view.game.status !== 'running' || !view.me.hasBadge) return;

  const state = await groundTruth();
  const real = state.players[bot.id];
  if (!real) return;

  const others = view.roster.filter((r) => r.id !== bot.id);
  if (others.length === 0) return;

  const ready = view.me.ammo > 0 && view.me.cooldownUntil < Date.now();
  const roll = Math.random();

  // Выстрел по контракту: в двух случаях из трёх бот «вычислил» цель верно.
  if (ready && roll < 0.5 && real.targetId) {
    const victim = Math.random() < 0.66 ? real.targetId : pick(others).id;
    const res = await call('/api/shoot', { method: 'POST', body: { playerId: victim }, token: bot.token });
    if (!res.ok) return;
    counters.shots += 1;
    counters[res.data.result === 'hit' ? 'hits' : res.data.result === 'blocked' ? 'blocked' : 'misses'] += 1;
    const name = view.roster.find((r) => r.id === victim)?.name ?? '?';
    console.log(`${stamp()}  ${bot.name} → ${name}: ${res.data.result}`);
    return;
  }

  // Охота за наградой: разыскиваемого тоже угадывают не всегда.
  if (ready && roll < 0.62 && view.wanted && !view.wanted.isMe) {
    const wantedId = state.game.wanted?.playerId;
    const victim = Math.random() < 0.6 && wantedId !== bot.id ? wantedId : pick(others).id;
    if (!victim) return;
    const res = await call('/api/shoot', { method: 'POST', body: { playerId: victim, bounty: true }, token: bot.token });
    if (!res.ok) return;
    counters.shots += 1;
    counters.bounty += 1;
    counters[res.data.result === 'hit' ? 'hits' : res.data.result === 'blocked' ? 'blocked' : 'misses'] += 1;
    const name = view.roster.find((r) => r.id === victim)?.name ?? '?';
    console.log(`${stamp()}  ${bot.name} → ${name}: награда, ${res.data.result}`);
    return;
  }

  // Защита: треть ставок приходится на настоящего охотника, поэтому блоки в
  // журнале появляются, но не превращаются в правило.
  if (roll < 0.74) {
    const hunter = Object.values(state.players).find((p) => p.targetId === bot.id);
    const suspect = Math.random() < 0.35 && hunter ? hunter.id : pick(others).id;
    const res = await call('/api/defend', { method: 'POST', body: { playerId: suspect }, token: bot.token });
    if (res.ok) {
      counters.guards += 1;
      console.log(`${stamp()}  ${bot.name} ставит защиту на ${res.data.suspectName}`);
    }
    return;
  }

  if (roll < 0.88) {
    const res = await call('/api/chat', { method: 'POST', body: { text: pick(CHAT) }, token: bot.token });
    if (res.ok) {
      counters.chat += 1;
      console.log(`${stamp()}  «${view.me.nickname}» в салуне: ${res.data.text}`);
    }
    return;
  }

  if (roll < 0.94) {
    const res = await call('/api/note', {
      method: 'POST',
      body: { playerId: pick(others).id, text: pick(NOTES) },
      token: bot.token,
    });
    if (res.ok) counters.notes += 1;
    return;
  }

  // Коды за активности: бот берёт любой неотработавший. Так видно, как в пульте
  // растут счётчики использований, в том числе у кодов, выпущенных только что.
  const fresh = (state.codes ?? []).filter((c) => c.usedBy.length < c.maxUses && !c.usedBy.includes(bot.id));
  if (fresh.length > 0) {
    const code = pick(fresh).code;
    const res = await call('/api/code', { method: 'POST', body: { code }, token: bot.token });
    if (res.ok) {
      counters.codes += 1;
      console.log(`${stamp()}  ${bot.name} вводит код ${code}: ${res.data.hint?.text ?? 'очки'}`);
    }
  }
}

async function play() {
  const tick = value('tick', 1200);
  console.log(`Боты играют. Действие раз в ${tick} мс, Ctrl+C — остановить.\n`);
  let sinceReport = 0;

  for (;;) {
    const bots = await readBots();
    if (bots.length === 0) {
      console.log('Ботов нет: сначала node scripts/bots.mjs setup');
      return;
    }
    try {
      await actFor(pick(bots));
    } catch (err) {
      console.log(`${stamp()}  сбой: ${err.message}`);
    }

    sinceReport += 1;
    if (sinceReport >= 60) {
      sinceReport = 0;
      console.log(
        `${stamp()}  итого: выстрелов ${counters.shots} (попаданий ${counters.hits}, промахов ${counters.misses}, ` +
          `заблокировано ${counters.blocked}, за награду ${counters.bounty}), защит ${counters.guards}, ` +
          `сообщений ${counters.chat}, кодов ${counters.codes}, ботов ${bots.length}`
      );
    }
    await sleep(tick);
  }
}

const commands = { setup, play, join };

if (!commands[command]) {
  console.log('node scripts/bots.mjs setup [--count=25] [--force]');
  console.log('node scripts/bots.mjs play [--tick=1200]');
  console.log('node scripts/bots.mjs join [--count=5] [--issue]');
  process.exit(command === 'help' ? 0 : 1);
}

try {
  await commands[command]();
} catch (err) {
  console.error(`Стенд сломался: ${err.message}`);
  process.exit(1);
}
