// ============================================================
// ZOMA BINGO — Telegram Mini App Server
// Updated: 2026-10-11 — Four Corners pattern added
// ============================================================

console.log("🔥 ZOMA BINGO SERVER 2026-10-11");

import express from "express";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import rateLimit from "express-rate-limit";
import { Bot, InlineKeyboard } from "grammy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_TG_ID = String(process.env.ADMIN_TG_ID || "");
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || BOT_TOKEN;
const SMS_SECRET = process.env.SMS_SECRET || "change-me-please";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "zoma-admin-2026";

const CARD_PRICE = Number(process.env.CARD_PRICE || 10);
const HOUSE_CUT = Number(process.env.HOUSE_CUT ?? 0.10);
const TOTAL_CARDS = 500;
const MAX_CARDS_PER_PLAYER = 4;
const MIN_PLAYERS_TO_START = 2;
const LOBBY_COUNTDOWN = Number(process.env.ROUND_COUNTDOWN || 30);
const CALL_INTERVAL_MS = Number(process.env.CALL_INTERVAL_MS || 3500);
const WINNER_POPUP_SECONDS = Number(process.env.WINNER_POPUP_SECONDS || 3);
const WELCOME_BONUS = Number(process.env.WELCOME_BONUS || 100);
const BOT_COUNT = Number(process.env.BOT_COUNT || 100);
const BOT_BALANCE = Number(process.env.BOT_BALANCE || 10000);
const TB_NUMBER = process.env.TB_NUMBER || "0982372677";
const TB_NAME = process.env.TB_NAME || "Zoma Bingo";
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 10);
const MAX_DEPOSIT = Number(process.env.MAX_DEPOSIT || 50000);
const MIN_DEPOSIT_FOR_WITHDRAWAL = Number(process.env.MIN_DEPOSIT_FOR_WITHDRAWAL || 100);

const REFERRAL_BONUS_INVITER = Number(process.env.REFERRAL_BONUS_INVITER || 20);
const BOT_USERNAME = process.env.BOT_USERNAME || "Biinnngobot";

const TB_RECEIVER_NAME = String(process.env.TB_RECEIVER_NAME || "helen yohaness bitew").trim().toLowerCase();

// ============================================================
// BOT NAMES
// ============================================================

const FIRST_NAMES = [
  "Abebe","Sara","Dawit","Hanna","Yonas","Marta","Bereket","Selam","Kebede","Meron",
  "Tesfaye","Rahel","Girma","Liya","Samuel","Bethel","Nahom","Eden","Mikias","Tsion",
  "Eyob","Feven","Natnael","Beza","Henok","Mimi","Kaleab","Rediet","Biruk","Selamawit",
  "Firaol","Sofia","Dagmawi","Mahlet","Yosef","Ruth","Solomon","Genet","Amanuel","Hiwot",
  "Binyam","Tigist","Ermias","Aster","Biniam","Almaz","Temesgen","Zewditu","Daniel","Kidist",
  "Elias","Helen","Getachew","Meseret","Mulugeta","Saba","Tewodros","Bethlehem","Abraham","Yeshi",
  "Yohannes","Tsehay","Fikru","Alem","Tadesse","Fikirte","Alemayehu","Aynalem","Dereje","Sindu",
  "Bekele","Wubit","Ayele","Emebet","Habtamu","Tizita","Endale","Bezawit","Chala","Mulu",
  "Guta","Eyerusalem","Lemma","Ebisa","Kenenisa","Beamlak","Tolosa","Derartu","Haile","Almitu",
  "Mekonnen","Chaltu","Wondimu","Bontu","Gadisa","Ejigayehu","Obsa","Rukiya","Tariku","Feyisa",
  "Lelisa","Senay","Mosisa","Gemechu","Kuulani","Robel","Nardos","Abdi","Iman","Mustafa","Halima"
];
const LAST_INITIALS = ["A","B","T","M","G","K","H","D","S","Y","W","N","F","R","L","Z","E","C","O","J"];

function pickBotName(i) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_INITIALS[Math.floor(i / FIRST_NAMES.length) % LAST_INITIALS.length];
  return `${first} ${last}.`;
}

// ============================================================
// TELEGRAM AUTH
// ============================================================

function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate) return null;
    if (Math.floor(Date.now() / 1000) - authDate > 86400) return null;
    params.delete("hash");
    const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    const userRaw = params.get("user");
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    user.start_param = params.get("start_param") || null;
    return user;
  } catch { return null; }
}

function extractInitData(req) {
  return req.headers["x-init"] || req.headers["x-telegram-init-data"] || req.body?.initData || req.query?.initData || null;
}

// ============================================================
// TELEGRAM NOTIFY
// ============================================================

async function tgNotify(chatId, text) {
  if (!ADMIN_BOT_TOKEN || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await res.json();
    if (!j.ok) console.error(`❌ tgNotify failed for ${chatId}:`, j.description);
  } catch (e) { console.error("❌ tgNotify error:", e.message); }
}

// ============================================================
// ENSURE USER (with referral) + AUTH
// ============================================================

