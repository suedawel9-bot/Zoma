// ============================================================
// ZOMA BINGO — Telegram Mini App Server
// Updated: 2026-10-10 — Telebirr auto-approval + SMS webhook + admin panel
// ============================================================

console.log("🔥 ZOMA BINGO SERVER 2026-10-10");

import express from "express";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import rateLimit from "express-rate-limit";

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

// Telebirr receiving account
const TB_NUMBER = process.env.TB_NUMBER || "0982372677";
const TB_NAME = process.env.TB_NAME || "Zoma Bingo";

// Deposit limits
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 10);
const MAX_DEPOSIT = Number(process.env.MAX_DEPOSIT || 50000);
const RECEIPT_MAX_AGE_HOURS = Number(process.env.RECEIPT_MAX_AGE_HOURS || 24);

// ============================================================
// REALISTIC BOT NAMES
// ============================================================

const FIRST_NAMES = [
  "Abebe", "Sara", "Dawit", "Hanna", "Yonas", "Marta", "Bereket", "Selam",
  "Kebede", "Meron", "Tesfaye", "Rahel", "Girma", "Liya", "Samuel", "Bethel",
  "Nahom", "Eden", "Mikias", "Tsion", "Eyob", "Feven", "Natnael", "Beza",
  "Henok", "Mimi", "Kaleab", "Rediet", "Biruk", "Selamawit", "Firaol", "Sofia",
  "Dagmawi", "Mahlet", "Yosef", "Ruth", "Solomon", "Genet", "Amanuel", "Hiwot",
  "Binyam", "Tigist", "Ermias", "Aster", "Biniam", "Almaz", "Temesgen", "Zewditu",
  "Daniel", "Kidist", "Elias", "Helen", "Getachew", "Meseret", "Mulugeta", "Saba",
  "Tewodros", "Bethlehem", "Abraham", "Yeshi", "Yohannes", "Tsehay", "Fikru", "Alem",
  "Tadesse", "Fikirte", "Alemayehu", "Aynalem", "Dereje", "Sindu", "Bekele", "Wubit",
  "Ayele", "Emebet", "Habtamu", "Tizita", "Endale", "Bezawit", "Chala", "Mulu",
  "Guta", "Eyerusalem", "Lemma", "Ebisa", "Kenenisa", "Beamlak", "Tolosa", "Derartu",
  "Haile", "Almitu", "Mekonnen", "Chaltu", "Wondimu", "Bontu", "Gadisa", "Ejigayehu",
  "Obsa", "Rukiya", "Tariku", "Feyisa", "Lelisa", "Senay", "Mosisa", "Firaol",
  "Gemechu", "Kuulani", "Robel", "Nardos", "Abdi", "Iman", "Mustafa", "Halima"
];

const LAST_INITIALS = [
  "A", "B", "T", "M", "G", "K", "H", "D", "S", "Y",
  "W", "N", "F", "R", "L", "Z", "E", "C", "O", "J"
];

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
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    const a = Buffer.from(calc, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const userRaw = params.get("user");
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

function extractInitData(req) {
  return (
    req.headers["x-init"] ||
    req.headers["x-telegram-init-data"] ||
    req.body?.initData ||
    req.query?.initData ||
    null
  );
}

// ============================================================
// TELEGRAM NOTIFY HELPER
// ============================================================

async function tgNotify(chatId, text) {
  if (!ADMIN_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
    });
  } catch (e) {
    console.error("tg notify:", e.message);
  }
}

// ============================================================
// ENSURE USER
// ============================================================

async function ensureUser(tgUser) {
  const existing = await pool.query(
    `SELECT telegram_id, balance FROM users WHERE telegram_id = $1`,
    [tgUser.id]
  );

  if (existing.rows.length) {
    await pool.query(
      `UPDATE users
       SET username = $1, first_name = $2, last_name = $3, updated_at = NOW()
       WHERE telegram_id = $4`,
      [
        tgUser.username || null,
        tgUser.first_name || null,
        tgUser.last_name || null,
        tgUser.id
      ]
    );
    return { isNew: false, balance: Number(existing.rows[0].balance) };
  }

  const inserted = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, balance)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING balance`,
    [
      tgUser.id,
      tgUser.username || null,
      tgUser.first_name || null,
      tgUser.last_name || null,
      WELCOME_BONUS
    ]
  );

  if (WELCOME_BONUS > 0) {
    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount, status)
       VALUES ($1, 'welcome_bonus', $2, 'completed')`,
      [tgUser.id, WELCOME_BONUS]
    );
  }

  console.log(
    `🎁 Welcome bonus ${WELCOME_BONUS} birr → user ${tgUser.id} (${tgUser.first_name || tgUser.username || "new"})`
  );

  return { isNew: true, balance: Number(inserted.rows[0].balance) };
}

