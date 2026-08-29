// Прогон полного сценария против запущенного сервера: регистрация со своим
// никнеймом, выдача бейджей, подсказки за коды, выстрелы по именам, защита,
// щит и поздний участник. Запуск: node scripts/smoke.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hintText, HINT_IDS, EMBLEM_COMBINATIONS } from '../server/emblems.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function call(path, { method = 'GET', body, token, admin } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-player-token': token } : {}),
      ...(admin ? { 'x-admin-token': admin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const readState = async () => JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'state.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = (await readState()).adminToken;
console.log(`\nHeadHunter smoke test -> ${BASE}\n`);

// 1. Чистый старт
await call('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' }, admin });
await call('/api/admin/config', {
  method: 'PATCH',
  body: { shotCooldownSeconds: 0, defenseCooldownMinutes: 0, ammoStart: 6, ammoMax: 6 },
  admin,
});
const slots = await call('/api/admin/slots', { method: 'POST', body: { count: 30 }, admin });
check('создано 30 бейджей', slots.data.count === 30, JSON.stringify(slots.data));

const tooMany = await call('/api/admin/slots', { method: 'POST', body: { count: EMBLEM_COMBINATIONS + 1 }, admin });
check('набор эмблем не растягивается сверх предела', tooMany.status === 400, `status ${tooMany.status}`);

await sleep(300);
let raw = await readState();
const codes = raw.slots.map((s) => s.code);
check('коды бейджей уникальны', new Set(codes).size === codes.length);
check(
  'эмблемы уникальны',
  new Set(raw.slots.map((s) => `${s.emblem.outer}/${s.emblem.inner}/${s.emblem.outerColor}/${s.emblem.innerColor}`)).size === 30
);

// Главное свойство набора: подсказка про любой атрибут должна оставлять
// примерно треть подозреваемых, иначе круг сужается непредсказуемо.
const spread = ['outer', 'inner', 'outerColor', 'innerColor'].map((attr) => {
  const counts = {};
  raw.slots.forEach((s) => {
    counts[s.emblem[attr]] = (counts[s.emblem[attr]] ?? 0) + 1;
  });
  return { attr, values: Object.values(counts) };
});
check(
  'каждая подсказка отсекает около двух третей (по атрибутам 8-12 из 30)',
  spread.every((s) => s.values.length === 3 && s.values.every((v) => v >= 8 && v <= 12)),
  JSON.stringify(spread)
);

// Прогоняем воронку целиком: для каждой возможной цели считаем, сколько
// подозреваемых остаётся после первой, второй, третьей и четвёртой подсказки.
const emblems = raw.slots.map((s) => s.emblem);
const funnel = HINT_IDS.map(() => 0);
emblems.forEach((target) => {
  let pool = emblems;
  HINT_IDS.forEach((attr, step) => {
    pool = pool.filter((e) => e[attr] === target[attr]);
    funnel[step] += pool.length;
  });
});
const average = funnel.map((sum) => sum / emblems.length);
check(
  `воронка подсказок: 30 -> ${average.map((n) => n.toFixed(1)).join(' -> ')}`,
  average[0] <= 12 && average[1] <= 4.5 && average[2] <= 2 && average[3] === 1,
  JSON.stringify(average)
);

// 2. Регистрация со своим никнеймом
const NAMES = ['Аня Смирнова', 'Борис Ким', 'Вера Ли', 'Глеб Орлов'];
const NICKS = ['Однорукий Джо', 'Тихий Омут', 'Мадам Брошь', 'Пыльный Гриф'];
const tokens = [];
const ids = [];
for (const [i, name] of NAMES.entries()) {
  const res = await call('/api/register', { method: 'POST', body: { name, nickname: NICKS[i] } });
  check(`${name} зарегистрировался`, res.status === 200 && Boolean(res.data.token), res.data.error ?? '');
  tokens.push(res.data.token);
  ids.push(res.data.me?.id);
}

const firstView = await call('/api/me', { token: tokens[0] });
check(
  'регистрация сразу показывает будущую эмблему и код бейджа',
  Boolean(firstView.data.me.emblem?.svg?.includes('<svg')) && Boolean(firstView.data.me.emblem?.code),
  JSON.stringify(firstView.data.me.emblem)
);
check('до выдачи бейджа игрок в игре не считается', firstView.data.me.hasBadge === false);