async function ensureUser(tgUser, startParam) {
  const existing = await pool.query(`SELECT telegram_id, balance FROM users WHERE telegram_id = $1`, [tgUser.id]);

  if (existing.rows.length) {
    await pool.query(
      `UPDATE users SET username=$1, first_name=$2, last_name=$3, updated_at=NOW() WHERE telegram_id=$4`,
      [tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.id]
    );
    return { isNew: false, balance: Number(existing.rows[0].balance) };
  }

  let referrerId = null;
  if (startParam && startParam.startsWith("ref_")) {
    const candidate = Number(startParam.slice(4));
    if (Number.isInteger(candidate) && candidate > 0 && candidate !== tgUser.id) {
      const r = await pool.query(`SELECT telegram_id FROM users WHERE telegram_id=$1`, [candidate]);
      if (r.rows.length) referrerId = candidate;
    }
  }

  const inserted = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, balance, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING balance`,
    [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, WELCOME_BONUS, referrerId]
  );

  if (WELCOME_BONUS > 0) {
    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, note)
       VALUES ($1, 'welcome_bonus', $2, 'completed', 'Welcome bonus')`,
      [tgUser.id, WELCOME_BONUS]
    );
  }

  if (referrerId && REFERRAL_BONUS_INVITER > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE users SET balance=balance+$1, updated_at=NOW() WHERE telegram_id=$2`, [REFERRAL_BONUS_INVITER, referrerId]);
      await client.query(
        `INSERT INTO transactions (telegram_id, type, amount, status, note)
         VALUES ($1, 'referral', $2, 'completed', $3)`,
        [referrerId, REFERRAL_BONUS_INVITER, `Friend joined: ${tgUser.first_name || tgUser.id}`]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("referral credit:", e);
    } finally { client.release(); }

    await tgNotify(referrerId,
      `🎉 <b>Your friend joined!</b>\n\n` +
      `You earned <b>+${REFERRAL_BONUS_INVITER} birr</b> for inviting ` +
      `${tgUser.first_name || "a new player"}.\n\n` +
      `Keep inviting for more bonuses!`
    );
  }

  console.log(`🎁 New user ${tgUser.id}${referrerId ? ` (referred by ${referrerId})` : ""}`);
  return { isNew: true, balance: Number(inserted.rows[0].balance) };
}

async function authMiddleware(req, res, next) {
  try {
    const tgUser = validateInitData(extractInitData(req));
    if (!tgUser) return res.status(401).json({ error: "Invalid Telegram Mini App authentication" });
    req.tgUser = tgUser;
    const { isNew } = await ensureUser(tgUser, tgUser.start_param);
    req.isNewUser = isNew;
    next();
  } catch (err) {
    console.error("auth middleware:", err);
    res.status(500).json({ error: "Auth error" });
  }
}

// ============================================================
// EXPRESS
// ============================================================

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

let startupReady = false;

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true, ready: startupReady,
    uptime: Math.floor(process.uptime()),
    game: game?.phase || "starting",
    bots: BOT_COUNT
  });
});

const apiLimiter = rateLimit({ windowMs: 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use("/api", apiLimiter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ============================================================
// POSTGRES
// ============================================================

if (!DATABASE_URL) console.error("❌ DATABASE_URL missing");
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing");
if (!ADMIN_TG_ID) console.warn("⚠️ ADMIN_TG_ID missing");

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", (err) => console.error("pg pool:", err));

async function initDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE NOT NULL, username TEXT, first_name TEXT, last_name TEXT, balance NUMERIC(18,2) NOT NULL DEFAULT 0, is_bot BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, type TEXT NOT NULL, amount NUMERIC(18,2) NOT NULL, status TEXT NOT NULL DEFAULT 'pending', tx_id TEXT, phone TEXT, note TEXT, auto BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note TEXT;`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_tx_id_unique ON transactions (tx_id) WHERE tx_id IS NOT NULL;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS promo_codes (code TEXT PRIMARY KEY, amount NUMERIC(18,2) NOT NULL, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS promo_redemptions (id SERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, code TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(telegram_id, code));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rounds (id SERIAL PRIMARY KEY, round_number INTEGER NOT NULL, phase TEXT NOT NULL, drawn INTEGER[] NOT NULL DEFAULT '{}', winner_names TEXT[], winner_card INTEGER, prize NUMERIC(18,2) NOT NULL DEFAULT 0, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ);`);

  const pc = await pool.query(`SELECT COUNT(*)::int AS n FROM promo_codes`);
  if (pc.rows[0].n === 0) {
    await pool.query(`INSERT INTO promo_codes (code, amount, max_uses) VALUES ('WELCOME20',20,1000),('ZOMA50',50,500),('BINGO100',100,200) ON CONFLICT (code) DO NOTHING;`);
    console.log("🎟️  Seeded default promo codes");
  }
  console.log("✅ Database initialized");
}

// ============================================================
// BOT SEEDING
// ============================================================

const BOT_ID_BASE = 9000000000000;

async function seedBots() {
  const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE is_bot = TRUE`);
  if (existing.rows[0].n >= BOT_COUNT) {
    console.log(`✅ ${existing.rows[0].n} bots already in DB — skipping seed`);
    return;
  }
  console.log(`🤖 Seeding ${BOT_COUNT} bots (bulk insert)…`);
  const values = [], params = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, TRUE)`);
    params.push(BOT_ID_BASE + i, null, pickBotName(i), BOT_BALANCE);
  }
  await pool.query(`INSERT INTO users (telegram_id, username, first_name, balance, is_bot) VALUES ${values.join(",")} ON CONFLICT (telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name, balance = EXCLUDED.balance, is_bot = TRUE, updated_at = NOW()`, params);
  console.log(`✅ ${BOT_COUNT} named bots ready (each ${BOT_BALANCE} birr)`);
}

// ============================================================
// CARD LOGIC
// ============================================================

function seeded(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cardFor(no) {
  const r = seeded(((no * 2654435761) >>> 0) ^ 0x9e3779b9);
  const cols = [0,1,2,3,4].map((c) => {
    const a = Array.from({ length: 15 }, (_, i) => c * 15 + i + 1);
    for (let i = 14; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, 5);
  });
  const card = [0,1,2,3,4].map((row) => cols.map((c) => c[row]));
  card[2][2] = 0;
  return card;
}

// ============================================================
// GAME STATE
// ============================================================

const game = {
  phase: "lobby", countdown: null, drawn: [], drawnSet: new Set(), prize: 0,
  players: new Map(), cards: new Map(), pendingCards: new Set(), bots: [],
  winner: null, lobbyTimer: null, callTimer: null, endTimer: null, botSetup: false
};

function drawnPrize() { return Math.max(0, Math.floor(game.cards.size * CARD_PRICE * (1 - HOUSE_CUT))); }

function publicState(forTgId) {
  const cardsForUser = [];
  for (const entry of game.cards.values()) {
    if (String(entry.owner) === String(forTgId)) cardsForUser.push({ no: entry.cardNo, card: cardFor(entry.cardNo) });
  }
  const taken = [...new Set([...game.cards.values()].map(e => e.cardNo).concat([...game.pendingCards]))];
  const winnerPayload = game.winner ? { names: game.winner.names, prize: game.winner.prize, card: game.winner.card, you: game.winner.tgId === forTgId } : null;
  return {
    type: "state", phase: game.phase, countdown: game.countdown, drawn: game.drawn,
    prize: drawnPrize(), players: [...game.players.values()].filter(p => !p.isBot).length,
    bots: game.bots.length, taken, max: MAX_CARDS_PER_PLAYER, price: CARD_PRICE,
    cards: cardsForUser, winner: winnerPayload
  };
}

function sendState() {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(publicState(ws.tgId))); } catch {} }
  }
}

function broadcastWinnerPopup(payload) {
  const msg = JSON.stringify({ type: "winner_popup", ...payload });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
  }
}

// ============================================================
// GAME LOOP
// ============================================================

async function startLobby() {
  clearTimers();
  game.phase = "lobby"; game.countdown = null; game.drawn = []; game.drawnSet = new Set();
  game.cards.clear(); game.pendingCards.clear(); game.bots = []; game.winner = null; game.prize = 0;
  game.botSetup = true; sendState();
  try { await addBots(); } catch (err) { console.error("bot lobby setup:", err); }
  finally { game.botSetup = false; }
  sendState();
  if (game.phase === "lobby" && !game.lobbyTimer) startCountdown();
}

function startCountdown() {
  if (game.phase !== "lobby" || game.botSetup || game.lobbyTimer) return;
  game.countdown = LOBBY_COUNTDOWN;
  sendState();
  game.lobbyTimer = setInterval(() => {
    game.countdown -= 1;
    if (game.countdown <= 0) { clearInterval(game.lobbyTimer); game.lobbyTimer = null; startRound(); return; }
    sendState();
  }, 1000);
}

async function addBots() {
  game.bots = [];
  const taken = new Set([...game.cards.values()].map(e => e.cardNo));
  const updates = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const botTgId = BOT_ID_BASE + i, botName = pickBotName(i), botCards = [];
    const nCards = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < nCards; k++) {
      let n = 0, attempts = 0;
      do { n = 1 + Math.floor(Math.random() * TOTAL_CARDS); attempts++; }
      while ((taken.has(n) || game.pendingCards.has(n) || botCards.includes(n)) && attempts < 2000);
      if (taken.has(n) || game.pendingCards.has(n) || botCards.includes(n)) break;
      botCards.push(n); taken.add(n);
      game.cards.set(`${botTgId}:${n}`, { cardNo: n, owner: botTgId });
    }
    game.bots.push({ id: i, tgId: botTgId, names: [botName], cards: botCards });
    if (botCards.length) updates.push([botCards.length * CARD_PRICE, botTgId]);
  }
  if (updates.length) {
    try {
      const values = [], params = [];
      updates.forEach(([cost, id], i) => { const b = i * 2; values.push(`($${b + 1}::numeric, $${b + 2}::bigint)`); params.push(cost, id); });
      await pool.query(`UPDATE users SET balance = GREATEST(0, balance - v.cost), updated_at = NOW() FROM (VALUES ${values.join(",")}) AS v(cost, id) WHERE users.telegram_id = v.id`, params);
    } catch (err) { console.error("bot card purchase bulk:", err.message); }
  }
}

async function startRound() {
  if (game.phase === "playing" || game.phase === "over") return;
  game.phase = "playing"; game.countdown = null; sendState();
  try {
    await pool.query(`INSERT INTO rounds (round_number, phase, drawn, prize) VALUES ((SELECT COALESCE(MAX(round_number),0)+1 FROM rounds), 'playing', $1, $2)`, [game.drawn, drawnPrize()]);
  } catch (err) { console.error("round insert:", err); }
  game.callTimer = setInterval(callNext, CALL_INTERVAL_MS);
  setTimeout(callNext, 1500);
}

function callNext() {
  if (game.phase !== "playing") return;
  const remaining = [];
  for (let n = 1; n <= 75; n++) if (!game.drawnSet.has(n)) remaining.push(n);
  if (!remaining.length) return finishRound(null);
  const n = remaining[Math.floor(Math.random() * remaining.length)];
  game.drawn.push(n); game.drawnSet.add(n);
  const winners = findWinners();
  if (winners.length) return finishRound(winners);
  sendState();
}

// ============================================================
// WINNING PATTERN — includes Four Corners
// ============================================================

function winningPattern(card, drawnSet) {
  const marked = card.map(row => row.map(n => n === 0 || drawnSet.has(n)));
  for (let r = 0; r < 5; r++) if (marked[r].every(Boolean)) return `Row ${r + 1}`;
  for (let c = 0; c < 5; c++) if (marked.every(row => row[c])) return `Column ${c + 1}`;
  if ([0,1,2,3,4].every(i => marked[i][i])) return "Diagonal ↘";
  if ([0,1,2,3,4].every(i => marked[i][4-i])) return "Diagonal ↙";
  // Four Corners — all 4 outer corners marked
  if (marked[0][0] && marked[0][4] && marked[4][0] && marked[4][4]) return "Four Corners";
  return null;
}

function findWinners() {
  const found = [];
  for (const entry of game.cards.values()) {
    const pattern = winningPattern(cardFor(entry.cardNo), game.drawnSet);
    if (!pattern) continue;
    const ownerNum = Number(entry.owner), isBot = ownerNum >= BOT_ID_BASE;
    const bot = isBot ? game.bots.find(b => b.tgId === ownerNum) : null;
    const player = game.players.get(ownerNum);
    found.push({ names: isBot ? (bot ? bot.names : [pickBotName(ownerNum - BOT_ID_BASE)]) : (player ? player.names : ["Player"]), card: entry.cardNo, tgId: ownerNum, owner: entry.owner, pattern, isBot });
  }
  const seen = new Set();
  return found.filter(w => { const k = String(w.owner); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function finishRound(winners) {
  clearInterval(game.callTimer); game.callTimer = null; game.phase = "over";
  const allWinners = Array.isArray(winners) ? winners : (winners ? [winners] : []);
  const poolPrize = drawnPrize();
  const share = allWinners.length ? Math.floor((poolPrize / allWinners.length) * 100) / 100 : 0;
  game.winner = allWinners.length ? {
    names: allWinners.flatMap(w => w.names), card: allWinners[0].card, prize: poolPrize,
    winners: allWinners.map(w => ({ names: w.names, card: w.card, pattern: w.pattern, prize: share, isBot: w.isBot })),
    tgId: null
  } : null;
  for (const winner of allWinners) if (winner.tgId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE users SET balance=balance+$1, updated_at=NOW() WHERE telegram_id=$2`, [share, winner.tgId]);
      await client.query(`INSERT INTO transactions (telegram_id, type, amount, status) VALUES ($1,'win',$2,'completed')`, [winner.tgId, share]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); console.error("payout:", e); }
    finally { client.release(); }
  }
  broadcastWinnerPopup({
    winners: allWinners.map(w => ({ names: w.names, cardNo: w.card, prize: share, pattern: w.pattern, isBot: w.isBot, card: cardFor(w.card) })),
    names: allWinners.flatMap(w => w.names), cardNo: allWinners[0]?.card ?? null, prize: poolPrize,
    isBot: allWinners.length > 0 && allWinners.every(w => w.isBot),
    card: allWinners[0] ? cardFor(allWinners[0].card) : null, drawn: game.drawn,
    duration: WINNER_POPUP_SECONDS * 1000
  });
  if (!allWinners.length) console.log("🏁 No winner this round");
  else console.log(`🏆 ${allWinners.length} winner(s), pool ${poolPrize} birr, share ${share} birr each`);
  try {
    await pool.query(`UPDATE rounds SET phase='over', drawn=$1, winner_names=$2, winner_card=$3, prize=$4, ended_at=NOW() WHERE id = (SELECT id FROM rounds ORDER BY id DESC LIMIT 1)`, [game.drawn, allWinners.length ? allWinners.flatMap(w => w.names) : null, allWinners[0]?.card ?? null, poolPrize]);
  } catch (err) { console.error("round update:", err); }
  sendState();
  for (const winner of allWinners) if (winner.tgId) {
    const balance = await getBalance(winner.tgId);
    for (const ws of wss.clients) if (String(ws.tgId) === String(winner.tgId) && ws.readyState === 1)
      try { ws.send(JSON.stringify({ type: "balance", balance })); } catch {}
  }
  game.endTimer = setTimeout(() => startLobby(), WINNER_POPUP_SECONDS * 1000);
}