async function authMiddleware(req, res, next) {
  try {
    const tgUser = validateInitData(extractInitData(req));
    if (!tgUser) {
      return res.status(401).json({ error: "Invalid Telegram Mini App authentication" });
    }
    req.tgUser = tgUser;
    const { isNew } = await ensureUser(tgUser);
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

const apiLimiter = rateLimit({
  windowMs: 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", apiLimiter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ============================================================
// POSTGRES
// ============================================================

if (!DATABASE_URL) console.error("❌ DATABASE_URL missing");
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing — auth will fail");
if (!ADMIN_TG_ID) console.warn("⚠️ ADMIN_TG_ID missing — admin notifications disabled");

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", (err) => console.error("pg pool:", err));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      is_bot BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_id TEXT,
      phone TEXT,
      note TEXT,
      auto BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Extend existing table (safe on re-deploy)
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note TEXT;`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;`);

  // Unique index on tx_id (partial, so legacy NULL rows are allowed)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_tx_id_unique
      ON transactions (tx_id)
      WHERE tx_id IS NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      amount NUMERIC(18,2) NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      code TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(telegram_id, code)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      round_number INTEGER NOT NULL,
      phase TEXT NOT NULL,
      drawn INTEGER[] NOT NULL DEFAULT '{}',
      winner_names TEXT[],
      winner_card INTEGER,
      prize NUMERIC(18,2) NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
  `);

  // Seed default promo codes (only if table is empty)
  const pc = await pool.query(`SELECT COUNT(*)::int AS n FROM promo_codes`);
  if (pc.rows[0].n === 0) {
    await pool.query(`
      INSERT INTO promo_codes (code, amount, max_uses) VALUES
        ('WELCOME20', 20, 1000),
        ('ZOMA50',    50, 500),
        ('BINGO100', 100, 200)
      ON CONFLICT (code) DO NOTHING;
    `);
    console.log("🎟️  Seeded default promo codes");
  }

  console.log("✅ Database initialized");
}

// ============================================================
// BOT SEEDING
// ============================================================

const BOT_ID_BASE = 9000000000000;

async function seedBots() {
  console.log(`🤖 Seeding ${BOT_COUNT} bots with ${BOT_BALANCE} birr each…`);

  for (let i = 0; i < BOT_COUNT; i++) {
    const botId = BOT_ID_BASE + i;
    const botName = pickBotName(i);
    await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, balance, is_bot)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (telegram_id)
       DO UPDATE SET
         first_name = $3,
         balance = $4,
         is_bot = TRUE,
         updated_at = NOW()`,
      [botId, null, botName, BOT_BALANCE]
    );
  }

  console.log(`✅ ${BOT_COUNT} named bots ready (each ${BOT_BALANCE} birr)`);
}

// ============================================================
// CARD LOGIC
// ============================================================

function seeded(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cardFor(no) {
  const r = seeded(((no * 2654435761) >>> 0) ^ 0x9e3779b9);
  const cols = [0, 1, 2, 3, 4].map((c) => {
    const a = Array.from({ length: 15 }, (_, i) => c * 15 + i + 1);
    for (let i = 14; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, 5);
  });
  const card = [0, 1, 2, 3, 4].map((row) => cols.map((c) => c[row]));
  card[2][2] = 0;
  return card;
}

// ============================================================
// GAME STATE
// ============================================================

const game = {
  phase: "lobby",
  countdown: null,
  drawn: [],
  drawnSet: new Set(),
  prize: 0,
  players: new Map(),
  cards: new Map(),
  pendingCards: new Set(),
  bots: [],
  winner: null,
  lobbyTimer: null,
  callTimer: null,
  endTimer: null,
  botSetup: false
};

function drawnPrize() {
  return Math.max(0, Math.floor(game.cards.size * CARD_PRICE * (1 - HOUSE_CUT)));
}

function publicState(forTgId) {
  const cardsForUser = [];
  for (const entry of game.cards.values()) {
    if (String(entry.owner) === String(forTgId)) cardsForUser.push({ no: entry.cardNo, card: cardFor(entry.cardNo) });
  }

  const taken = [...new Set([...game.cards.values()].map(entry => entry.cardNo).concat([...game.pendingCards]))];

  const winnerPayload = game.winner
    ? {
        names: game.winner.names,
        prize: game.winner.prize,
        card: game.winner.card,
        you: game.winner.tgId === forTgId
      }
    : null;

  return {
    type: "state",
    phase: game.phase,
    countdown: game.countdown,
    drawn: game.drawn,
    prize: drawnPrize(),
    players: [...game.players.values()].filter((p) => !p.isBot).length,
    bots: game.bots.length,
    taken,
    max: MAX_CARDS_PER_PLAYER,
    price: CARD_PRICE,
    cards: cardsForUser,
    winner: winnerPayload
  };
}

function sendState() {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(publicState(ws.tgId))); } catch {}
    }
  }
}

function broadcastWinnerPopup(payload) {
  const msg = JSON.stringify({ type: "winner_popup", ...payload });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  }
}

// ============================================================
// GAME LOOP
// ============================================================

async function startLobby() {
  clearTimers();
  game.phase = "lobby";
  game.countdown = null;
  game.drawn = [];
  game.drawnSet = new Set();
  game.cards.clear();
  game.pendingCards.clear();
  game.bots = [];
  game.winner = null;
  game.prize = 0;

  game.botSetup = true;
  sendState();
  try {
    await addBots();
  } catch (err) {
    console.error("bot lobby setup:", err);
  } finally {
    game.botSetup = false;
  }
  sendState();

  if (game.phase === "lobby" && !game.lobbyTimer) startCountdown();
}

function startCountdown() {
  if (game.phase !== "lobby" || game.botSetup || game.lobbyTimer) return;
  game.countdown = LOBBY_COUNTDOWN;
  sendState();

  game.lobbyTimer = setInterval(() => {
    game.countdown -= 1;
    if (game.countdown <= 0) {
      clearInterval(game.lobbyTimer);
      game.lobbyTimer = null;
      startRound();
      return;
    }
    sendState();
  }, 1000);
}