const dupNick = await call('/api/register', { method: 'POST', body: { name: 'Кто-то', nickname: NICKS[0] } });
check('никнейм нельзя занять дважды', dupNick.status === 409, `status ${dupNick.status}`);

const dupName = await call('/api/register', { method: 'POST', body: { name: NAMES[0], nickname: 'Свежий Ник' } });
check('имя нельзя занять дважды', dupName.status === 409, `status ${dupName.status}`);

const sameAsName = await call('/api/register', { method: 'POST', body: { name: 'Пётр Пух', nickname: 'Пётр Пух' } });
check('никнейм не может совпадать со своим именем', sameAsName.status === 400, `status ${sameAsName.status}`);

const suggestion = await call('/api/nickname');
check('сервер умеет предлагать никнейм', typeof suggestion.data.nickname === 'string' && suggestion.data.nickname.length > 3);

// 3. Эмблему назначает сервер при регистрации, бейдж выдаёт ведущий
check('до выдачи бейджа игрока нет в списке участников', firstView.data.roster.length === 0, `roster ${firstView.data.roster.length}`);
check('до выдачи бейджа игрока нет на табло', firstView.data.board.length === 0);

const noBadgeShot = await call('/api/shoot', { method: 'POST', body: { playerId: 'x' }, token: tokens[0] });
check('без бейджа стрелять нельзя', noBadgeShot.data.code === 'not_running' || noBadgeShot.data.code === 'no_badge');

const queue = await call('/api/admin/state', { admin });
check('очередь на выдачу показывает всех зарегистрированных', queue.data.pending.length === 4, `pending ${queue.data.pending.length}`);
check(
  'в очереди видно эмблему, описание и код',
  queue.data.pending.every((p) => p.emblemSvg?.includes('<svg') && p.emblemDescription && p.code)
);
check('очередь идёт по времени регистрации', queue.data.pending[0].name === NAMES[0]);

await sleep(300);
raw = await readState();
const reservedCode = new Map(raw.slots.filter((s) => s.reservedBy).map((s) => [s.reservedBy, s.code]));
check('каждому зарегистрированному зарезервирован свой бейдж', reservedCode.size === 4 && new Set(reservedCode.values()).size === 4);
const freeCode = raw.slots.find((s) => !s.reservedBy && !s.claimedBy).code;

// Ведущий мог взять из стопки не тот бейдж — запись подстраивается под реальность.
const issuedOther = await call(`/api/admin/player/${ids[0]}/badge`, { method: 'POST', body: { code: freeCode }, admin });
check('ведущий может выдать не зарезервированный бейдж', issuedOther.status === 200 && issuedOther.data.code === freeCode, JSON.stringify(issuedOther.data));

const afterIssue = await call('/api/me', { token: tokens[0] });
check('игрок видит выданную эмблему', afterIssue.data.me.hasBadge === true && afterIssue.data.me.emblem.code === freeCode);

await sleep(300);
raw = await readState();
check('прежний резерв освободился', !raw.slots.find((s) => s.code === reservedCode.get(ids[0])).reservedBy);

const stealReserved = await call(`/api/admin/player/${ids[2]}/badge`, {
  method: 'POST',
  body: { code: reservedCode.get(ids[1]) },
  admin,
});
check('бейдж, зарезервированный за другим, выдать нельзя', stealReserved.data.code === 'slot_reserved', JSON.stringify(stealReserved.data));

for (const [i, id] of ids.entries()) {
  if (i === 0) continue;
  const res = await call(`/api/admin/player/${id}/badge`, { method: 'POST', admin });
  check(`${NAMES[i]} получил бейдж от ведущего`, res.status === 200, res.data.error ?? '');
}

const issuedTwice = await call(`/api/admin/player/${ids[1]}/badge`, { method: 'POST', admin });
check('дважды выдать бейдж одному игроку нельзя', issuedTwice.data.code === 'has_badge', JSON.stringify(issuedTwice.data));

// Черновой игрок для проверки отказов, перевыдачи и освобождения резерва
const temp = await call('/api/register', { method: 'POST', body: { name: 'Тест Тестов', nickname: 'Черновик' } });
const tempId = temp.data.me.id;
const tempCode = temp.data.me.emblem.code;

