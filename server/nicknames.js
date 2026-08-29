// Никнеймы намеренно бессмысленные и не связаны с внешностью или полом игрока:
// по нику нельзя догадаться, кто это, — в этом весь смысл игры.

const ADJECTIVES = [
  'Тихий', 'Ржавый', 'Полночный', 'Бледный', 'Хмурый', 'Быстрый', 'Стеклянный', 'Бархатный',
  'Дерзкий', 'Мятный', 'Пепельный', 'Латунный', 'Северный', 'Кривой', 'Вежливый', 'Голодный',
  'Мраморный', 'Дымный', 'Пыльный', 'Лунный', 'Пряный', 'Сонный', 'Рыжий', 'Острый',
  'Чугунный', 'Праздный', 'Наглый', 'Тёплый', 'Колючий', 'Бумажный',
];

const NOUNS = [
  'Ворон', 'Компас', 'Фонарь', 'Кактус', 'Тритон', 'Барсук', 'Пельмень', 'Метроном',
  'Мотылёк', 'Ключ', 'Пингвин', 'Кашалот', 'Гвоздь', 'Самовар', 'Скворец', 'Осьминог',
  'Чемодан', 'Аккордеон', 'Кузнечик', 'Бублик', 'Тапок', 'Валенок', 'Патефон', 'Шершень',
  'Утюг', 'Носорог', 'Пряник', 'Циркуль', 'Барабан', 'Филин',
];

export function generateNickname(taken = new Set()) {
  // Пока хватает свободных существительных, каждому игроку достаётся своё:
  // «Сонный Циркуль» и «Северный Циркуль» в одной игре путали бы охотников.
  const usedNouns = new Set([...taken].map((n) => n.split(' ').pop()));
  const usedAdjectives = new Set([...taken].map((n) => n.split(' ')[0]));
  const nouns = NOUNS.filter((n) => !usedNouns.has(n));
  const adjectives = ADJECTIVES.filter((a) => !usedAdjectives.has(a));

  const nounPool = nouns.length > 0 ? nouns : NOUNS;
  const adjectivePool = adjectives.length > 0 ? adjectives : ADJECTIVES;

  const total = ADJECTIVES.length * NOUNS.length;
  for (let attempt = 0; attempt < total; attempt++) {
    const nickname = `${pick(adjectivePool)} ${pick(nounPool)}`;
    if (!taken.has(nickname)) return nickname;
  }
  // Комбинации кончились (900 штук) — добавляем номер, чтобы игра не встала.
  let suffix = 2;
  while (taken.has(`${ADJECTIVES[0]} ${NOUNS[0]} ${suffix}`)) suffix++;
  return `${ADJECTIVES[0]} ${NOUNS[0]} ${suffix}`;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