async function addBots() {
  game.bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const botTgId = BOT_ID_BASE + i, botName = pickBotName(i), botCards = [];
    const nCards = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < nCards; k++) {
      let n = 0, attempts = 0;
      do { n = 1 + Math.floor(Math.random() * TOTAL_CARDS); attempts++; }
      while (([...game.cards.values()].some(entry => entry.cardNo === n) || game.pendingCards.has(n) || botCards.includes(n)) && attempts < 2000);
      if ([...game.cards.values()].some(entry => entry.cardNo === n) || game.pendingCards.has(n) || botCards.includes(n)) break;
      botCards.push(n);
      game.cards.set(`${botTgId}:${n}`, { cardNo: n, owner: botTgId });
      sendState();
    }
    game.bots.push({ id: i, tgId: botTgId, names: [botName], cards: botCards });
    try {
      await pool.query(`UPDATE users SET balance = GREATEST(0, balance - $1), updated_at = NOW() WHERE telegram_id = $2`,
        [botCards.length * CARD_PRICE, botTgId]);
    } catch (err) { console.error("bot card purchase:", err); }
  }
}

async function startRound() {
  if (game.phase === "playing" || game.phase === "over") return;

  game.phase = "playing";
  game.countdown = null;
  sendState();

  try {
    await pool.query(
      `INSERT INTO rounds (round_number, phase, drawn, prize)
       VALUES ((SELECT COALESCE(MAX(round_number),0)+1 FROM rounds), 'playing', $1, $2)`,
      [game.drawn, drawnPrize()]
    );
  } catch (err) {
    console.error("round insert:", err);
  }

  game.callTimer = setInterval(callNext, CALL_INTERVAL_MS);
  setTimeout(callNext, 1500);
}

function callNext() {
  if (game.phase !== "playing") return;

  const remaining = [];
  for (let n = 1; n <= 75; n++) if (!game.drawnSet.has(n)) remaining.push(n);

  if (!remaining.length) return finishRound(null);

  const n = remaining[Math.floor(Math.random() * remaining.length)];
  game.drawn.push(n);
  game.drawnSet.add(n);

  const winners = findWinners();
  if (winners.length) return finishRound(winners);

  sendState();
}