const alreadyIssued = await call(`/api/admin/player/${tempId}/badge`, { method: 'POST', body: { code: freeCode }, admin });
check('выданный бейдж повторно не выдать', alreadyIssued.data.code === 'slot_taken', JSON.stringify(alreadyIssued.data));

const reassigned = await call(`/api/admin/player/${tempId}/badge/reassign`, { method: 'POST', admin });
check('«другой бейдж» меняет эмблему', reassigned.status === 200 && reassigned.data.code !== tempCode, JSON.stringify(reassigned.data));

const reassignIssued = await call(`/api/admin/player/${ids[0]}/badge/reassign`, { method: 'POST', admin });
check('у игрока с выданным бейджем эмблему не подменить', reassignIssued.data.code === 'has_badge');

await call(`/api/admin/player/${tempId}`, { method: 'DELETE', admin });
await sleep(300);
raw = await readState();
check('удаление игрока освобождает зарезервированный бейдж', raw.slots.every((s) => s.reservedBy !== tempId));

// Прежний путь — самопривязка по коду с бейджа — убран вместе с QR на бейджах
const goneBind = await call('/api/badge', { method: 'POST', body: { code: freeCode }, token: tokens[0] });
check('самопривязка по коду убрана', goneBind.status === 404, `status ${goneBind.status}`);
const goneDeepLink = await fetch(`${BASE}/j/${freeCode}`);
check('deep link с бейджа убран', goneDeepLink.status === 404, `status ${goneDeepLink.status}`);

const beforeStart = await call('/api/admin/state', { admin });
check('регистрация и выдача сами игру не начинают', beforeStart.data.game.status === 'lobby', beforeStart.data.game.status);

// 4. Старт
const early = await call('/api/shoot', { method: 'POST', body: { playerId: 'x' }, token: tokens[0] });
check('до старта выстрел запрещён', early.data.code === 'not_running');

await call('/api/admin/game/start', { method: 'POST', admin });
await sleep(300);
raw = await readState();

// raw переприсваивается по ходу теста, поэтому список игроков — функция,
// иначе проверки считают очки по устаревшему снимку.
const everyone = () => Object.values(raw.players);
const byToken = (t) => everyone().find((p) => p.token === t);
const me = byToken(tokens[0]);

check('контракты розданы всем', everyone().every((p) => p.targetId && p.targetId !== p.id));
check(
  'на старте каждого преследует ровно один охотник',
  everyone().every((p) => everyone().filter((h) => h.targetId === p.id).length === 1)
);

const view = await call('/api/me', { token: tokens[0] });
check('игрок видит никнейм цели', Boolean(view.data.me.target?.nickname));
check('игрок видит список реальных имён', view.data.roster.length === 4);
check(
  'список имён не раскрывает никнеймы',
  view.data.roster.every((p) => Object.keys(p).sort().join() === 'id,name')
);
check(
  'табло показывает только никнеймы',
  view.data.board.every((r) => !NAMES.includes(r.nickname))
);

// 5. Подсказки за коды
const madeCodes = await call('/api/admin/codes', {
  method: 'POST',
  body: { count: 3, points: 0, grantsHint: true, maxUses: 2, note: 'викторина' },
  admin,
});
const hintCodes = madeCodes.data.created;
check('коды выпущены', hintCodes.length === 3, JSON.stringify(madeCodes.data.created));

const firstHint = await call('/api/code', { method: 'POST', body: { code: hintCodes[0] }, token: tokens[0] });
check('код выдал подсказку', Boolean(firstHint.data.hint?.text), JSON.stringify(firstHint.data));
check('подсказка появилась в профиле', firstHint.data.state.me.hints.length === 1);

const reuse = await call('/api/code', { method: 'POST', body: { code: hintCodes[0] }, token: tokens[0] });
check('один код нельзя ввести дважды', reuse.data.code === 'code_used');

const secondHint = await call('/api/code', { method: 'POST', body: { code: hintCodes[1] }, token: tokens[0] });
check('вторая подсказка отличается от первой', secondHint.data.hint.id !== firstHint.data.hint.id);

const bogus = await call('/api/code', { method: 'POST', body: { code: 'ZZZZZ' }, token: tokens[0] });
check('несуществующий код отклонён', bogus.status === 404);

