import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';

import { state, save, saveSync, resetState, logEvent, ROOT, DEFAULT_CONFIG } from './store.js';
import {
  GameError,
  activePlayers,
  adjustScore,
  adminView,
  assignTarget,
  board,
  createCodes,
  createSlots,
  defend,
  emblemSvg,
  grantHint,
  issueBadge,
  loginWithPin,
  playerByToken,
  playerView,
  players,
  reassignBadge,
  redeemCode,
  registerPlayer,
  removePlayer,
  resetPin,
  setGameStatus,
  shoot,
  startGame,
} from './game.js';
import { generateNickname } from './nicknames.js';

// Проект переносится на другой ноутбук через git, поэтому версию рантайма
// проверяем сами: молчаливое падение на синтаксисе за полчаса до игры не нужно.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 20) {
  console.error(`HeadHunter needs Node.js 20 or newer, current is ${process.versions.node}.`);
  console.error('Install it from https://nodejs.org and run "npm start" again.');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const app = express();

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// На ноутбуке обычно висят ещё и VPN/Hyper-V адаптеры. Домашние подсети
// показываем первыми: именно на них зайдут телефоны.
function addressRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  if (ip.startsWith('10.')) return 2;
  return 3;
}

function subnetOf(address, netmask) {
  const ip = address.split('.').map(Number);
  const mask = String(netmask ?? '').split('.').map(Number);
  if (ip.length !== 4 || mask.length !== 4) return null;
  if ([...ip, ...mask].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const bits = mask.reduce((total, octet) => total + octet.toString(2).replaceAll('0', '').length, 0);
  return `${ip.map((octet, idx) => octet & mask[idx]).join('.')}/${bits}`;
}

// Адрес сам по себе не говорит, в какую сеть он ведёт: 192.168.0.13 и
// 192.168.0.100 могут оказаться двумя разными роутерами. Поэтому рядом с
// адресом носим имя адаптера и подсеть.
function lanInterfaces() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).map((info) => ({ ...info, name })))
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map(({ name, address, netmask }) => ({ name, address, subnet: subnetOf(address, netmask) }))
    .sort((a, b) => addressRank(a.address) - addressRank(b.address));
}

function lanAddresses() {
  return lanInterfaces().map((i) => i.address);
}

// Два адаптера в одной подсети — это почти всегда два разных роутера с
// одинаковым диапазоном (кабель в один, Wi-Fi в другой). Телефон достучится
// только до одного из адресов, и по виду адреса не угадать, до какого.
function subnetClashes(interfaces) {
  const bySubnet = new Map();
  for (const i of interfaces) {
    if (!i.subnet) continue;
    bySubnet.set(i.subnet, [...(bySubnet.get(i.subnet) ?? []), i.name]);
  }
  return [...bySubnet]
    .filter(([, names]) => names.length > 1)
    .map(([subnet, names]) => `${names.join(' + ')} — ${subnet}`);
}

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Пульт на ноутбуке-сервере часто открывают через localhost, а такой адрес в QR
// телефоны открыть не смогут. Для входа игроков всегда подставляем адрес в сети.
function joinUrl(req) {
  const hostname = (req.get('host') ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const [primary] = lanAddresses();
  if (!isLocal || !primary) return `${baseUrl(req)}/`;
  return `${req.protocol}://${primary}:${PORT}/`;
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof GameError) {
        res.status(err.status).json({ error: err.message, code: err.code });
      } else {
        console.error('[api]', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
      }
    }
  };
}

function requirePlayer(req) {
  const player = playerByToken(req.get('x-player-token') ?? req.query.token);
  if (!player) throw new GameError('Сессия не найдена, войдите заново', 401, 'no_session');
  return player;
}

function requireAdmin(req) {
  const token = req.get('x-admin-token') ?? req.query.token;
  if (!token || token !== state.adminToken) throw new GameError('Нужен токен ведущего', 401, 'no_admin');
}

// --- Игроки -----------------------------------------------------------------