function winningPattern(card, drawnSet) {
  const marked = card.map(row => row.map(n => n === 0 || drawnSet.has(n)));
  for (let r = 0; r < 5; r++) if (marked[r].every(Boolean)) return `Row ${r + 1}`;
  for (let c = 0; c < 5; c++) if (marked.every(row => row[c])) return `Column ${c + 1}`;
  if ([0,1,2,3,4].every(i => marked[i][i])) return "Diagonal ↘";
  if ([0,1,2,3,4].every(i => marked[i][4-i])) return "Diagonal ↙";
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
    found.push({ names: isBot ? (bot ? bot.names : [pickBotName(ownerNum - BOT_ID_BASE)]) :
      (player ? player.names : ["Player"]), card: entry.cardNo, tgId: ownerNum,
      owner: entry.owner, pattern, isBot });
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
      await client.query(`UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2`, [share, winner.tgId]);
      await client.query(`INSERT INTO transactions (telegram_id, type, amount, status) VALUES ($1,'win',$2,'completed')`, [winner.tgId, share]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); console.error("payout:", e); }
    finally { client.release(); }
  }

  broadcastWinnerPopup({
    winners: allWinners.map(w => ({ names: w.names, cardNo: w.card, prize: share, pattern: w.pattern,
      isBot: w.isBot, card: cardFor(w.card) })),
    names: allWinners.flatMap(w => w.names), cardNo: allWinners[0]?.card ?? null, prize: poolPrize,
    isBot: allWinners.length > 0 && allWinners.every(w => w.isBot),
    card: allWinners[0] ? cardFor(allWinners[0].card) : null, drawn: game.drawn,
    duration: WINNER_POPUP_SECONDS * 1000
  });

  if (!allWinners.length) console.log("🏁 No winner this round");
  else console.log(`🏆 ${allWinners.length} winner(s), pool ${poolPrize} birr, share ${share} birr each`);

  try {
    await pool.query(`UPDATE rounds SET phase='over', drawn=$1, winner_names=$2, winner_card=$3, prize=$4, ended_at=NOW()
      WHERE id = (SELECT id FROM rounds ORDER BY id DESC LIMIT 1)`,
      [game.drawn, allWinners.length ? allWinners.flatMap(w => w.names) : null, allWinners[0]?.card ?? null, poolPrize]);
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
// DEPOSIT AUTO-VERIFY (receipt scraper — optional)
// ============================================================

async function verifyTelebirrReceipt(txId) {
  // Try the official receipt page. It's an SPA, so we look for a JSON endpoint
  // first; if that fails, we give up and fall through to manual review.
  try {
    const url = `https://transactioninfo.ethiotelecom.et/api/receipt/${encodeURIComponent(txId)}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ZomaBingo/1.0)",
        "Accept": "application/json",
        "Referer": "https://transactioninfo.ethiotelecom.et/"
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const d = await r.json();

    const amount = Number(d.amount ?? d.transactionAmount ?? 0);
    const receiver = String(d.receiverName ?? d.receiver ?? "").trim();
    const status = String(d.status ?? d.transactionStatus ?? "").toLowerCase();
    const dateStr = d.date ?? d.transactionDate ?? null;

    if (!amount) return { ok: false, reason: "No amount in receipt" };
    if (!["completed", "success", "successful"].includes(status))
      return { ok: false, reason: `Status "${status}"` };

    if (dateStr) {
      const ts = Date.parse(dateStr);
      if (!Number.isNaN(ts)) {
        const ageH = (Date.now() - ts) / 36e5;
        if (ageH > RECEIPT_MAX_AGE_HOURS)
          return { ok: false, reason: `Receipt older than ${RECEIPT_MAX_AGE_HOURS}h` };
      }
    }

    return { ok: true, amount, receiver, status, date: dateStr };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ============================================================
// CORE: process a verified incoming payment
// ============================================================

/**
 * Called from the SMS webhook OR the receipt verifier.
 * Finds a matching pending deposit (by txId or amount),
 * credits the user, marks the deposit approved.
 */
async function creditDeposit({ txId, amount, source = "auto", note = null }) {
  // Already credited?
  const dupe = await pool.query(
    `SELECT id, status FROM transactions WHERE tx_id = $1 LIMIT 1`,
    [txId]
  );
  if (dupe.rows.length) {
    if (dupe.rows[0].status === "approved") {
      return { status: "duplicate", message: "Already approved" };
    }
  }

  // Find matching pending deposit
  let pending = await pool.query(
    `SELECT id, telegram_id, amount FROM transactions
     WHERE tx_id = $1 AND type = 'deposit' AND status = 'pending' LIMIT 1`,
    [txId]
  );

  // Fallback: match by amount within the last 30 minutes
  if (!pending.rows.length) {
    pending = await pool.query(
      `SELECT id, telegram_id, amount FROM transactions
       WHERE type = 'deposit' AND status = 'pending'
         AND amount = $1
         AND created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at ASC LIMIT 1`,
      [amount]
    );
  }

  if (!pending.rows.length) {
    // Orphan receipt — save for admin to see
    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, tx_id, note, auto)
       VALUES (0, 'deposit_orphan', $1, 'pending', $2, $3, $4)`,
      [amount, txId, note || `Unmatched ${source} receipt`, source === "auto"]
    );
    if (ADMIN_TG_ID) {
      await tgNotify(ADMIN_TG_ID,
        `⚠️ <b>Orphan ${source} receipt</b>\n` +
        `Amount: ${amount} birr\nTxID: ${txId}\n` +
        `No matching pending deposit.`);
    }
    return { status: "orphan", message: "No matching deposit" };
  }

  const dep = pending.rows[0];

  // Amount sanity check
  if (Number(dep.amount) !== Number(amount)) {
    await pool.query(
      `UPDATE transactions SET status='pending', note=$1 WHERE id=$2`,
      [`Amount mismatch: claimed ${dep.amount}, received ${amount}`, dep.id]
    );
    if (ADMIN_TG_ID) {
      await tgNotify(ADMIN_TG_ID,
        `⚠️ <b>Amount mismatch</b>\n` +
        `User ${dep.telegram_id}\nClaimed: ${dep.amount} birr\nReceived: ${amount} birr\nTxID: ${txId}`);
    }
    return { status: "mismatch", message: "Amount mismatch" };
  }

  // Credit
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2`,
      [amount, dep.telegram_id]
    );
    await client.query(
      `UPDATE transactions SET status='approved', tx_id=$1, auto=$2, note=$3 WHERE id=$4`,
      [txId, source === "auto", note, dep.id]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("credit deposit:", e);
    return { status: "error", message: "DB error" };
  } finally {
    client.release();
  }

  const newBal = await getBalance(dep.telegram_id);

  // Notify player
  for (const ws of wss.clients) {
    if (String(ws.tgId) === String(dep.telegram_id) && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "balance", balance: newBal }));
        ws.send(JSON.stringify({ type: "error", msg: `✅ Deposit ${amount} birr approved!` }));
      } catch {}
    }
  }
  await tgNotify(dep.telegram_id, `✅ <b>Deposit approved</b>\n${amount} birr added to your balance.\nNew balance: ${newBal} birr`);

  if (ADMIN_TG_ID) {
    await tgNotify(ADMIN_TG_ID,
      `✅ <b>Deposit approved (${source})</b>\nUser: ${dep.telegram_id}\nAmount: ${amount} birr\nTxID: ${txId}`);
  }

  console.log(`💰 Deposit ${amount} birr approved for ${dep.telegram_id} (${source}) TxID=${txId}`);
  return { status: "approved", balance: newBal, telegram_id: dep.telegram_id };
}

// ============================================================
// WEBSOCKET
// ============================================================

wss.on("connection", (ws) => {
  ws.tgId = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "auth") {
      const tg = validateInitData(msg.initData);
      if (!tg) {
        try { ws.send(JSON.stringify({ type: "error", msg: "Invalid Telegram authentication" })); } catch {}
        return;
      }

      if (Number(tg.id) >= BOT_ID_BASE) {
        try { ws.send(JSON.stringify({ type: "error", msg: "Invalid user" })); } catch {}
        return;
      }

      ws.tgId = tg.id;

      const { isNew, balance } = await ensureUser(tg);
      const names = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || `Player ${String(tg.id).slice(-4)}`;
      if (!game.players.has(tg.id)) {
        game.players.set(tg.id, { names: [names], isBot: false });
      }

      try { ws.send(JSON.stringify({ type: "balance", balance })); } catch {}
      try { ws.send(JSON.stringify(publicState(tg.id))); } catch {}

      if (isNew) {
        try { ws.send(JSON.stringify({ type: "error", msg: `🎁 Welcome! You got ${WELCOME_BONUS} birr free.` })); } catch {}
      }

      if (game.phase === "lobby" && !game.botSetup && !game.lobbyTimer && game.players.size >= 1) {
        startCountdown();
      }
      return;
    }

    if (msg.type === "join") {
      if (!ws.tgId) {
        try { ws.send(JSON.stringify({ type: "error", msg: "Not authenticated" })); } catch {}
        return;
      }
      if (game.phase !== "lobby") {
        try { ws.send(JSON.stringify({ type: "error", msg: "Round already started" })); } catch {}
        return;
      }

      const requested = Array.isArray(msg.cards) ? msg.cards : [];
      const player = game.players.get(ws.tgId);
      if (!player) {
        try { ws.send(JSON.stringify({ type: "error", msg: "Not registered" })); } catch {}
        return;
      }

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

      if (!take.length) {
        try { ws.send(JSON.stringify({ type: "error", msg: "No valid cards to buy" })); } catch {}
        return;
      }

      for (const n of take) game.pendingCards.add(n);
      let client;
      try {
        client = await pool.connect();
      } catch (e) {
        for (const n of take) game.pendingCards.delete(n);
        console.error("join connection:", e);
        try { ws.send(JSON.stringify({ type: "error", msg: "Could not connect to the database" })); } catch {}
        return;
      }
      try {
        await client.query("BEGIN");
        const u = await client.query(
          `SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
          [ws.tgId]
        );
        const bal = Number(u.rows[0]?.balance || 0);
        if (bal < cost) {
          await client.query("ROLLBACK");
          for (const n of take) game.pendingCards.delete(n);
          try { ws.send(JSON.stringify({ type: "error", msg: `Not enough balance. Need ${cost} birr.` })); } catch {}
          return;
        }
        await client.query(
          `UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2`,
          [cost, ws.tgId]
        );
        for (const n of take) {
          await client.query(
            `INSERT INTO transactions (telegram_id, type, amount, status) VALUES ($1,'card',$2,'completed')`,
            [ws.tgId, CARD_PRICE]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        console.error("join txn:", e);
        for (const n of take) game.pendingCards.delete(n);
        try { ws.send(JSON.stringify({ type: "error", msg: "Could not buy cards" })); } catch {}
        return;
      } finally {
        client.release();
      }

      for (const n of take) {
        game.pendingCards.delete(n);
        game.cards.set(`${ws.tgId}:${n}`, { cardNo: n, owner: ws.tgId });
      }

      try { ws.send(JSON.stringify({ type: "balance", balance: await getBalance(ws.tgId) })); } catch {}
      sendState();

      if (!game.lobbyTimer && game.phase === "lobby" && game.cards.size > 0) {
        startCountdown();
      }
      return;
    }
  });

  ws.on("close", () => {});
  ws.on("error", () => {});
});