await sleep(300);
raw = await readState();
const targetSlot = raw.slots.find((s) => s.claimedBy === byToken(tokens[0]).targetId);
const hintsSoFar = byToken(tokens[0]).hints;
check(
  'подсказки описывают именно эмблему цели',
  hintsSoFar.every((h) => h.text === hintText(targetSlot.emblem, h.id)),
  JSON.stringify(hintsSoFar)
);
check('подсказок на контракт ровно четыре', firstHint.data.state.me.hintsLeft === HINT_IDS.length - 1);

// Четыре подсказки на контракт — пятый код за подсказку не должен сгорать зря.
const moreCodes = await call('/api/admin/codes', {
  method: 'POST',
  body: { count: 3, grantsHint: true, maxUses: 1 },
  admin,
});
const [third, fourth, fifth] = moreCodes.data.created;
await call('/api/code', { method: 'POST', body: { code: third }, token: tokens[0] });
const lastHint = await call('/api/code', { method: 'POST', body: { code: fourth }, token: tokens[0] });
check('четвёртая подсказка выдана', lastHint.data.state.me.hints.length === 4, JSON.stringify(lastHint.data.hint));
check('все четыре подсказки про разные атрибуты', new Set(lastHint.data.state.me.hints.map((h) => h.id)).size === 4);

const extra = await call('/api/code', { method: 'POST', body: { code: fifth }, token: tokens[0] });
check('лишний код за подсказку не сгорает', extra.data.code === 'hints_done', JSON.stringify(extra.data));
const stillFresh = await call('/api/admin/state', { admin });
check(
  'неиспользованный код остался неиспользованным',
  stillFresh.data.codes.find((c) => c.code === fifth).used === 0
);

// 6. Защита: игрок вычисляет своего охотника
const hunter = everyone().find((p) => p.targetId === me.id);
const notHunter = everyone().find((p) => p.id !== me.id && p.id !== hunter.id);

const wrongDefense = await call('/api/defend', { method: 'POST', body: { playerId: notHunter.id }, token: tokens[0] });
check('неверная защита не срабатывает', wrongDefense.data.result === 'wrong', JSON.stringify(wrongDefense.data));

const rightDefense = await call('/api/defend', { method: 'POST', body: { playerId: hunter.id }, token: tokens[0] });
check('верная защита опознаёт охотника', rightDefense.data.result === 'right', JSON.stringify(rightDefense.data));
check('за охотника начислены очки', rightDefense.data.points === 8, `points ${rightDefense.data.points}`);
check('щит активен', rightDefense.data.state.me.defense.shielded === true);

const repeatDefense = await call('/api/defend', { method: 'POST', body: { playerId: hunter.id }, token: tokens[0] });
check('повторное опознание того же охотника очков не даёт', repeatDefense.data.points === 0);

const hunterToken = tokens[everyone().findIndex((p) => p.id === hunter.id)];
const hunterInbox = await call('/api/me', { token: hunterToken });
check('охотник узнал, что его вычислили', hunterInbox.data.me.inbox.some((m) => m.kind === 'exposed'));

// 7. Щит гасит ближайший выстрел
const blocked = await call('/api/shoot', { method: 'POST', body: { playerId: me.id }, token: hunterToken });
check('щит погасил выстрел', blocked.data.result === 'blocked', JSON.stringify(blocked.data));
check('за погашенный выстрел очков не снимают', blocked.data.state.me.score === 0, `score ${blocked.data.state.me.score}`);

const afterShield = await call('/api/shoot', { method: 'POST', body: { playerId: me.id }, token: hunterToken });
check('второй выстрел проходит: щит одноразовый', afterShield.data.result === 'hit', JSON.stringify(afterShield.data));
check('охотник получил новый контракт', Boolean(afterShield.data.newTargetNickname));
check('подсказки обнулились вместе с контрактом', afterShield.data.state.me.hints.length === 0);

// 8. Выстрелы по именам
await sleep(300);
raw = await readState();
const myTargetId = byToken(tokens[0]).targetId;
const wrongPerson = everyone().find((p) => p.id !== me.id && p.id !== myTargetId);
const scoreBefore = byToken(tokens[0]).score;
check('очки за защиту на месте', scoreBefore === 8, `score ${scoreBefore}`);