app.get(
  '/api/nickname',
  handle((req, res) => {
    res.json({ nickname: generateNickname(new Set(players().map((p) => p.nickname))) });
  })
);

app.post(
  '/api/register',
  handle((req, res) => {
    const player = registerPlayer(req.body?.name, req.body?.nickname, req.body?.pin);
    res.json({ token: player.token, ...playerView(player) });
  })
);

// Вход по «имя + PIN»: токен живёт в одном браузере, а телефон могут почистить,
// потерять или сменить. Без этого вернуться в свой кабинет было бы нельзя.
app.post(
  '/api/login',
  handle((req, res) => {
    const player = loginWithPin(req.body?.name, req.body?.pin);
    res.json({ token: player.token, ...playerView(player) });
  })
);

app.get(
  '/api/me',
  handle((req, res) => res.json(playerView(requirePlayer(req))))
);

app.post(
  '/api/shoot',
  handle((req, res) => {
    const player = requirePlayer(req);
    const outcome = shoot(player, req.body?.playerId);
    res.json({ ...outcome, state: playerView(player) });
  })
);

app.post(
  '/api/defend',
  handle((req, res) => {
    const player = requirePlayer(req);
    const outcome = defend(player, req.body?.playerId);
    res.json({ ...outcome, state: playerView(player) });
  })
);

app.post(
  '/api/code',
  handle((req, res) => {
    const player = requirePlayer(req);
    const outcome = redeemCode(player, req.body?.code);
    res.json({ ...outcome, state: playerView(player) });
  })
);

app.post(
  '/api/inbox/read',
  handle((req, res) => {
    const player = requirePlayer(req);
    player.inbox.forEach((m) => {
      m.read = true;
    });
    save();
    res.json({ ok: true });
  })
);

app.get(
  '/api/board',
  handle((req, res) => res.json({ board: board(), status: state.game.status }))
);

// --- Ведущий ----------------------------------------------------------------

app.get(
  '/api/admin/state',
  handle((req, res) => {
    requireAdmin(req);
    res.json(adminView());
  })
);

app.post(
  '/api/admin/slots',
  handle((req, res) => {
    requireAdmin(req);
    const fresh = createSlots(Number(req.body?.count), { append: req.body?.append === true });
    res.json({ count: fresh.length, codes: fresh.map((s) => s.code) });
  })
);

app.post(
  '/api/admin/codes',
  handle((req, res) => {
    requireAdmin(req);
    const created = createCodes(req.body ?? {});
    res.json({ created: created.map((c) => c.code), ...adminView() });
  })
);

app.post(
  '/api/admin/game/:action',
  handle((req, res) => {
    requireAdmin(req);
    const { action } = req.params;
    if (action === 'start') startGame();
    else if (action === 'pause') setGameStatus('paused');
    else if (action === 'resume') setGameStatus('running');
    else if (action === 'finish') setGameStatus('finished');
    else if (action === 'reshuffle') {
      activePlayers().forEach((p) => assignTarget(p));
      logEvent('targets_reshuffled', {});
    } else throw new GameError('Неизвестное действие');
    res.json(adminView());
  })
);

