// Заготовленный пул: бейджи и коды за активности, выпущенные один раз и
// напечатанные заранее.
//
// Пул лежит в `pool/pool.json` и в репозитории — значит, он одинаков на всех
// машинах и переживает любой сброс игры. Каждая новая игра начинается с тех же
// пятидесяти бейджей и той же сотни кодов, что лежат в коробке на бумаге. Без
// этого напечатанный лист жил бы ровно до первого нажатия «Сбросить игру».
//
// Файла может не быть: тогда сервер работает как раньше, а набор выпускается в
// пульте. Сломанный файл тоже не должен ронять сервер за полчаса до игры —
// ошибку печатаем и идём дальше с пустым набором.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const POOL_FILE = path.join(ROOT, 'pool', 'pool.json');

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

function readPoolFile() {
  if (!fs.existsSync(POOL_FILE)) return null;
  const parsed = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  if (!Array.isArray(parsed.badges) || !Array.isArray(parsed.codes)) {
    throw new Error('в файле нет списков badges и codes');
  }
  return parsed;
}

/**
 * Читает пул и переводит его в то, что кладётся в состояние игры. Возвращает
 * `null`, если пула нет или он не читается: игра при этом остаётся рабочей,
 * просто набор придётся выпустить в пульте.
 */
export function loadPool() {
  let parsed;
  try {
    parsed = readPoolFile();
  } catch (err) {
    console.error(`[pool] ${POOL_FILE} не прочитан: ${err.message}`);
    console.error('[pool] игра запустится с пустым набором — выпустите бейджи в пульте.');
    return null;
  }
  if (!parsed) return null;

  const slots = parsed.badges.map((badge) => ({
    id: newId(),
    code: badge.code,
    emblem: badge.emblem,
    claimedBy: null,
    reservedBy: null,
  }));

  const codes = parsed.codes.map((entry) => ({
    code: entry.code,
    points: Math.round(Number(entry.points) || 0),
    grantsHint: entry.grantsHint !== false,
    maxUses: Math.max(1, Math.round(Number(entry.maxUses) || 1)),
    note: String(entry.note ?? '').slice(0, 60),
    usedBy: [],
    createdAt: Date.now(),
  }));

  return { slots, codes, createdAt: parsed.createdAt ?? null };
}
