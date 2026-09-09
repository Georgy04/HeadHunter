// Выпуск пула: пятьдесят бейджей и сотня кодов за активности — один раз на все
// игры. Кладёт рядом три файла:
//
//   pool/pool.json    — из него сервер берёт набор при каждом сбросе игры
//   pool/badges.html  — лист бейджей для печати
//   pool/codes.html   — талоны с кодами для печати
//
// Запуск: node scripts/make-pool.mjs
//         node scripts/make-pool.mjs --badges=50 --codes=100 --points=500
//         node scripts/make-pool.mjs --html      (перерисовать листы из готового пула)
//         node scripts/make-pool.mjs --force     (выпустить пул заново, старая печать пропадёт)
//
// Повторный выпуск без --force запрещён: коды на распечатанной бумаге привязаны
// к этому файлу, и новый набор превратил бы стопку бейджей в мусор.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { generateEmblemSet, describeEmblem, EMBLEM_COMBINATIONS } from '../server/emblems.js';
import { badgeSheetHtml, codeSheetHtml } from '../server/print.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL_DIR = path.join(ROOT, 'pool');
const POOL_FILE = path.join(POOL_DIR, 'pool.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const TITLE = 'HeadHunter';
const badgeCount = value('badges', 50);
const codeCount = value('codes', 100);
const codePoints = value('points', 500);

// Тот же алфавит, что у сервера: без символов, которые путаются на бумаге.
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
function makeCode(length, taken) {
  for (;;) {
    let code = '';
    for (const byte of crypto.randomBytes(length)) code += ALPHABET[byte % ALPHABET.length];
    if (!taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
}

function build() {
  if (badgeCount < 1 || badgeCount > EMBLEM_COMBINATIONS) {
    throw new Error(`бейджей должно быть от 1 до ${EMBLEM_COMBINATIONS}`);
  }
  if (codeCount < 1 || codeCount > 500) throw new Error('кодов должно быть от 1 до 500');

  const taken = new Set();
  const badges = generateEmblemSet(badgeCount).map((emblem) => ({ code: makeCode(6, taken), emblem }));
  const codes = Array.from({ length: codeCount }, () => ({
    code: makeCode(5, taken),
    points: codePoints,
    grantsHint: true,
    maxUses: 1,
    note: 'активность',
  }));

  return { createdAt: new Date().toISOString(), badges, codes };
}

function writeSheets(pool) {
  const wifiLine =
    'Подключитесь к Wi-Fi площадки и откройте адрес игры. Игрок регистрируется, приложение показывает ему ' +
    'нужную эмблему — найдите бейдж по картинке или коду, отдайте и подтвердите выдачу в пульте. ' +
    'Эмблема должна быть на виду.';

  fs.writeFileSync(
    path.join(POOL_DIR, 'badges.html'),
    badgeSheetHtml({ slots: pool.badges, title: TITLE, hint: wifiLine }),
    'utf8'
  );
  fs.writeFileSync(path.join(POOL_DIR, 'codes.html'), codeSheetHtml({ codes: pool.codes, title: TITLE }), 'utf8');
}

const exists = fs.existsSync(POOL_FILE);

if (exists && !flag('force') && !flag('html')) {
  console.error(`Пул уже выпущен: ${POOL_FILE}`);
  console.error('Бейджи по нему, скорее всего, уже напечатаны, а новый набор дал бы другие коды.');
  console.error('Перерисовать листы для печати из готового пула: node scripts/make-pool.mjs --html');
  console.error('Выпустить пул заново и выбросить старую печать: node scripts/make-pool.mjs --force');
  process.exit(1);
}

fs.mkdirSync(POOL_DIR, { recursive: true });

let pool;
if (flag('html') && exists) {
  pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  console.log('Пул не тронут, перерисованы только листы для печати.');
} else {
  pool = build();
  fs.writeFileSync(POOL_FILE, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
  console.log(`Выпущен пул: бейджей ${pool.badges.length}, кодов ${pool.codes.length}.`);
}

writeSheets(pool);

const first = pool.badges[0];
console.log('');
console.log(`  ${POOL_FILE}`);
console.log(`  ${path.join(POOL_DIR, 'badges.html')}  — распечатать и разрезать`);
console.log(`  ${path.join(POOL_DIR, 'codes.html')}   — распечатать и разрезать`);
console.log('');
console.log(`  Первый бейдж для проверки: код ${first.code}, ${describeEmblem(first.emblem)}`);
console.log('  Сервер берёт этот набор сам при каждом сбросе игры — выпускать бейджи в пульте не нужно.');
