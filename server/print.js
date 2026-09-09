// Листы для печати: бейджи и коды за активности.
//
// Шаблон один на два места. Сервер печатает то, что сейчас в игре (`/print`), а
// `scripts/make-pool.mjs` — те же листы из заготовленного пула, ещё до всякой
// игры. Разъехаться им нельзя: коды на бумаге и коды в игре должны совпадать
// символ в символ, иначе бейдж в руках ведущего не найдётся в пульте.
import { renderEmblem } from './emblems.js';

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Бейджи печатаются на бумаге, поэтому вестерн здесь чёрным по белому: рамка
// плаката и капитель, без заливок, которые съедают тонер.
const SHEET_STYLE = `
  @page { size: A4; margin: 10mm; }
  body { font-family: Georgia, 'Times New Roman', serif; margin: 0; color: #111; }
  .hint { padding: 8px 12px; background: #f2f3f5; font-size: 13px; }
  .sheet { display: grid; gap: 6mm; padding: 6mm; }
  @media print { .hint { display: none; } }
`;

/**
 * Лист бейджей: эмблема и код текстом. Код нужен только ведущему, чтобы найти
 * нужный бейдж в стопке, — сканировать его никто не будет.
 */
export function badgeSheetHtml({ slots, title, hint }) {
  const cards = slots.map(
    (slot) => `<div class="badge">
            <div class="banner">Разыскивается</div>
            <div class="emblem">${renderEmblem(slot.emblem, { size: 190, flat: true })}</div>
            <div class="code">${escapeHtml(slot.code)}</div>
          </div>`
  );

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Бейджи — ${escapeHtml(title)}</title>
<style>${SHEET_STYLE}
  .sheet { grid-template-columns: repeat(3, 1fr); }
  .badge {
    border: 2px solid #111;
    box-shadow: inset 0 0 0 1.2mm #fff, inset 0 0 0 1.6mm #111;
    padding: 5mm 4mm 4mm;
    text-align: center;
    break-inside: avoid;
  }
  .banner { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 2mm; }
  .emblem { line-height: 0; }
  .code { font: 600 15px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 2px; margin-top: 3mm; }
</style></head>
<body>
  <div class="hint">${hint}</div>
  <div class="sheet">${cards.join('')}</div>
</body></html>`;
}

const codeGift = (entry) => {
  const parts = [];
  if (entry.grantsHint) parts.push('подсказка о цели');
  if (entry.points) parts.push(`${entry.points > 0 ? '+' : ''}${entry.points} очков`);
  if (parts.length === 0) parts.push('без награды');
  const uses = entry.maxUses > 1 ? ` · на ${entry.maxUses} чел.` : '';
  return `${parts.join(' · ')}${uses}`;
};

/**
 * Лист кодов за активности: талоны под ножницы. Ведущий отдаёт талон тому, кто
 * выиграл конкурс, а тот вводит код в приложении. Что даёт код, написано прямо
 * на талоне: спрашивать ведущего в шуме площадки неудобно.
 */
export function codeSheetHtml({ codes, title }) {
  const tickets = codes.map(
    (entry) => `<div class="ticket">
            <div class="banner">За активность</div>
            <div class="code">${escapeHtml(entry.code)}</div>
            <div class="gift">${escapeHtml(codeGift(entry))}</div>
          </div>`
  );

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Коды за активности — ${escapeHtml(title)}</title>
<style>${SHEET_STYLE}
  .sheet { grid-template-columns: repeat(4, 1fr); gap: 4mm; }
  .ticket {
    border: 1.5px dashed #111;
    padding: 4mm 3mm;
    text-align: center;
    break-inside: avoid;
  }
  .banner { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #444; }
  .code { font: 700 22px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 3px; margin: 2mm 0 1.5mm; }
  .gift { font-size: 11px; color: #333; }
</style></head>
<body>
  <div class="hint">
    Разрежьте по пунктиру. Талон отдаётся тому, кто выиграл активность: он вводит код в приложении и
    получает написанное. Каждый код срабатывает столько раз, сколько указано на талоне, — обычно один.
  </div>
  <div class="sheet">${tickets.join('')}</div>
</body></html>`;
}