function clearTimers() {
  if (game.lobbyTimer) { clearInterval(game.lobbyTimer); game.lobbyTimer = null; }
  if (game.callTimer) { clearInterval(game.callTimer); game.callTimer = null; }
  if (game.endTimer) { clearTimeout(game.endTimer); game.endTimer = null; }
}

async function getBalance(tgId) {
  const r = await pool.query(`SELECT balance FROM users WHERE telegram_id = $1`, [tgId]);
  return Number(r.rows[0]?.balance || 0);
}

// ============================================================
// RECEIPT VERIFY
// ============================================================

function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(td|th|tr|div|p|li|h\d|span|label|dt|dd)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function fieldAfter(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const same = (m[1] || "").trim();
    return same || (lines[i + 1] || "").trim();
  }
  return "";
}

async function verifyTelebirrReceipt(txId) {
  if (!/^DJ[A-Z0-9]{6,}$/.test(txId)) return { ok: false, reason: "Bad tx id" };
  if (!TB_RECEIVER_NAME) return { ok: false, reason: "TB_RECEIVER_NAME not set" };

  const url = `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(txId)}`;
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9,am;q=0.8"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
    console.log(`🔎 telebirr receipt HTTP ${r.status} for ${txId}`);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };

    const finalHost = new URL(r.url).hostname;
    if (!finalHost.endsWith("ethiotelecom.et")) return { ok: false, reason: "Unexpected redirect" };

    const html = await r.text();
    console.log(`🔎 telebirr html length=${html.length}`);
    if (html.length > 2_000_000) return { ok: false, reason: "Page too large" };

    const lines = htmlToLines(html);
    const text = lines.join(" ");
    if (!text.toUpperCase().includes(txId)) return { ok: false, reason: "Tx id not found on page" };

    const status = fieldAfter(lines, /^(?:transaction\s*status|status)\s*[:\-]?\s*(.*)$/i);
    if (!/^(completed|success|successful)$/i.test(status)) return { ok: false, reason: `Status "${status || "missing"}"` };

    const amountRaw =
      fieldAfter(lines, /^(?:settled\s*amount)\s*[:\-]?\s*(.*)$/i) ||
      fieldAfter(lines, /^(?:transaction\s*amount)\s*[:\-]?\s*(.*)$/i) ||
      fieldAfter(lines, /^(?:amount)\s*[:\-]?\s*(.*)$/i);
    const am = amountRaw.match(/([\d,]+(?:\.\d+)?)/);
    const amount = am ? Number(am[1].replace(/,/g, "")) : 0;
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "Could not read amount" };

    const receiver = fieldAfter(lines, /^(?:credited\s*party\s*name|receiver(?:\s*name)?)\s*[:\-]?\s*(.*)$/i);
    if (!receiver || !receiver.toLowerCase().includes(TB_RECEIVER_NAME)) return { ok: false, reason: `Receiver mismatch` };

    const digitsOnly = lines.join(" ").replace(/\D/g, "");
    const myDigits = TB_NUMBER.replace(/\D/g, "");
    if (myDigits.length >= 8 && !digitsOnly.includes(myDigits)) return { ok: false, reason: "Receiver account number not on page" };

    return { ok: true, amount, receiver, status: "Completed" };
  } catch (e) {
    console.log(`🔎 telebirr fetch failed: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ============================================================
// DEPOSIT — CREDIT / CLAIM
// ============================================================

async function notifyCredited(telegramId, amount, txId, source) {
  const newBal = await getBalance(telegramId);
  for (const ws of wss.clients) {
    if (String(ws.tgId) === String(telegramId) && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "balance", balance: newBal }));
        ws.send(JSON.stringify({ type: "error", msg: `✅ Deposit ${amount} birr approved!` }));
      } catch {}
    }
  }
  await tgNotify(telegramId, `✅ Deposit approved: ${amount} birr. New balance: ${newBal} birr`);
  if (ADMIN_TG_ID) await tgNotify(ADMIN_TG_ID, `✅ <b>Deposit approved (${source})</b>\nUser: ${telegramId}\nAmount: ${amount} birr\nTxID: ${txId}`);
  console.log(`💰 Deposit ${amount} birr approved for ${telegramId} (${source}) TxID=${txId}`);
  return newBal;
}

async function creditDeposit({ txId, amount, source = "auto", note = null }) {
  const client = await pool.connect();
  let dep;
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT id, telegram_id, type, amount, status FROM transactions WHERE tx_id=$1 FOR UPDATE`, [txId]);
    if (!r.rows.length) {
      await client.query(`INSERT INTO transactions (telegram_id, type, amount, status, tx_id, note, auto) VALUES (0, 'deposit_orphan', $1, 'pending', $2, $3, $4) ON CONFLICT DO NOTHING`, [amount, txId, note || `Unmatched ${source} receipt`, source === "auto"]);
      await client.query("COMMIT");
      if (ADMIN_TG_ID) await tgNotify(ADMIN_TG_ID, `⚠️ <b>Receipt waiting for its user</b>\nAmount: ${amount} birr\nTxID: ${txId}`);
      return { status: "orphan" };
    }
    dep = r.rows[0];
    if (dep.status === "approved") { await client.query("ROLLBACK"); return { status: "duplicate" }; }
    if (dep.type !== "deposit" || dep.status !== "pending") { await client.query("ROLLBACK"); return { status: "orphan" }; }
    if (Number(dep.amount) !== Number(amount)) {
      await client.query(`UPDATE transactions SET note=$1 WHERE id=$2`, [`Amount mismatch: claimed ${dep.amount}, receipt ${amount}`, dep.id]);
      await client.query("COMMIT");
      if (ADMIN_TG_ID) await tgNotify(ADMIN_TG_ID, `⚠️ <b>Amount mismatch</b>\nUser: ${dep.telegram_id}\nClaimed: ${dep.amount}\nReceipt: ${amount}`);
      return { status: "mismatch" };
    }
    await client.query(`UPDATE users SET balance=balance+$1, updated_at=NOW() WHERE telegram_id=$2`, [amount, dep.telegram_id]);
    await client.query(`UPDATE transactions SET status='approved', auto=$1, note=$2 WHERE id=$3`, [source === "auto", note, dep.id]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("credit deposit:", e);
    return { status: "error" };
  } finally { client.release(); }
  const balance = await notifyCredited(dep.telegram_id, amount, txId, source);
  return { status: "approved", balance };
}