const missed = await call('/api/shoot', { method: 'POST', body: { playerId: wrongPerson.id }, token: tokens[0] });
check('промах засчитан', missed.data.result === 'miss', JSON.stringify(missed.data));
check('штраф снят', missed.data.state.me.score === scoreBefore - 3);
check('промах отмечен в списке', missed.data.state.me.attempts.includes(wrongPerson.id));

const again = await call('/api/shoot', { method: 'POST', body: { playerId: wrongPerson.id }, token: tokens[0] });
check('повторный выстрел по тому же человеку запрещён', again.data.code === 'already_tried');

const selfShot = await call('/api/shoot', { method: 'POST', body: { playerId: me.id }, token: tokens[0] });
check('в себя стрелять нельзя', selfShot.data.code === 'self_shot');

const victimToken = tokens[everyone().findIndex((p) => p.id === myTargetId)];
const victimScoreBefore = (await call('/api/me', { token: victimToken })).data.me.score;

const hit = await call('/api/shoot', { method: 'POST', body: { playerId: myTargetId }, token: tokens[0] });
check('попадание засчитано', hit.data.result === 'hit', JSON.stringify(hit.data));
check('очки за попадание начислены', hit.data.state.me.score === scoreBefore - 3 + 10);
check('выдан новый контракт', hit.data.newTargetNickname !== hit.data.victimNickname);
check('подсказки по новому контракту начались заново', hit.data.state.me.hints.length === 0);

// С подстреленным ничего не происходит: очки на месте, игра продолжается,
// приходит только уведомление постфактум.
const victimAfter = await call('/api/me', { token: victimToken });
check('у жертвы очки не изменились', victimAfter.data.me.score === victimScoreBefore, `${victimScoreBefore} -> ${victimAfter.data.me.score}`);
check('жертва получила уведомление о попадании', victimAfter.data.me.inbox.some((m) => m.kind === 'hit'));
check('жертва осталась в игре со своим контрактом', Boolean(victimAfter.data.me.target));

// 9. Кулдаун и патроны
await call('/api/admin/config', { method: 'PATCH', body: { shotCooldownSeconds: 600 }, admin });
await sleep(300);
raw = await readState();
const scoreAfterHit = hit.data.state.me.score;
const freshTarget = byToken(tokens[0]).targetId;
const someone = everyone().find((p) => p.id !== me.id && p.id !== freshTarget);
await call('/api/shoot', { method: 'POST', body: { playerId: someone.id }, token: tokens[0] });
const hot = await call('/api/shoot', { method: 'POST', body: { playerId: freshTarget }, token: tokens[0] });
check('кулдаун между выстрелами работает', hot.data.code === 'cooldown', JSON.stringify(hot.data));

await call('/api/admin/config', { method: 'PATCH', body: { shotCooldownSeconds: 0, ammoMax: 6 }, admin });

// 10. Поздний участник входит в игру на второй день
const late = await call('/api/register', { method: 'POST', body: { name: 'Дима Поздний', nickname: 'Опоздун' } });
const lateBeforeIssue = await call('/api/me', { token: late.data.token });
check('поздний участник до выдачи бейджа без контракта', !lateBeforeIssue.data.me.target);
check(
  'поздний участник не попадает в список целей раньше времени',
  lateBeforeIssue.data.roster.every((p) => p.name !== 'Дима Поздний')
);

await call(`/api/admin/player/${late.data.me.id}/badge`, { method: 'POST', admin });
await sleep(300);
raw = await readState();
const newcomer = Object.values(raw.players).find((p) => p.name === 'Дима Поздний');
const active = Object.values(raw.players).filter((p) => p.slotId);
check('поздний участник получил контракт после выдачи бейджа', Boolean(newcomer.targetId));
check(
  'на позднего участника кто-то охотится',
  active.some((p) => p.targetId === newcomer.id)
);
check('поздний участник не охотится сам на себя', newcomer.targetId !== newcomer.id);

