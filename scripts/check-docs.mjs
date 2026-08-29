// Сверка документации с кодом. Документы про API и настройки устаревают молча,
// поэтому расхождения ищет скрипт, а не читатель.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const problems = [];
const fail = (message) => problems.push(message);

// --- Маршруты описаны в docs/api.md ----------------------------------------

const serverSource = read('server/index.js');
const apiDoc = read('docs/api.md');

const routes = [...serverSource.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
  ([, method, route]) => `${method.toUpperCase()} ${route}`
);

if (routes.length === 0) fail('не удалось разобрать маршруты в server/index.js — сломался разбор');

for (const route of routes) {
  if (!apiDoc.includes(route)) fail(`маршрут ${route} не описан в docs/api.md`);
}

const documented = [...apiDoc.matchAll(/^### (GET|POST|PUT|PATCH|DELETE) (\S+)/gm)].map(
  ([, method, route]) => `${method} ${route}`
);

for (const route of documented) {
  if (!routes.includes(route)) fail(`docs/api.md описывает ${route}, которого нет в server/index.js`);
}

// --- Настройки описаны в docs/game-rules.md --------------------------------

const storeSource = read('server/store.js');
const rulesDoc = read('docs/game-rules.md');

const configBlock = storeSource.match(/DEFAULT_CONFIG = \{([\s\S]*?)\n\};/);
if (!configBlock) {
  fail('не удалось найти DEFAULT_CONFIG в server/store.js');
} else {
  const keys = [...configBlock[1].matchAll(/^\s{2}(\w+):/gm)].map(([, key]) => key);
  if (keys.length === 0) fail('не удалось разобрать ключи DEFAULT_CONFIG');
  for (const key of keys) {
    if (!rulesDoc.includes(`\`${key}\``)) fail(`настройка ${key} не описана в docs/game-rules.md`);
  }
}

// --- Ссылки между документами ведут в существующие файлы -------------------

const markdownFiles = [];
const collect = (dir) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) collect(rel);
    else if (entry.name.endsWith('.md')) markdownFiles.push(rel);
  }
};
collect('docs');
markdownFiles.push('README.md');

for (const file of markdownFiles) {
  const text = read(file);
  for (const [, label, href] of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = href.split('#')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(path.join(ROOT, file)), target);
    if (!fs.existsSync(resolved)) fail(`${file}: ссылка «${label}» ведёт в никуда (${href})`);
  }
}

// --- Журнал правок: индекс совпадает с файлами -----------------------------

const historyDir = path.join(ROOT, 'docs', 'history');
const historyIndex = read('docs/history/README.md');
const records = fs
  .readdirSync(historyDir)
  .filter((name) => /^\d{4}-.+\.md$/.test(name))
  .sort();

if (records.length === 0) fail('в docs/history нет ни одной записи');

for (const record of records) {
  if (!historyIndex.includes(record)) fail(`запись ${record} не внесена в индекс docs/history/README.md`);
}

for (const record of records) {
  const text = fs.readFileSync(path.join(historyDir, record), 'utf8');
  const number = record.slice(0, 4);
  if (!text.startsWith(`# ${Number(number)}.`) && !text.startsWith(`# ${number}.`)) {
    fail(`${record}: заголовок должен начинаться с номера ${number}`);
  }
  if (!/^- Статус: /m.test(text)) fail(`${record}: нет строки со статусом`);
  if (!/^## Почему$/m.test(text)) fail(`${record}: нет раздела «Почему»`);
}

// --- Итог ------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`Документация расходится с кодом (${problems.length}):\n`);
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

console.log(
  `Документация в порядке: маршрутов ${routes.length}, ` +
    `файлов ${markdownFiles.length}, записей в журнале ${records.length}.`
);