async function claimOrphan({ txId, userId, amount }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT id, amount FROM transactions WHERE tx_id=$1 AND type='deposit_orphan' AND status='pending' FOR UPDATE`, [txId]);
    if (!r.rows.length) { await client.query("ROLLBACK"); return { status: "none" }; }
    if (Number(r.rows[0].amount) !== Number(amount)) { await client.query("ROLLBACK"); return { status: "mismatch" }; }
    await client.query(`UPDATE users SET balance=balance+$1, updated_at=NOW() WHERE telegram_id=$2`, [amount, userId]);
    await client.query(`UPDATE transactions SET telegram_id=$1, type='deposit', status='approved', auto=TRUE, note='Receipt matched by tx ID' WHERE id=$2`, [userId, r.rows[0].id]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("claim orphan:", e);
    return { status: "error" };
  } finally { client.release(); }
  const balance = await notifyCredited(userId, amount, txId, "matched");
  return { status: "approved", balance };
}

// ============================================================
// TELEGRAM BOT
// ============================================================

let bot = null;

if (ADMIN_BOT_TOKEN) {
  bot = new Bot(ADMIN_BOT_TOKEN);

  function menuKeyboard() {
    return new InlineKeyboard()
      .text("💰 My Balance", "menu:balance")
      .text("💳 Deposit", "menu:deposit").row()
      .text("💸 Withdrawal", "menu:withdraw")
      .text("🎱 Play Bingo", "menu:play").row()
      .text("👥 Invite Friend", "menu:invite")
      .text("📖 Help", "menu:help");
  }

  bot.command("start", async (ctx) => {
    const uid = ctx.from.id;
    let inviteInfo = "";
    try {
      const stats = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1`, [uid]);
      const count = stats.rows[0].count;
      if (count > 0) {
        inviteInfo = `\n\n👥 You've invited <b>${count}</b> friend${count === 1 ? "" : "s"} — earned <b>${count * REFERRAL_BONUS_INVITER} birr</b>!`;
      }
    } catch {}
    await ctx.reply(
      `🎱 <b>Zoma Bingo Bot</b>\n\nChoose an option below:${inviteInfo}`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 <b>Help & Commands</b>\n\n` +
      `/start — Show the menu\n` +
      `/balance — Your balance\n` +
      `/invite — Your referral link\n` +
      `/check <txId> — Verify a Telebirr payment\n\n` +
      `<i>Admin:</i> /pending, /withdrawals`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  });

  bot.command("balance", async (ctx) => {
    try {
      const bal = await getBalance(ctx.from.id);
      await ctx.reply(`💰 <b>Your Balance</b>\n\nYou have <b>${bal} birr</b>.`, { parse_mode: "HTML", reply_markup: menuKeyboard() });
    } catch {
      await ctx.reply("Could not load balance.", { reply_markup: menuKeyboard() });
    }
  });

  bot.command("invite", async (ctx) => {
    const uid = ctx.from.id;
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
    const stats = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1`, [uid]);
    const count = stats.rows[0].count;
    const earnings = count * REFERRAL_BONUS_INVITER;
    const kb = new InlineKeyboard()
      .url("📤 Share Link",
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Play Zoma Bingo and win birr! 🎱")}`)
      .row()
      .text("⬅️ Back", "menu:home");
    await ctx.reply(
      `👥 <b>Invite Friends</b>\n\n` +
      `Your personal link:\n<code>${link}</code>\n\n` +
      `🎁 Get <b>+${REFERRAL_BONUS_INVITER} birr</b> for every friend who joins\n\n` +
      `📊 Friends invited: <b>${count}</b>\n` +
      `💰 Total earned: <b>${earnings} birr</b>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  bot.command("check", async (ctx) => {
    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const txId = (args[0] || "").toUpperCase();
    if (!/^DJ[A-Z0-9]{6,}$/.test(txId)) return ctx.reply("Usage: /check DJ40FCM8GM");
    const tgId = ctx.from.id;
    const existing = await pool.query(`SELECT type, status, amount FROM transactions WHERE tx_id=$1 LIMIT 1`, [txId]);
    if (existing.rows.length && existing.rows[0].status === "approved") return ctx.reply(`✅ Already approved. Amount: ${existing.rows[0].amount} birr`);
    if (existing.rows.length && existing.rows[0].type === "deposit_orphan") {
      const amount = Number(existing.rows[0].amount);
      const r = await claimOrphan({ txId, userId: tgId, amount });
      if (r.status === "approved") return ctx.reply(`✅ Deposit matched & credited!\n${amount} birr added.\nBalance: ${r.balance} birr`);
      if (r.status === "mismatch") return ctx.reply(`❌ Amount mismatch.`);
      return ctx.reply(`❌ Could not claim.`);
    }
    const v = await verifyTelebirrReceipt(txId);
    if (!v.ok) return ctx.reply(`❌ Could not verify <b>${txId}</b>\nReason: ${v.reason}`, { parse_mode: "HTML" });
    const dep = await pool.query(`SELECT id, amount FROM transactions WHERE telegram_id=$1 AND type='deposit' AND status='pending' LIMIT 1`, [tgId]);
    if (!dep.rows.length) {
      await pool.query(`INSERT INTO transactions (telegram_id, type, amount, status, tx_id, note, auto) VALUES (0, 'deposit_orphan', $1, 'pending', $2, $3, TRUE) ON CONFLICT (tx_id) DO NOTHING`, [v.amount, txId, "Verified via /check"]);
      return ctx.reply(`✅ Receipt verified: <b>${v.amount} birr</b>\n\nNow open the Mini App to claim.`, { parse_mode: "HTML" });
    }
    if (Number(dep.rows[0].amount) !== v.amount) return ctx.reply(`❌ Amount mismatch.`);
    const r = await creditDeposit({ txId, amount: v.amount, source: "auto", note: "Verified via /check" });
    if (r.status === "approved") return ctx.reply(`✅ Deposit approved!\n${v.amount} birr added.\nBalance: ${r.balance} birr`);
    return ctx.reply(`❌ ${r.status}`);
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    try {
      const bal = await getBalance(ctx.from.id);
      const u = await pool.query(`SELECT first_name FROM users WHERE telegram_id=$1`, [ctx.from.id]);
      const name = u.rows[0]?.first_name || "Player";
      await ctx.answerCallbackQuery(`💰 ${bal} birr`);
      await ctx.editMessageText(
        `💰 <b>Your Balance</b>\n\nHi ${name}, you have <b>${bal} birr</b>.`,
        { parse_mode: "HTML", reply_markup: menuKeyboard() }
      );
    } catch (e) { await ctx.answerCallbackQuery("Error"); }
  });

  bot.callbackQuery("menu:deposit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `💳 <b>Deposit to Zoma Bingo</b>\n\n` +
      `1. Send money to <b>${TB_NUMBER}</b> (${TB_NAME}) via Telebirr\n` +
      `2. Note the <b>Transaction ID</b> from the SMS (starts with <code>DJ</code>)\n` +
      `3. Open the Mini App → Profile → Deposit\n` +
      `4. Enter amount + TxID\n\n` +
      `Your balance will be credited automatically.`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  });

  bot.callbackQuery("menu:withdraw", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `💸 <b>Withdrawal to Telebirr</b>\n\n` +
      `⚠️ You must have deposited at least <b>${MIN_DEPOSIT_FOR_WITHDRAWAL} birr</b> to withdraw.\n\n` +
      `1. Open the Mini App → Profile → Withdraw\n` +
      `2. Enter amount and your Telebirr phone number\n` +
      `3. Tap Request withdrawal\n\n` +
      `We'll send the money to your phone within a few minutes.`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  });

  bot.callbackQuery("menu:play", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .webApp("🎱 Open Bingo App", "https://zoma-production-246c.up.railway.app/")
      .row()
      .text("⬅️ Back", "menu:home");
    await ctx.editMessageText(
      `🎱 <b>Play Zoma Bingo</b>\n\nTap below to launch the game.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  bot.callbackQuery("menu:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from.id;
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
    const stats = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1`, [uid]);
    const count = stats.rows[0].count;
    const earnings = count * REFERRAL_BONUS_INVITER;
    const kb = new InlineKeyboard()
      .url("📤 Share Link",
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Play Zoma Bingo and win birr! 🎱")}`)
      .row()
      .text("⬅️ Back", "menu:home");
    await ctx.editMessageText(
      `👥 <b>Invite Friends</b>\n\n` +
      `Your personal link:\n<code>${link}</code>\n\n` +
      `🎁 Get <b>+${REFERRAL_BONUS_INVITER} birr</b> per friend who joins\n\n` +
      `📊 Friends invited: <b>${count}</b>\n` +
      `💰 Total earned: <b>${earnings} birr</b>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🎱 <b>Zoma Bingo Bot</b>\n\nChoose an option below:`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📖 <b>Help & Commands</b>\n\n` +
      `/start — Show the menu\n` +
      `/balance — Your balance\n` +
      `/invite — Referral link\n` +
      `/check <txId> — Verify a Telebirr payment\n\n` +
      `<i>Admin:</i> /pending, /withdrawals`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  });

  const isAdmin = (ctx) => String(ctx.from.id) === String(ADMIN_TG_ID) || String(ctx.chat.id) === String(ADMIN_TG_ID);

  bot.command("pending", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const r = await pool.query(`SELECT id, telegram_id, amount, tx_id FROM transactions WHERE type='deposit' AND status='pending' ORDER BY id ASC LIMIT 20`);
    if (!r.rows.length) return ctx.reply("No pending deposits.");
    const lines = r.rows.map(x => `<b>#${x.id}</b> · ${x.amount} birr · user ${x.telegram_id}\nTx: <code>${x.tx_id}</code>`).join("\n\n");
    const kb = new InlineKeyboard();
    for (const x of r.rows.slice(0, 8)) kb.text(`✅ #${x.id}`, `approve:${x.id}`).text(`❌ #${x.id}`, `reject:${x.id}`).row();
    await ctx.reply(lines, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("withdrawals", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const r = await pool.query(`SELECT id, telegram_id, amount, phone FROM transactions WHERE type='withdraw' AND status='pending' ORDER BY id ASC LIMIT 20`);
    if (!r.rows.length) return ctx.reply("No pending withdrawals.");
    const lines = r.rows.map(x => `<b>#${x.id}</b> · <b>${x.amount} birr</b> → <code>${x.phone}</code>`).join("\n\n");
    const kb = new InlineKeyboard();
    for (const x of r.rows.slice(0, 8)) kb.text(`✅ Paid #${x.id}`, `wpaid:${x.id}`).text(`❌ Reject #${x.id}`, `wreject:${x.id}`).row();
    await ctx.reply(lines, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number((ctx.match || "").trim());
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("Usage: /approve <id>");
    await approveById(id);
    await ctx.reply(`✅ Approved #${id}`);
  });

  bot.command("reject", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number((ctx.match || "").trim());
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("Usage: /reject <id>");
    await pool.query(`UPDATE transactions SET status='rejected', note='Rejected via bot' WHERE id=$1 AND status='pending'`, [id]);
    await ctx.reply(`❌ Rejected #${id}`);
  });

  bot.command("paid", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number((ctx.match || "").trim());
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("Usage: /paid <id>");
    const r = await pool.query(`UPDATE transactions SET status='paid' WHERE id=$1 AND type='withdraw' AND status='pending' RETURNING telegram_id, amount`, [id]);
    if (r.rows.length) {
      await tgNotify(r.rows[0].telegram_id, `✅ Withdrawal ${r.rows[0].amount} birr paid.`);
      await ctx.reply(`✅ Marked paid #${id}`);
    } else await ctx.reply(`Not found.`);
  });

  bot.callbackQuery(/^approve:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery("Not allowed");
    await approveById(Number(ctx.match[1]));
    await ctx.answerCallbackQuery("Approved");
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
  });

  bot.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery("Not allowed");
    const id = Number(ctx.match[1]);
    await pool.query(`UPDATE transactions SET status='rejected', note='Rejected via bot' WHERE id=$1 AND status='pending'`, [id]);
    await ctx.answerCallbackQuery("Rejected");
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
  });

  bot.callbackQuery(/^wpaid:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery("Not allowed");
    const id = Number(ctx.match[1]);
    const r = await pool.query(`UPDATE transactions SET status='paid' WHERE id=$1 AND type='withdraw' AND status='pending' RETURNING telegram_id, amount`, [id]);
    if (r.rows.length) {
      await tgNotify(r.rows[0].telegram_id, `✅ Withdrawal ${r.rows[0].amount} birr has been paid.`);
      await ctx.answerCallbackQuery(`Marked paid`);
    } else await ctx.answerCallbackQuery("Already handled");
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
  });

  bot.callbackQuery(/^wreject:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery("Not allowed");
    const id = Number(ctx.match[1]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(`SELECT telegram_id, amount FROM transactions WHERE id=$1 AND type='withdraw' AND status='pending' FOR UPDATE`, [id]);
      if (r.rows.length) {
        const { telegram_id, amount } = r.rows[0];
        await client.query(`UPDATE users SET balance=balance+$1 WHERE telegram_id=$2`, [amount, telegram_id]);
        await client.query(`UPDATE transactions SET status='rejected' WHERE id=$1`, [id]);
        await tgNotify(telegram_id, `❌ Withdrawal ${amount} birr rejected. Funds returned.`);
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); console.error("wreject:", e); }
    finally { client.release(); }
    await ctx.answerCallbackQuery("Rejected");
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
  });

  bot.catch((err) => console.error("bot error:", err));
  console.log(`🤖 Telegram bot initialized (polling)`);
} else {
  console.warn("⚠️ ADMIN_BOT_TOKEN not set — Telegram bot disabled");
}