app.post(
  '/api/admin/reset',
  handle((req, res) => {
    requireAdmin(req);
    if (req.body?.confirm !== 'RESET') throw new GameError('Для сброса нужно подтверждение');
    resetState();
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/player/:id/score',
  handle((req, res) => {
    requireAdmin(req);
    adjustScore(req.params.id, req.body?.delta, req.body?.reason);
    res.json(adminView());
  })
);

app.post(
  '/api/admin/player/:id/hint',
  handle((req, res) => {
    requireAdmin(req);
    const hint = grantHint(req.params.id);
    res.json({ hint, ...adminView() });
  })
);

// Ведущий отдал бейдж в руки — с этого момента человек в игре.
app.post(
  '/api/admin/player/:id/badge',
  handle((req, res) => {
    requireAdmin(req);
    const slot = issueBadge(req.params.id, req.body?.code);
    res.json({ code: slot.code, ...adminView() });
  })
);

app.post(
  '/api/admin/player/:id/badge/reassign',
  handle((req, res) => {
    requireAdmin(req);
    const slot = reassignBadge(req.params.id);
    res.json({ code: slot.code, ...adminView() });
  })
);

// Забытый PIN: ведущий выдаёт новый и называет его игроку лично.
app.post(
  '/api/admin/player/:id/pin/reset',
  handle((req, res) => {
    requireAdmin(req);
    const pin = resetPin(req.params.id);
    res.json({ pin, ...adminView() });
  })
);

app.post(
  '/api/admin/player/:id/retarget',
  handle((req, res) => {
    requireAdmin(req);
    const player = state.players[req.params.id];
    if (!player) throw new GameError('Игрок не найден', 404);
    assignTarget(player);
    res.json(adminView());
  })
);

app.delete(
  '/api/admin/player/:id',
  handle((req, res) => {
    requireAdmin(req);
    removePlayer(req.params.id);
    res.json(adminView());
  })
);

app.patch(
  '/api/admin/config',
  handle((req, res) => {
    requireAdmin(req);
    for (const [key, value] of Object.entries(req.body ?? {})) {
      if (!(key in DEFAULT_CONFIG)) continue;
      const current = DEFAULT_CONFIG[key];
      if (typeof current === 'number') {
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0) state.config[key] = Math.round(num);
      } else if (typeof current === 'boolean') {
        state.config[key] = value === true || value === 'true';
      } else {
        state.config[key] = String(value).slice(0, 60);
      }
    }
    save();
    res.json({ config: state.config });
  })
);

app.get(
  '/api/admin/join-qr',
  handle(async (req, res) => {
    requireAdmin(req);
    const url = joinUrl(req);
    res.json({
      url,
      dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 320 }),
      addresses: lanAddresses(),
      interfaces: lanInterfaces(),
      port: PORT,
    });
  })
);