// 11. Ведущий
const adminState = await call('/api/admin/state', { admin });
check('ведущий видит связку имя-ник-эмблема', adminState.data.players.every((p) => p.name && p.nickname));
check('ведущий видит цель по реальному имени', adminState.data.players.every((p) => !p.hasBadge || p.targetName));
check('ведущий видит выпущенные коды', adminState.data.codes.length === 6, `codes ${adminState.data.codes.length}`);
check('лента событий содержит защиту', adminState.data.events.some((e) => e.type === 'defense_right'));

const bonus = await call(`/api/admin/player/${me.id}/score`, { method: 'POST', body: { delta: 5 }, admin });
check(
  'ведущий начисляет очки за активности',
  bonus.data.players.find((p) => p.id === me.id).score === scoreAfterHit - 3 + 5,
  `score ${bonus.data.players.find((p) => p.id === me.id).score}, ожидалось ${scoreAfterHit - 3 + 5}`
);

const adminHint = await call(`/api/admin/player/${me.id}/hint`, { method: 'POST', admin });
check('ведущий может выдать подсказку вручную', Boolean(adminHint.data.hint?.text), JSON.stringify(adminHint.data));

const noAdmin = await call('/api/admin/state', { admin: 'wrong-token' });
check('админка закрыта токеном', noAdmin.status === 401);

const noAuth = await call('/api/me');
check('без токена доступа нет', noAuth.status === 401);

// 12. Печать бейджей
const print = await fetch(`${BASE}/print?token=${admin}`);
const html = await print.text();
check('лист бейджей печатается', print.status === 200 && html.includes('<svg') && html.includes(codes[0]));
check('QR с бейджей убран — сканировать их больше не нужно', !html.includes('<img'), 'на листе остался <img>');

const printFree = await fetch(`${BASE}/print?free=1&token=${admin}`);
const freeHtml = await printFree.text();
const badgeCount = (page) => (page.match(/class="badge"/g) ?? []).length;
const stats = (await call('/api/admin/state', { admin })).data.stats;
check(
  'лист «только невыданные» печатает лишь свободные бейджи',
  badgeCount(html) === stats.slots && badgeCount(freeHtml) === stats.slots - stats.issued,
  `всего ${badgeCount(html)}/${stats.slots}, свободных ${badgeCount(freeHtml)}/${stats.slots - stats.issued}`
);

// 13. Бейджи кончились: регистрация отказывает понятно, набор дописывается на ходу
await call('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' }, admin });
await call('/api/admin/slots', { method: 'POST', body: { count: 1 }, admin });
const firstIn = await call('/api/register', { method: 'POST', body: { name: 'Первый Пришедший', nickname: 'Первяк' } });
check('единственный бейдж достался первому', firstIn.status === 200 && Boolean(firstIn.data.me.emblem?.code));

const noSlots = await call('/api/register', { method: 'POST', body: { name: 'Второй Пришедший', nickname: 'Вторяк' } });
check('когда бейджи кончились, регистрация отказывает понятно', noSlots.data.code === 'no_slots', JSON.stringify(noSlots.data));

const replaceInUse = await call('/api/admin/slots', { method: 'POST', body: { count: 5 }, admin });
check('набор нельзя заменить, пока бейджи в работе', replaceInUse.status === 400, `status ${replaceInUse.status}`);

const added = await call('/api/admin/slots', { method: 'POST', body: { count: 2, append: true }, admin });
check('бейджи можно допечатать, не сбрасывая игру', added.data.count === 2, JSON.stringify(added.data));

const afterAdd = await call('/api/register', { method: 'POST', body: { name: 'Второй Пришедший', nickname: 'Вторяк' } });
check('после допечатки регистрация проходит', afterAdd.status === 200, afterAdd.data.error ?? '');

await sleep(300);
raw = await readState();
check(
  'допечатанные эмблемы не повторяют выпущенные',
  new Set(raw.slots.map((s) => `${s.emblem.outer}/${s.emblem.inner}/${s.emblem.outerColor}/${s.emblem.innerColor}`)).size ===
    raw.slots.length,
  `слотов ${raw.slots.length}`
);

// Тест крутил темп игры и наплодил игроков — возвращаем сервер в исходное состояние.
await call('/api/admin/config', {
  method: 'PATCH',
  body: { shotCooldownSeconds: 120, defenseCooldownMinutes: 60, ammoStart: 0, ammoMax: 3 },
  admin,
});
await call('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' }, admin });

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