async function approveById(id) {
  const dep = await pool.query(`SELECT id, telegram_id, amount, status FROM transactions WHERE id=$1`, [id]);
  if (!dep.rows.length || dep.rows[0].status !== "pending") return;
  const { telegram_id, amount } = dep.rows[0];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE users SET balance=balance+$1, updated_at=NOW() WHERE telegram_id=$2`, [amount, telegram_id]);
    await client.query(`UPDATE transactions SET status='approved', auto=FALSE, note='Approved via bot' WHERE id=$1`, [id]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  await notifyCredited(telegram_id, amount, "MANUAL", "admin-bot");
}

// ============================================================
// WEBSOCKET
// ============================================================

wss.on("connection", (ws) => {
  ws.tgId = null; ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "auth") {
      const tg = validateInitData(msg.initData);
      if (!tg) { try { ws.send(JSON.stringify({ type: "error", msg: "Invalid auth" })); } catch {} return; }
      if (Number(tg.id) >= BOT_ID_BASE) { try { ws.send(JSON.stringify({ type: "error", msg: "Invalid user" })); } catch {} return; }
      ws.tgId = tg.id;
      const { isNew, balance } = await ensureUser(tg, tg.start_param);
      const names = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || `Player ${String(tg.id).slice(-4)}`;
      if (!game.players.has(tg.id)) game.players.set(tg.id, { names: [names], isBot: false });
      try { ws.send(JSON.stringify({ type: "balance", balance })); } catch {}
      try { ws.send(JSON.stringify(publicState(tg.id))); } catch {}
      if (isNew) try { ws.send(JSON.stringify({ type: "error", msg: `🎁 Welcome! You got ${WELCOME_BONUS} birr free.` })); } catch {}
      if (game.phase === "lobby" && !game.botSetup && !game.lobbyTimer && game.players.size >= 1) startCountdown();
      return;
    }
    if (msg.type === "join") {
      if (!ws.tgId) { try { ws.send(JSON.stringify({ type: "error", msg: "Not authenticated" })); } catch {} return; }
      if (game.phase !== "lobby") { try { ws.send(JSON.stringify({ type: "error", msg: "Round already started" })); } catch {} return; }
      const requested = Array.isArray(msg.cards) ? msg.cards : [];
      const player = game.players.get(ws.tgId);
      if (!player) { try { ws.send(JSON.stringify({ type: "error", msg: "Not registered" })); } catch {} return; }
      const owned = [...game.cards.values()].filter(e => String(e.owner) === String(ws.tgId)).map(e => e.cardNo);
      const taken = new Set([...game.cards.values()].map(e => e.cardNo));
      const room = MAX_CARDS_PER_PLAYER - owned.length;
      const valid = [];
      for (const n of requested) {
        if (!Number.isInteger(n) || n < 1 || n > TOTAL_CARDS) continue;
        if (owned.includes(n) || valid.includes(n) || taken.has(n) || game.pendingCards.has(n)) continue;
        valid.push(n);
      }
      const take = valid.slice(0, room);
      const cost = take.length * CARD_PRICE;
      if (!take.length) { try { ws.send(JSON.stringify({ type: "error", msg: "No valid cards" })); } catch {} return; }
      for (const n of take) game.pendingCards.add(n);
      let client;
      try { client = await pool.connect(); }
      catch (e) { for (const n of take) game.pendingCards.delete(n); try { ws.send(JSON.stringify({ type: "error", msg: "DB unavailable" })); } catch {} return; }
      try {
        await client.query("BEGIN");
        const u = await client.query(`SELECT balance FROM users WHERE telegram_id=$1 FOR UPDATE`, [ws.tgId]);
        const bal = Number(u.rows[0]?.balance || 0);
        if (bal < cost) {
          await client.query("ROLLBACK");
          for (const n of take) game.pendingCards.delete(n);
          try { ws.send(JSON.stringify({ type: "error", msg: `Not enough balance. Need ${cost} birr.` })); } catch {}
          return;
        }
        await client.query(`UPDATE users SET balance=balance-$1, updated_at=NOW() WHERE telegram_id=$2`, [cost, ws.tgId]);
        for (const n of take) await client.query(`INSERT INTO transactions (telegram_id, type, amount, status) VALUES ($1,'card',$2,'completed')`, [ws.tgId, CARD_PRICE]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK"); console.error("join txn:", e);
        for (const n of take) game.pendingCards.delete(n);
        try { ws.send(JSON.stringify({ type: "error", msg: "Could not buy cards" })); } catch {}
        return;
      } finally { client.release(); }
      for (const n of take) { game.pendingCards.delete(n); game.cards.set(`${ws.tgId}:${n}`, { cardNo: n, owner: ws.tgId }); }
      try { ws.send(JSON.stringify({ type: "balance", balance: await getBalance(ws.tgId) })); } catch {}
      sendState();
      if (!game.lobbyTimer && game.phase === "lobby" && game.cards.size > 0) startCountdown();
      return;
    }
  });
  ws.on("close", () => {});
  ws.on("error", () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30000);

// ============================================================
// REST — USER
// ============================================================

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT telegram_id, username, first_name, last_name, balance FROM users WHERE telegram_id=$1`, [req.tgUser.id]);
    const u = r.rows[0];
    res.json({ balance: Number(u?.balance || 0), tg: { id: req.tgUser.id, username: req.tgUser.username, first_name: req.tgUser.first_name }, tb: { number: TB_NUMBER, name: TB_NAME }, limits: { min: MIN_DEPOSIT, max: MAX_DEPOSIT, minForWithdraw: MIN_DEPOSIT_FOR_WITHDRAWAL } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Unable to load user" }); }
});

