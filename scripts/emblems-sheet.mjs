// Справочник эмблем: все комбинации с теми же описаниями, которые видит игрок.
// Нужен, чтобы посмотреть набор глазами и решить, сколько бейджей печатать, не
// заводя игру. Состояние игры не читается и не меняется — это картинка, а не
// лист печати: кодов бейджей здесь нет, они появляются, когда набор создан в
// пульте. Запуск: node scripts/emblems-sheet.mjs [сколько]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateEmblemSet, renderEmblem, describeEmblem, EMBLEM_COMBINATIONS } from '../server/emblems.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'preview');
const OUT_FILE = path.join(OUT_DIR, 'emblems.html');

const asked = Number(process.argv[2] ?? 50);
const count = Math.min(Math.max(Number.isFinite(asked) ? asked : 50, 1), EMBLEM_COMBINATIONS);
const set = generateEmblemSet(count);

const cards = set
  .map(
    (spec, index) => `<figure>
      <div class="art">${renderEmblem(spec, { size: 150, flat: true })}</div>
      <figcaption><b>${index + 1}</b><br />${describeEmblem(spec)}</figcaption>
    </figure>`
  )
  .join('');

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Эмблемы HeadHunter — ${count} из ${EMBLEM_COMBINATIONS}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; margin: 0; padding: 24px; background: #fff; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: 1px; text-transform: uppercase; }
  p.note { margin: 0 0 20px; color: #555; font-size: 13px; max-width: 900px; }
  .sheet { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; }
  figure { margin: 0; border: 1px solid #ccc; padding: 10px 6px; text-align: center; break-inside: avoid; }
  .art { line-height: 0; }
  figcaption { margin-top: 8px; font-size: 12px; color: #333; line-height: 1.35; }
  figcaption b { font-size: 13px; color: #000; }
  @page { size: A4 landscape; margin: 8mm; }
</style></head>
<body>
  <h1>Эмблемы HeadHunter</h1>
  <p class="note">
    Первые ${count} эмблем из ${EMBLEM_COMBINATIONS} возможных — в том порядке, в котором их выдаёт сервер
    при создании набора бейджей. Подпись под каждой — ровно тот текст, который игрок видит про свою
    эмблему. Кодов бейджей здесь нет: для игры печатается лист из пульта, а это справочник.
  </p>
  <div class="sheet">${cards}</div>
</body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log(`Эмблем в файле: ${set.length} из ${EMBLEM_COMBINATIONS}.`);
console.log(`Откройте в браузере: ${OUT_FILE}`);