// ============================================================
// REST — USER
// ============================================================

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT telegram_id, username, first_name, last_name, balance FROM users WHERE telegram_id = $1`,
      [req.tgUser.id]
    );
    const u = r.rows[0];
    res.json({
      balance: Number(u?.balance || 0),
      tg: { id: req.tgUser.id, username: req.tgUser.username, first_name: req.tgUser.first_name },
      tb: { number: TB_NUMBER, name: TB_NAME },
      limits: { min: MIN_DEPOSIT, max: MAX_DEPOSIT }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load user" });
  }
});

app.get("/api/history", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT type AS kind, amount, status, created_at
       FROM transactions
       WHERE telegram_id = $1 AND type IN ('deposit','withdraw','win','promo','welcome_bonus')
       ORDER BY id DESC LIMIT 50`,
      [req.tgUser.id]
    );
    res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "History failed" });
  }
});

// ============================================================
// DEPOSIT — request + auto-verify attempt
// ============================================================

app.post("/api/deposit", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);
  const txId = String(req.body?.txId || "").trim().toUpperCase();

  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
    return res.status(400).json({ error: `Amount must be between ${MIN_DEPOSIT} and ${MAX_DEPOSIT} birr` });
  }
  if (!txId || !/^DJ[A-Z0-9]{8,}$/.test(txId)) {
    return res.status(400).json({ error: "Invalid transaction ID (should look like DJ53G7TAZ1)" });
  }

  try {
    // Fast duplicate check
    const dupe = await pool.query(
      `SELECT id, status FROM transactions WHERE tx_id = $1 LIMIT 1`,
      [txId]
    );
    if (dupe.rows.length) {
      if (dupe.rows[0].status === "approved") {
        return res.status(400).json({ error: "This transaction was already approved" });
      }
      return res.status(400).json({ error: "This transaction ID is already being processed" });
    }

    // Insert as pending first
    const ins = await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, tx_id)
       VALUES ($1, 'deposit', $2, 'pending', $3) RETURNING id`,
      [req.tgUser.id, amount, txId]
    );
    const depId = ins.rows[0].id;

    // Try auto-verify via receipt endpoint
    const v = await verifyTelebirrReceipt(txId);
    if (v.ok && Number(v.amount) === amount) {
      const r = await creditDeposit({ txId, amount, source: "auto", note: "Auto-verified via receipt" });
      if (r.status === "approved") {
        return res.json({ status: "approved", amount, balance: r.balance });
      }
    }

    // Fall through to manual review
    if (ADMIN_TG_ID) {
      await tgNotify(ADMIN_TG_ID,
        `🔔 <b>New deposit (pending)</b>\n` +
        `User: ${req.tgUser.id} (${req.tgUser.first_name || req.tgUser.username || "?"})\n` +
        `Amount: ${amount} birr\nTxID: ${txId}\n` +
        `Auto-verify: ${v.ok ? "matched amount but not credited" : v.reason}\n` +
        `Approve with: /approve_${depId}`);
    }

    res.json({ status: "pending", depId });
  } catch (err) {
    console.error("deposit:", err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

// ============================================================
// WITHDRAW
// ============================================================

app.post("/api/withdraw", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);
  const phone = String(req.body?.phone || "").trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  if (!/^0?9\d{8}$/.test(phone)) {
    return res.status(400).json({ error: "Invalid Telebirr phone number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      `SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
      [req.tgUser.id]
    );
    const bal = Number(u.rows[0]?.balance || 0);

    if (bal < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient balance" });
    }

    await client.query(
      `UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2`,
      [amount, req.tgUser.id]
    );
    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, phone)
       VALUES ($1, 'withdraw', $2, 'pending', $3)`,
      [req.tgUser.id, amount, phone]
    );

    await client.query("COMMIT");
    const newBal = await getBalance(req.tgUser.id);

    if (ADMIN_TG_ID) {
      await tgNotify(ADMIN_TG_ID,
        `💸 <b>Withdrawal request</b>\n` +
        `User: ${req.tgUser.id}\nAmount: ${amount} birr\nPhone: ${phone}`);
    }

    res.json({ balance: newBal });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Withdrawal failed" });
  } finally {
    client.release();
  }
});

// ============================================================
// PROMO CODE
// ============================================================

app.post("/api/promo", authMiddleware, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter a code" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query(
      `SELECT code, amount, max_uses, uses, active FROM promo_codes WHERE code = $1 FOR UPDATE`,
      [code]
    );
    if (!c.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Invalid code" }); }
    const p = c.rows[0];
    if (!p.active) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Code expired" }); }
    if (p.uses >= p.max_uses) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Code fully redeemed" }); }

    const used = await client.query(
      `SELECT 1 FROM promo_redemptions WHERE telegram_id = $1 AND code = $2`,
      [req.tgUser.id, code]
    );
    if (used.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "You already used this code" }); }

    const amt = Number(p.amount);
    await client.query(`UPDATE promo_codes SET uses = uses + 1 WHERE code = $1`, [code]);
    await client.query(
      `INSERT INTO promo_redemptions (telegram_id, code) VALUES ($1, $2)`,
      [req.tgUser.id, code]
    );
    await client.query(
      `UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2`,
      [amt, req.tgUser.id]
    );
    await client.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, note)
       VALUES ($1, 'promo', $2, 'completed', $3)`,
      [req.tgUser.id, amt, `Promo ${code}`]
    );
    await client.query("COMMIT");

    const newBal = await getBalance(req.tgUser.id);
    res.json({ amount: amt, balance: newBal });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("promo:", err);
    res.status(500).json({ error: "Promo failed" });
  } finally {
    client.release();
  }
});