app.get("/api/history", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT type AS kind, amount, status, created_at FROM transactions WHERE telegram_id=$1 AND type IN ('deposit','withdraw','win','promo','welcome_bonus','referral') ORDER BY id DESC LIMIT 50`, [req.tgUser.id]);
    res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
  } catch (err) { console.error(err); res.status(500).json({ error: "History failed" }); }
});

// ============================================================
// DEPOSIT — endpoint
// ============================================================

app.post("/api/deposit", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);
  const txId = String(req.body?.txId || "").trim().toUpperCase();

  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) return res.status(400).json({ error: `Amount must be between ${MIN_DEPOSIT} and ${MAX_DEPOSIT} birr` });
  if (!txId || !/^DJ[A-Z0-9]{6,}$/.test(txId)) return res.status(400).json({ error: "Invalid transaction ID" });

  const tryClaim = async () => {
    const c = await claimOrphan({ txId, userId: req.tgUser.id, amount });
    if (c.status === "approved") return res.json({ status: "approved", amount, balance: c.balance });
    if (c.status === "mismatch") return res.status(400).json({ error: "Amount doesn't match." });
    return null;
  };

  try {
    const existing = await pool.query(`SELECT type, status FROM transactions WHERE tx_id=$1 LIMIT 1`, [txId]);
    if (existing.rows.length) {
      const e = existing.rows[0];
      if (e.type === "deposit_orphan" && e.status === "pending") { const h = await tryClaim(); if (h) return h; }
      if (e.status === "approved") return res.status(400).json({ error: "Already approved" });
      return res.status(400).json({ error: "Already being processed" });
    }

    let depId;
    try {
      const ins = await pool.query(`INSERT INTO transactions (telegram_id, type, amount, status, tx_id) VALUES ($1, 'deposit', $2, 'pending', $3) RETURNING id`, [req.tgUser.id, amount, txId]);
      depId = ins.rows[0].id;
    } catch (e) {
      if (e.code === "23505") { const h = await tryClaim(); if (h) return h; return res.status(400).json({ error: "Already being processed" }); }
      throw e;
    }

    const v = await verifyTelebirrReceipt(txId);
    console.log("💳 Deposit verification result:", { txId, userId: req.tgUser.id, requestedAmount: amount, verified: v.ok, receiptAmount: v.amount ?? null, reason: v.reason ?? null });

    const normAmt = (x) => Math.round(Number(x) * 100);
    const amtMatches = v.ok && normAmt(v.amount) === normAmt(amount);

    if (amtMatches) {
      const result = await creditDeposit({ txId, amount, source: "auto", note: `Receipt verified (${v.status || "Completed"})` });
      if (result.status === "approved") return res.json({ status: "approved", amount, balance: result.balance });
      if (result.status === "duplicate") return res.status(409).json({ error: "Already processed." });
    }

    const reason = !v.ok ? (v.reason || "Verification failed") : !amtMatches ? `Amount mismatch` : "Not credited";
    await pool.query(`UPDATE transactions SET note=$1 WHERE id=$2 AND status='pending'`, [reason, depId]);

    if (ADMIN_TG_ID && bot) {
      try {
        const kb = new InlineKeyboard().text(`✅ Approve #${depId}`, `approve:${depId}`).text(`❌ Reject #${depId}`, `reject:${depId}`);
        await bot.api.sendMessage(ADMIN_TG_ID,
          `🔔 <b>Deposit needs review</b>\n<b>#${depId}</b> · User: ${req.tgUser.id}\nAmount: <b>${amount} birr</b>\nTxID: <code>${txId}</code>\nReason: ${reason}\n\n👉 Verify in Telebirr, then tap ✅ or ❌`,
          { parse_mode: "HTML", reply_markup: kb });
      } catch (e) {
        console.error("deposit notify:", e.message);
        await tgNotify(ADMIN_TG_ID, `🔔 Deposit needs review\nUser: ${req.tgUser.id}\nAmount: ${amount} birr\nTxID: ${txId}\nReason: ${reason}`);
      }
    }

    return res.json({ status: "pending", depId });
  } catch (err) {
    console.error("deposit:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// ============================================================
// WITHDRAW — endpoint with 100 birr deposit gate
// ============================================================

app.post("/api/withdraw", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);
  const phone = String(req.body?.phone || "").trim();
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!/^0?9\d{8}$/.test(phone)) return res.status(400).json({ error: "Invalid Telebirr phone number" });

  const client = await pool.connect();
  let wdId = null;
  try {
    await client.query("BEGIN");

    const depSum = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total
       FROM transactions
       WHERE telegram_id=$1 AND type='deposit' AND status='approved'`,
      [req.tgUser.id]
    );
    const totalDeposited = Number(depSum.rows[0].total);
    if (totalDeposited < MIN_DEPOSIT_FOR_WITHDRAWAL) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `You must deposit at least ${MIN_DEPOSIT_FOR_WITHDRAWAL} birr before you can withdraw. You've deposited ${totalDeposited} birr so far.`
      });
    }

    const u = await client.query(`SELECT balance FROM users WHERE telegram_id=$1 FOR UPDATE`, [req.tgUser.id]);
    const bal = Number(u.rows[0]?.balance || 0);
    if (bal < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient balance" });
    }

    await client.query(`UPDATE users SET balance=balance-$1, updated_at=NOW() WHERE telegram_id=$2`, [amount, req.tgUser.id]);
    const ins = await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, phone) VALUES ($1,'withdraw',$2,'pending',$3) RETURNING id`,
      [req.tgUser.id, amount, phone]
    );
    wdId = ins.rows[0].id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "Withdrawal failed" });
  } finally { client.release(); }

  const newBal = await getBalance(req.tgUser.id);

  if (ADMIN_TG_ID && bot && wdId) {
    try {
      const kb = new InlineKeyboard().text(`✅ Mark paid #${wdId}`, `wpaid:${wdId}`).text(`❌ Reject #${wdId}`, `wreject:${wdId}`);
      await bot.api.sendMessage(ADMIN_TG_ID,
        `💸 <b>Withdrawal request</b>\n<b>#${wdId}</b> · User: ${req.tgUser.id}\nAmount: <b>${amount} birr</b>\nPhone: <code>${phone}</code>\n\n👉 Send the money via Telebirr FIRST, then tap ✅`,
        { parse_mode: "HTML", reply_markup: kb });
    } catch (e) {
      console.error("withdraw notify:", e.message);
      await tgNotify(ADMIN_TG_ID, `💸 Withdrawal request\nUser: ${req.tgUser.id}\nAmount: ${amount} birr\nPhone: ${phone}`);
    }
  }

  res.json({ balance: newBal });
});