// Лист бейджей для печати. Сканировать бейдж никому не нужно: эмблему назначает
// сервер при регистрации, а выдаёт ведущий. Код на бейдже — чтобы ведущий нашёл
// нужный в стопке. ?free=1 печатает только ещё не выданные — для допечатки.
app.get(
  '/print',
  handle((req, res) => {
    requireAdmin(req);
    const onlyFree = req.query.free === '1';
    const slots = onlyFree ? state.slots.filter((s) => !s.claimedBy) : state.slots;
    if (state.slots.length === 0) {
      res.status(400).send('Сначала создайте бейджи в админке.');
      return;
    }
    if (slots.length === 0) {
      res.status(400).send('Все бейджи уже выданы — печатать нечего.');
      return;
    }
    const cards = slots.map(
      (slot) => `<div class="badge">
            <div class="emblem">${emblemSvg(slot, { size: 190, flat: true })}</div>
            <div class="code">${slot.code}</div>
          </div>`
    );

    const wifi = state.config.wifiSsid
      ? `Wi-Fi: <b>${escapeHtml(state.config.wifiSsid)}</b>${
          state.config.wifiPassword ? ` &nbsp; пароль: <b>${escapeHtml(state.config.wifiPassword)}</b>` : ''
        }`
      : 'Подключитесь к Wi-Fi площадки и откройте адрес игры';

    res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<title>Бейджи — ${escapeHtml(state.config.eventTitle)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; color: #111; }
  .hint { padding: 8px 12px; background: #f2f3f5; font-size: 13px; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; padding: 6mm; }
  .badge { border: 1px dashed #bbb; border-radius: 10px; padding: 6mm 4mm 4mm; text-align: center; break-inside: avoid; }
  .emblem { line-height: 0; }
  .code { font: 600 15px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 2px; margin-top: 3mm; }
  @media print { .hint { display: none; } }
</style></head>
<body>
  <div class="hint">${wifi}. Игрок регистрируется, приложение показывает ему нужную эмблему — найдите бейдж по картинке или коду, отдайте и подтвердите выдачу в пульте. Эмблема должна быть на виду.</div>
  <div class="sheet">${cards.join('')}</div>
</body></html>`);
  })
);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

// Ведущий останавливает сервер закрытием окна, но окно теряется среди других, а
// искать процесс руками он не должен. PID пишем на диск — по нему stop.cmd
// находит сервер, а start.cmd замечает, что тот уже запущен.
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
let ownsPidFile = false;

function pidFromFile() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function claimPidFile() {
  // Чужую отметку не трогаем: затерев её, мы отняли бы у ведущего единственный
  // простой способ остановить работающий сервер.
  const running = pidFromFile();
  if (running && running !== process.pid && isAlive(running)) return;
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, `${process.pid}\n`);
    ownsPidFile = true;
  } catch (err) {
    console.error(`[server] could not write ${PID_FILE}: ${err.message}`);
  }
}

function releasePidFile() {
  if (!ownsPidFile) return;
  ownsPidFile = false;
  if (pidFromFile() !== process.pid) return;
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

// Порт проверяем до запуска. Windows успевает выдать событие «слушаю» раньше
// ошибки, и второй экземпляр печатает бодрый баннер, а сразу за ним — отказ.
// Ведущему такое читать незачем, поэтому спрашиваем порт заранее.
function portIsTaken(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (taken) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

if (await portIsTaken(PORT)) {
  console.error('');
  console.error(`  Port ${PORT} is already taken: HeadHunter is probably running already.`);
  console.error('  Stop the running one first: stop.cmd, or Ctrl+C in its window.');
  console.error('  Another port instead: PORT=8080 npm start.');
  console.error('');
  process.exit(1);
}

const server = app.listen(PORT, '0.0.0.0', async () => {
  const interfaces = lanInterfaces();
  const primary = interfaces[0]?.address ?? 'localhost';
  const url = `http://${primary}:${PORT}`;

  claimPidFile();

  console.log('');
  console.log('  HeadHunter server is running');
  console.log('  --------------------------------------------');
  interfaces.forEach((i) => console.log(`  players : http://${i.address}:${PORT}   [${i.name}]`));
  console.log(`  admin   : ${url}/admin?token=${state.adminToken}`);
  console.log(`  badges  : ${url}/print?token=${state.adminToken}`);
  console.log('  --------------------------------------------');
  if (interfaces.length > 1) {
    console.log(`  Links and the QR below use the first address: ${primary} [${interfaces[0].name}].`);
    console.log('  Phones must be in that same network, otherwise take the matching line above.');
    for (const clash of subnetClashes(interfaces)) {
      console.log('  --------------------------------------------');
      console.log(`  WARNING: two adapters share one address range: ${clash}`);
      console.log('  Those are two different networks that look alike, and phones see only one.');
      console.log('  Disconnect one of them and restart the server.');
    }
    console.log('  --------------------------------------------');
  }
  console.log('  Keep this window open: the server lives as long as it does.');
  if (process.platform === 'win32') {
    console.log('  To stop the game: press Ctrl+C, close this window or double-click stop.cmd.');
  } else {
    console.log('  To stop the game: press Ctrl+C or close this window.');
  }
  console.log('  --------------------------------------------');
  if (process.platform === 'win32') {
    console.log('  If phones cannot connect, allow the port through the firewall (run as admin):');
    console.log(`  netsh advfirewall firewall add rule name="HeadHunter" dir=in action=allow protocol=TCP localport=${PORT}`);
    console.log('  --------------------------------------------');
  }
  try {
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch {}
});

// Порт могли занять и в зазоре между проверкой и запуском — тогда сюда.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error('');
  console.error(`  Port ${PORT} is busy, someone took it just now.`);
  console.error('  Stop the other server and start again.');
  console.error('');
  process.exit(1);
});

process.on('exit', releasePidFile);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveSync();
    releasePidFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