// ============================================================
// SMS FORWARDER WEBHOOK  (admin phone → server)
// ============================================================

app.post("/webhook/sms", async (req, res) => {
  if (req.query.secret !== SMS_SECRET) {
    console.warn("sms webhook: bad secret");
    return res.status(403).json({ error: "Forbidden" });
  }

  const text = String(req.body?.text || req.body?.message || "");
  console.log("📩 SMS:", text.slice(0, 200));

  // Sample Telebirr credit SMS:
  //   "You have received 100.00 birr from 0911223344 (Abebe). Your balance is 550.00 birr. Transaction ID DJ53G7TAZ1."
  const m = text.match(
    /received\s+([\d.,]+)\s*birr[\s\S]*?Transaction\s*ID\s*[: ]?\s*(DJ[A-Z0-9]{6,})/i
  );
  if (!m) return res.json({ ok: true, ignored: true });

  const amount = Number(m[1].replace(/,/g, ""));
  const txId = m[2].toUpperCase();

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.json({ ok: true, ignored: true });
  }

  try {
    const r = await creditDeposit({
      txId,
      amount,
      source: "auto",
      note: "Auto-verified via admin SMS forwarder"
    });
    res.json({ ok: true, result: r });
  } catch (err) {
    console.error("sms webhook:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// ADMIN PANEL (simple password-protected HTML page)
// ============================================================

const adminHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zoma Admin</title>
<style>
body{margin:0;background:#171a43;color:#f4f2ff;font:500 15px/1.4 system-ui,sans-serif;padding:14px}
h1{font-size:20px;margin:0 0 10px}
.card{background:#232763;border-radius:14px;padding:12px;margin:10px 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #3a3f86}
.row:last-child{border:0}
button{border:0;border-radius:10px;padding:8px 12px;font-weight:800;color:#fff;background:#22a06b;cursor:pointer}
button.red{background:#e8453c}
button.blue{background:#2f6bff}
small{color:#a9acd9}
input{width:100%;padding:10px;border-radius:10px;border:2px solid #3a3f86;background:#171a43;color:#fff;font:inherit}
.tag{display:inline-block;padding:2px 8px;border-radius:8px;font-size:12px;font-weight:800}
.pending{background:#f2b01e;color:#111}
.approved{background:#22a06b}
.rejected{background:#e8453c}
.orphan{background:#8e4dff}
</style></head><body>
<h1>🛠️ Zoma Admin</h1>
<div class="card">
  <label>Password</label>
  <input id="pw" type="password" placeholder="admin password">
  <button class="blue" id="login" style="margin-top:8px">Load</button>
  <small id="whoami"></small>
</div>
<div class="card" id="pendingBox"><h3>Pending deposits</h3><div id="pending">Login to load…</div></div>
<div class="card" id="orphanBox"><h3>Orphan receipts (unmatched)</h3><div id="orphans">Login to load…</div></div>
<div class="card" id="wdBox"><h3>Pending withdrawals</h3><div id="withdrawals">Login to load…</div></div>
<script>
const $ = (id) => document.getElementById(id);
let pw = "";
async function api(path, method="GET", body=null){
  const r = await fetch(path,{method,headers:{"Content-Type":"application/json","x-admin-pw":pw},body: body?JSON.stringify(body):null});
  const j = await r.json(); if(!r.ok) throw new Error(j.error||"Error"); return j;
}
function row(l, r){ return '<div class="row"><span>'+l+'</span>'+r+'</div>'; }
async function load(){
  try{
    const d = await api("/api/admin/pending");
    $("pending").innerHTML = d.items.length ? d.items.map(i=>
      row(
        "<b>"+i.telegram_id+"</b> · "+i.amount+" birr<br><small>Tx: "+i.tx_id+" · "+new Date(i.created_at).toLocaleString()+"</small>",
        '<button data-id="'+i.id+'" class="ok">Approve</button> <button data-id="'+i.id+'" class="red no">Reject</button>'
      )
    ).join("") : "<small>No pending deposits.</small>";

    const o = await api("/api/admin/orphans");
    $("orphans").innerHTML = o.items.length ? o.items.map(i=>
      row(
        "<b>"+i.amount+" birr</b> · Tx: "+i.tx_id+"<br><small>"+(i.note||"")+"</small>",
        '<button data-id="'+i.id+'" class="ok">Credit user…</button>'
      )
    ).join("") : "<small>None.</small>";

    const w = await api("/api/admin/withdrawals");
    $("withdrawals").innerHTML = w.items.length ? w.items.map(i=>
      row(
        "<b>"+i.telegram_id+"</b> · "+i.amount+" birr → "+i.phone,
        '<button data-id="'+i.id+'" class="blue paid">Mark paid</button> <button data-id="'+i.id+'" class="red wr">Reject</button>'
      )
    ).join("") : "<small>None.</small>";

    $("pending").querySelectorAll("button.ok").forEach(b=>b.onclick=()=>approve(b.dataset.id));
    $("pending").querySelectorAll("button.no").forEach(b=>b.onclick=()=>rejectDep(b.dataset.id));
    $("withdrawals").querySelectorAll("button.paid").forEach(b=>b.onclick=()=>paidWd(b.dataset.id));
    $("withdrawals").querySelectorAll("button.wr").forEach(b=>b.onclick=()=>rejectWd(b.dataset.id));
  }catch(e){ alert(e.message); }
}
async function approve(id){ try{ await api("/api/admin/approve/"+id,"POST"); load(); }catch(e){ alert(e.message);} }
async function rejectDep(id){ const r=prompt("Reason?"); if(!r)return; try{ await api("/api/admin/reject/"+id,"POST",{reason:r}); load(); }catch(e){ alert(e.message);} }
async function paidWd(id){ try{ await api("/api/admin/withdraw-paid/"+id,"POST"); load(); }catch(e){ alert(e.message);} }
async function rejectWd(id){ try{ await api("/api/admin/withdraw-reject/"+id,"POST"); load(); }catch(e){ alert(e.message);} }
$("login").onclick = () => { pw = $("pw").value; $("whoami").textContent = "Password set"; load(); };
</script></body></html>`;

app.get("/admin", (req, res) => {
  res.type("html").send(adminHtml);
});

function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-pw"];
  if (!pw || pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/admin/pending", requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, telegram_id, amount, tx_id, created_at FROM transactions
     WHERE type='deposit' AND status='pending' ORDER BY id ASC LIMIT 200`
  );
  res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
});

app.get("/api/admin/orphans", requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, amount, tx_id, note, created_at FROM transactions
     WHERE type='deposit_orphan' AND status='pending' ORDER BY id DESC LIMIT 200`
  );
  res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
});

app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, telegram_id, amount, phone, created_at FROM transactions
     WHERE type='withdraw' AND status='pending' ORDER BY id ASC LIMIT 200`
  );
  res.json({ items: r.rows.map(x => ({ ...x, amount: Number(x.amount) })) });
});

app.post("/api/admin/approve/:id", requireAdmin, async (req, res) => {
  try {
    const dep = await pool.query(
      `SELECT id, telegram_id, amount, tx_id, status FROM transactions WHERE id=$1`,
      [req.params.id]
    );
    if (!dep.rows.length) return res.status(404).json({ error: "Not found" });
    if (dep.rows[0].status !== "pending")
      return res.status(400).json({ error: "Already handled" });

    const { telegram_id, amount, tx_id } = dep.rows[0];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users SET balance = balance + $1, updated_at=NOW() WHERE telegram_id=$2`,
        [amount, telegram_id]
      );
      await client.query(
        `UPDATE transactions SET status='approved', auto=FALSE, note='Manual admin approval' WHERE id=$1`,
        [dep.rows[0].id]
      );
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }

    const bal = await getBalance(telegram_id);
    for (const ws of wss.clients) if (String(ws.tgId) === String(telegram_id) && ws.readyState === 1)
      try {
        ws.send(JSON.stringify({ type: "balance", balance: bal }));
        ws.send(JSON.stringify({ type: "error", msg: `✅ Deposit ${amount} birr approved!` }));
      } catch {}
    await tgNotify(telegram_id, `✅ Deposit ${amount} birr approved. New balance: ${bal} birr`);

    res.json({ ok: true });
  } catch (e) {
    console.error("admin approve:", e);
    res.status(500).json({ error: "Approve failed" });
  }
});

app.post("/api/admin/reject/:id", requireAdmin, async (req, res) => {
  try {
    const reason = String(req.body?.reason || "Rejected by admin");
    const dep = await pool.query(
      `SELECT telegram_id, amount FROM transactions WHERE id=$1 AND status='pending'`,
      [req.params.id]
    );
    if (!dep.rows.length) return res.status(400).json({ error: "Not pending" });

    await pool.query(
      `UPDATE transactions SET status='rejected', note=$1 WHERE id=$2`,
      [reason, req.params.id]
    );
    await tgNotify(dep.rows[0].telegram_id,
      `❌ Deposit ${dep.rows[0].amount} birr rejected: ${reason}`);
    res.json({ ok: true });
  } catch (e) {
    console.error("admin reject:", e);
    res.status(500).json({ error: "Reject failed" });
  }
});

app.post("/api/admin/withdraw-paid/:id", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE transactions SET status='paid' WHERE id=$1 AND type='withdraw' AND status='pending' RETURNING telegram_id, amount`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ error: "Not pending" });
    await tgNotify(r.rows[0].telegram_id,
      `✅ Withdrawal ${r.rows[0].amount} birr has been paid to your Telebirr.`);
    res.json({ ok: true });
  } catch (e) {
    console.error("withdraw paid:", e);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/admin/withdraw-reject/:id", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `SELECT telegram_id, amount FROM transactions WHERE id=$1 AND type='withdraw' AND status='pending' FOR UPDATE`,
      [req.params.id]
    );
    if (!r.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Not pending" }); }
    const { telegram_id, amount } = r.rows[0];

    // Refund
    await client.query(`UPDATE users SET balance = balance + $1 WHERE telegram_id=$2`, [amount, telegram_id]);
    await client.query(`UPDATE transactions SET status='rejected' WHERE id=$1`, [req.params.id]);
    await client.query("COMMIT");

    await tgNotify(telegram_id, `❌ Withdrawal ${amount} birr was rejected. Funds returned to your balance.`);
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("withdraw reject:", e);
    res.status(500).json({ error: "Failed" });
  } finally {
    client.release();
  }
});

// Credit an orphan receipt to a specific user (admin-only)
app.post("/api/admin/credit-orphan/:id", requireAdmin, async (req, res) => {
  try {
    const targetUser = String(req.body?.telegram_id || "").trim();
    if (!targetUser) return res.status(400).json({ error: "telegram_id required" });

    const o = await pool.query(
      `SELECT id, amount, tx_id FROM transactions WHERE id=$1 AND type='deposit_orphan' AND status='pending'`,
      [req.params.id]
    );
    if (!o.rows.length) return res.status(400).json({ error: "Orphan not found" });

    const amount = Number(o.rows[0].amount);
    const txId = o.rows[0].tx_id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE telegram_id=$2`,
        [amount, targetUser]
      );
      await client.query(
        `UPDATE transactions SET type='deposit', telegram_id=$1, status='approved', auto=FALSE, note='Orphan credited by admin' WHERE id=$2`,
        [targetUser, o.rows[0].id]
      );
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }

    const bal = await getBalance(targetUser);
    for (const ws of wss.clients) if (String(ws.tgId) === String(targetUser) && ws.readyState === 1)
      try { ws.send(JSON.stringify({ type: "balance", balance: bal })); } catch {}
    await tgNotify(targetUser, `✅ Deposit ${amount} birr credited. New balance: ${bal} birr`);

    console.log(`🩹 Orphan ${txId} credited to ${targetUser}: ${amount} birr`);
    res.json({ ok: true });
  } catch (e) {
    console.error("credit orphan:", e);
    res.status(500).json({ error: "Failed" });
  }
});

// ============================================================
// HEALTH + FALLBACK
// ============================================================

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected", botToken: !!BOT_TOKEN, game: game.phase, bots: BOT_COUNT });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path.startsWith("/webhook") || req.path === "/admin") return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
// BOOT
// ============================================================

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🎱 Zoma Bingo on :${PORT}`);
  console.log(`💵 CARD_PRICE=${CARD_PRICE}  🏆 HOUSE_CUT=${HOUSE_CUT}`);
  console.log(`👥 MIN_PLAYERS=${MIN_PLAYERS_TO_START}  🤖 BOT_COUNT=${BOT_COUNT}  💰 BOT_BALANCE=${BOT_BALANCE}`);
  console.log(`🎁 WELCOME_BONUS=${WELCOME_BONUS} birr  🏆 POPUP=${WINNER_POPUP_SECONDS}s`);
  console.log(`💳 Telebirr: ${TB_NUMBER} (${TB_NAME})`);
  console.log(`🔐 Admin: /admin  |  SMS webhook: POST /webhook/sms?secret=***`);

  try {
    await initDatabase();
    console.log("✅ Database ready");
    await seedBots();
    startLobby();
  } catch (err) {
    console.error("❌ Startup error:", err);
  }
});

async function shutdown(sig) {
  console.log(`🛑 ${sig}`);
  clearTimers();
  for (const ws of wss.clients) { try { ws.close(); } catch {} }
  try { await pool.end(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