// ============================================================
// PROMO
// ============================================================

app.post("/api/promo", authMiddleware, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter a code" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query(`SELECT code, amount, max_uses, uses, active FROM promo_codes WHERE code=$1 FOR UPDATE`, [code]);
    if (!c.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Invalid code" }); }
    const p = c.rows[0];
    if (!p.active) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Code expired" }); }
    if (p.uses >= p.max_uses) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Fully redeemed" }); }
    const used = await client.query(`SELECT 1 FROM promo_redemptions WHERE telegram_id=$1 AND code=$2`, [req.tgUser.id, code]);
    if (used.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Already used" }); }
    const amt = Number(p.amount);
    await client.query(`UPDATE promo_codes SET uses=uses+1 WHERE code=$1`, [code]);
    await client.query(`INSERT INTO promo_redemptions (telegram_id, code) VALUES ($1,$2)`, [req.tgUser.id, code]);
    await client.query(`UPDATE users SET balance=balance+$1, updated_at=NOW() WHERE telegram_id=$2`, [amt, req.tgUser.id]);
    await client.query(`INSERT INTO transactions (telegram_id, type, amount, status, note) VALUES ($1,'promo',$2,'completed',$3)`, [req.tgUser.id, amt, `Promo ${code}`]);
    await client.query("COMMIT");
    const newBal = await getBalance(req.tgUser.id);
    res.json({ amount: amt, balance: newBal });
  } catch (err) { await client.query("ROLLBACK"); console.error("promo:", err); res.status(500).json({ error: "Promo failed" }); }
  finally { client.release(); }
});

// ============================================================
// SMS WEBHOOK
// ============================================================

