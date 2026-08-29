// Эмблема игрока = внешняя фигура своего цвета + вписанная внутренняя фигура
// другого цвета. Ровно четыре атрибута, у каждого ровно три значения — это
// главное требование к набору: одна подсказка должна сужать круг втрое.
// 3^4 = 81 комбинация, любые три известных атрибута определяют четвёртый,
// поэтому на 30 игроках круг сужается как 30 -> 10 -> 3-4 -> 1.

export const OUTER_SHAPES = [
  { id: 'circle', name: 'круг', gender: 'm' },
  { id: 'square', name: 'квадрат', gender: 'm' },
  { id: 'triangle', name: 'треугольник', gender: 'm' },
];

export const INNER_SHAPES = [
  { id: 'circle', name: 'круг', gender: 'm' },
  { id: 'cross', name: 'крест', gender: 'm' },
  { id: 'star', name: 'звезда', gender: 'f' },
];

// Палитры внешнего и внутреннего цвета не пересекаются: иначе подсказка
// «цель носит алый» заставляла бы гадать, о каком из двух цветов речь.
export const OUTER_COLORS = [
  { id: 'crimson', name: 'алый', nameF: 'алая', hex: '#ff4d4d' },
  { id: 'azure', name: 'лазурный', nameF: 'лазурная', hex: '#38b6ff' },
  { id: 'gold', name: 'золотой', nameF: 'золотая', hex: '#ffc93f' },
];

export const INNER_COLORS = [
  { id: 'white', name: 'белый', nameF: 'белая', hex: '#f4f6fb' },
  { id: 'black', name: 'чёрный', nameF: 'чёрная', hex: '#15181f' },
  { id: 'lime', name: 'лаймовый', nameF: 'лаймовая', hex: '#7ee081' },
];

export const EMBLEM_COMBINATIONS = OUTER_SHAPES.length * INNER_SHAPES.length * OUTER_COLORS.length * INNER_COLORS.length;

const round = (n) => Math.round(n * 100) / 100;
const polygon = (points) => points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');

function starPolygon(cx, cy, outerR, innerR, points, rotationDeg) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = ((rotationDeg + (180 / points) * i) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function outerPath(shapeId) {
  switch (shapeId) {
    case 'circle':
      return '<circle cx="50" cy="50" r="46" />';
    case 'square':
      return '<rect x="7" y="7" width="86" height="86" rx="8" />';
    case 'triangle':
      return `<polygon points="${polygon([[50, 5], [95, 88], [5, 88]])}" />`;
    default:
      throw new Error(`Неизвестная внешняя фигура: ${shapeId}`);
  }
}

// У треугольника визуальный центр ниже геометрического, поэтому внутренняя
// фигура смещается вниз — иначе она вылезает за края.
const INNER_CENTER_Y = { circle: 50, square: 50, triangle: 58 };

function innerPath(shapeId, cy) {
  switch (shapeId) {
    case 'circle':
      return `<circle cx="50" cy="${cy}" r="17" />`;
    case 'cross':
      return `<path d="M44 ${cy - 20} h12 v8 h8 v12 h-8 v8 h-12 v-8 h-8 v-12 h8 z" />`;
    case 'star':
      return `<polygon points="${polygon(starPolygon(50, cy, 20, 8.5, 5, -90))}" />`;
    default:
      throw new Error(`Неизвестная внутренняя фигура: ${shapeId}`);
  }
}

const find = (list, id) => list.find((item) => item.id === id) ?? list[0];
export const outerShapeById = (id) => find(OUTER_SHAPES, id);
export const innerShapeById = (id) => find(INNER_SHAPES, id);
export const outerColorById = (id) => find(OUTER_COLORS, id);
export const innerColorById = (id) => find(INNER_COLORS, id);

const colorName = (color, gender) => (gender === 'f' ? color.nameF : color.name);

export function describeEmblem(spec) {
  const outer = outerShapeById(spec.outer);
  const inner = innerShapeById(spec.inner);
  return `${colorName(outerColorById(spec.outerColor), outer.gender)} ${outer.name}, внутри ${colorName(
    innerColorById(spec.innerColor),
    inner.gender
  )} ${inner.name}`;
}

/**
 * Рендерит эмблему в самодостаточный SVG.
 * Тонкая тёмная обводка отделяет внутреннюю фигуру от внешней: без неё
 * белое на золотом сливается и на экране, и на бумаге.
 */
export function renderEmblem(spec, options = {}) {
  const { size = 120, flat = false } = options;
  const stroke = flat ? '#1b1b1b' : '#0d0f14';
  const cy = INNER_CENTER_Y[spec.outer] ?? 50;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img">`,
    `<g fill="${outerColorById(spec.outerColor).hex}" stroke="${stroke}" stroke-width="2">${outerPath(spec.outer)}</g>`,
    `<g fill="${innerColorById(spec.innerColor).hex}" stroke="${stroke}" stroke-width="2">${innerPath(spec.inner, cy)}</g>`,
    '</svg>',
  ].join('');
}

// --- Подсказки ---------------------------------------------------------------

// По одной подсказке на атрибут. Каждая режет круг втрое, три подсказки
// оставляют одного человека, четвёртая — контрольная.
export const HINT_IDS = ['outer', 'outerColor', 'inner', 'innerColor'];

export function hintText(spec, hintId) {
  switch (hintId) {
    case 'outer':
      return `Внешняя фигура цели — ${outerShapeById(spec.outer).name}.`;
    case 'inner':
      return `Внутренняя фигура цели — ${innerShapeById(spec.inner).name}.`;
    case 'outerColor':
      return `Внешний цвет цели — ${outerColorById(spec.outerColor).name}.`;
    case 'innerColor':
      return `Внутренний цвет цели — ${innerColorById(spec.innerColor).name}.`;
    default:
      return 'Подсказка потерялась.';
  }
}

export function shuffle(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const newHintOrder = () => shuffle(HINT_IDS);

/**
 * Набор из n эмблем. Атрибуты раскладываются по разрядам троичного счётчика,
 * а четвёртый берётся как сумма первых трёх по модулю 3. Это даёт две вещи:
 * все комбинации уникальны и каждое значение каждого атрибута встречается
 * примерно у трети игроков — иначе подсказка сужала бы круг непредсказуемо.
 *
 * offset — сколько эмблем уже выпущено. Продолжение того же счётчика позволяет
 * допечатать бейджи по ходу игры, не задев уже выданные и не сбив баланс.
 */
export function generateEmblemSet(n, offset = 0) {
  if (offset + n > EMBLEM_COMBINATIONS) {
    const left = Math.max(0, EMBLEM_COMBINATIONS - offset);
    throw new Error(
      left === 0
        ? `Все ${EMBLEM_COMBINATIONS} эмблем уже выпущены — больше набор атрибутов не даёт`
        : `Свободных эмблем осталось ${left} из ${EMBLEM_COMBINATIONS}`
    );
  }

  const specs = [];
  for (let i = offset; i < offset + n; i++) {
    const outer = i % 3;
    const inner = Math.floor(i / 3) % 3;
    const outerColor = Math.floor(i / 9) % 3;
    const layer = Math.floor(i / 27);
    const innerColor = (outer + inner + outerColor + layer) % 3;

    specs.push({
      outer: OUTER_SHAPES[outer].id,
      inner: INNER_SHAPES[inner].id,
      outerColor: OUTER_COLORS[outerColor].id,
      innerColor: INNER_COLORS[innerColor].id,
    });
  }
  // Порядок печати не должен намекать на структуру набора.
  return shuffle(specs);
}