app.post("/webhook/sms", async (req, res) => {
  if (req.query.secret !== SMS_SECRET) { console.warn("sms webhook: bad secret"); return res.status(403).json({ error: "Forbidden" }); }
  const text = String(req.body?.text || req.body?.message || "");
  console.log("📩 SMS:", text.slice(0, 200));
  const m = text.match(/received\s+([\d.,]+)\s*birr[\s\S]*?Transaction\s*ID\s*[: ]?\s*(DJ[A-Z0-9]{6,})/i);
  if (!m) return res.json({ ok: true, ignored: true });
  const amount = Number(m[1].replace(/,/g, ""));
  const txId = m[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return res.json({ ok: true, ignored: true });
  try {
    const r = await creditDeposit({ txId, amount, source: "auto", note: "Auto-verified via SMS forwarder" });
    res.json({ ok: true, result: r });
  } catch (err) { console.error("sms webhook:", err); res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// ADMIN PANEL
// ============================================================

const adminHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zoma Admin</title>
<style>body{margin:0;background:#171a43;color:#f4f2ff;font:500 15px/1.4 system-ui,sans-serif;padding:14px}h1{font-size:20px;margin:0 0 10px}.card{background:#232763;border-radius:14px;padding:12px;margin:10px 0}.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #3a3f86}.row:last-child{border:0}button{border:0;border-radius:10px;padding:8px 12px;font-weight:800;color:#fff;background:#22a06b;cursor:pointer}button.red{background:#e8453c}button.blue{background:#2f6bff}small{color:#a9acd9}input{width:100%;padding:10px;border-radius:10px;border:2px solid #3a3f86;background:#171a43;color:#fff;font:inherit}</style></head><body>
<h1>🛠️ Zoma Admin</h1>
<div class="card"><label>Password</label><input id="pw" type="password" placeholder="admin password"><button class="blue" id="login" style="margin-top:8px">Load</button><small id="whoami"></small></div>
<div class="card"><h3>Pending deposits</h3><div id="pending">Login to load…</div></div>
<div class="card"><h3>Orphan receipts</h3><div id="orphans">Login to load…</div></div>
<div class="card"><h3>Pending withdrawals</h3><div id="withdrawals">Login to load…</div></div>
<script>
const $ = (id) => document.getElementById(id);
let pw = "";
async function api(path, method="GET", body=null){const r = await fetch(path,{method,headers:{"Content-Type":"application/json","x-admin-pw":pw},body: body?JSON.stringify(body):null});const j = await r.json(); if(!r.ok) throw new Error(j.error||"Error"); return j;}
function row(l, r){ return '<div class="row"><span>'+l+'</span>'+r+'</div>'; }
async function load(){try{
  const d = await api("/api/admin/pending");
  $("pending").innerHTML = d.items.length ? d.items.map(i=>row("<b>"+i.telegram_id+"</b> · "+i.amount+" birr<br><small>Tx: "+i.tx_id+"</small>", '<button data-id="'+i.id+'" class="ok">Approve</button> <button data-id="'+i.id+'" class="red no">Reject</button>')).join("") : "<small>No pending deposits.</small>";
  const o = await api("/api/admin/orphans");
  $("orphans").innerHTML = o.items.length ? o.items.map(i=>row("<b>"+i.amount+" birr</b> · Tx: "+i.tx_id, '<small>'+(i.note||"")+'</small>')).join("") : "<small>None.</small>";
  const w = await api("/api/admin/withdrawals");
  $("withdrawals").innerHTML = w.items.length ? w.items.map(i=>row("<b>"+i.telegram_id+"</b> · "+i.amount+" birr → "+i.phone, '<button data-id="'+i.id+'" class="blue paid">Mark paid</button> <button data-id="'+i.id+'" class="red wr">Reject</button>')).join("") : "<small>None.</small>";
  $("pending").querySelectorAll("button.ok").forEach(b=>b.onclick=()=>approve(b.dataset.id));
  $("pending").querySelectorAll("button.no").forEach(b=>b.onclick=()=>rejectDep(b.dataset.id));
  $("withdrawals").querySelectorAll("button.paid").forEach(b=>b.onclick=()=>paidWd(b.dataset.id));
  $("withdrawals").querySelectorAll("button.wr").forEach(b=>b.onclick=()=>rejectWd(b.dataset.id));
}catch(e){ alert(e.message); }}
async function approve(id){ try{ await api("/api/admin/approve/"+id,"POST"); load(); }catch(e){ alert(e.message);} }
async function rejectDep(id){ const r=prompt("Reason?"); if(!r)return; try{ await api("/api/admin/reject/"+id,"POST",{reason:r}); load(); }catch(e){ alert(e.message);} }
async function paidWd(id){ try{ await api("/api/admin/withdraw-paid/"+id,"POST"); load(); }catch(e){ alert(e.message);} }
async function rejectWd(id){ try{ await api("/api/admin/withdraw-reject/"+id,"POST"); load(); }catch(e){ alert(e.message);} }
$("login").onclick = () => { pw = $("pw").value; $("whoami").textContent = "Password set"; load(); };
</script></body></html>`;

app.get("/admin", (req, res) => res.type("html").send(adminHtml));

function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-pw"];
  if (!pw || pw !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/api/admin/pending", requireAdmin, async (req, res) => {
  const r = await pool.query(`SELECT id, telegram_id, amount, tx_id, created_at FROM transactions WHERE type='deposit' AND status='pending' ORDER BY id ASC LIMIT 200`);
  res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
});

app.get("/api/admin/orphans", requireAdmin, async (req, res) => {
  const r = await pool.query(`SELECT id, amount, tx_id, note, created_at FROM transactions WHERE type='deposit_orphan' AND status='pending' ORDER BY id DESC LIMIT 200`);
  res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
});

app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  const r = await pool.query(`SELECT id, telegram_id, amount, phone, created_at FROM transactions WHERE type='withdraw' AND status='pending' ORDER BY id ASC LIMIT 200`);
  res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
});

app.post("/api/admin/approve/:id", requireAdmin, async (req, res) => {
  try { await approveById(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "Failed" }); }
});

app.post("/api/admin/reject/:id", requireAdmin, async (req, res) => {
  try {
    const reason = String(req.body?.reason || "Rejected");
    const dep = await pool.query(`SELECT telegram_id, amount FROM transactions WHERE id=$1 AND status='pending'`, [req.params.id]);
    if (!dep.rows.length) return res.status(400).json({ error: "Not pending" });
    await pool.query(`UPDATE transactions SET status='rejected', note=$1 WHERE id=$2`, [reason, req.params.id]);
    await tgNotify(dep.rows[0].telegram_id, `❌ Deposit ${dep.rows[0].amount} birr rejected: ${reason}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed" }); }
});

app.post("/api/admin/withdraw-paid/:id", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`UPDATE transactions SET status='paid' WHERE id=$1 AND type='withdraw' AND status='pending' RETURNING telegram_id, amount`, [req.params.id]);
    if (!r.rows.length) return res.status(400).json({ error: "Not pending" });
    await tgNotify(r.rows[0].telegram_id, `✅ Withdrawal ${r.rows[0].amount} birr paid.`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed" }); }
});

app.post("/api/admin/withdraw-reject/:id", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT telegram_id, amount FROM transactions WHERE id=$1 AND type='withdraw' AND status='pending' FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Not pending" }); }
    const { telegram_id, amount } = r.rows[0];
    await client.query(`UPDATE users SET balance=balance+$1 WHERE telegram_id=$2`, [amount, telegram_id]);
    await client.query(`UPDATE transactions SET status='rejected' WHERE id=$1`, [req.params.id]);
    await client.query("COMMIT");
    await tgNotify(telegram_id, `❌ Withdrawal ${amount} birr rejected. Funds returned.`);
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); console.error(e); res.status(500).json({ error: "Failed" }); }
  finally { client.release(); }
});

// ============================================================
// FALLBACK
// ============================================================

app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path.startsWith("/webhook") || req.path === "/admin" || req.path === "/health") return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
// BOOT
// ============================================================

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🎱 Zoma Bingo on :${PORT}`);
  console.log(`💵 CARD_PRICE=${CARD_PRICE}  🏆 HOUSE_CUT=${HOUSE_CUT}`);
  console.log(`👥 MIN_PLAYERS=${MIN_PLAYERS_TO_START}  🤖 BOT_COUNT=${BOT_COUNT}`);
  console.log(`🎁 WELCOME_BONUS=${WELCOME_BONUS} birr  |  🎉 REFERRAL_BONUS=${REFERRAL_BONUS_INVITER} birr`);
  console.log(`💸 Min deposit for withdrawal: ${MIN_DEPOSIT_FOR_WITHDRAWAL} birr`);
  console.log(`🎯 Patterns: Rows, Columns, Diagonals, Four Corners`);
  console.log(`💳 Telebirr: ${TB_NUMBER} (${TB_NAME})`);
  console.log(`🤖 Bot username: @${BOT_USERNAME}`);
  console.log(`🔎 Receipt: TB_RECEIVER_NAME="${TB_RECEIVER_NAME}"  AGE=unlimited`);

  try {
    await initDatabase();
    console.log("✅ Database ready");
    await seedBots();
    startupReady = true;

    if (bot) {
      setTimeout(() => {
        console.log("🤖 Starting bot polling in 8s…");
        bot.start({
          onStart: (info) => console.log(`🤖 Bot @${info.username} polling started`),
          drop_pending_updates: true
        }).catch((err) => {
          if (err?.error_code === 409) {
            console.warn("⚠️ Bot 409 — retrying in 20s…");
            setTimeout(() => bot.start({ drop_pending_updates: true }).catch(() => {}), 20000);
          } else {
            console.error("bot start error:", err.message);
          }
        });
      }, 8000);
    }

    startLobby();
    console.log("🎮 Game loop started");
  } catch (err) {
    console.error("❌ Startup error:", err);
  }
});

async function shutdown(sig) {
  console.log(`🛑 ${sig}`);
  clearTimers();
  if (bot) { try { await bot.stop(); } catch {} }
  for (const ws of wss.clients) { try { ws.close(); } catch {} }
  try { await pool.end(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
