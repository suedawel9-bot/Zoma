// ============================================================
// ZOMA BINGO — Telegram Mini App Server
// Matches public/index.html + public/cards.js contract
// Updated: 2026-10-07
// ============================================================

console.log("🔥 ZOMA BINGO SERVER 2026-10-07");

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

// Game settings
const CARD_PRICE = Number(process.env.CARD_PRICE || 10);       // birr per card
const HOUSE_CUT = Number(process.env.HOUSE_CUT || 0);         // 0..1
const TOTAL_CARDS = 500;                                      // matches cards.js
const MAX_CARDS_PER_PLAYER = 4;
const MIN_PLAYERS_TO_START = 2;                               // humans + bots
const LOBBY_COUNTDOWN = Number(process.env.ROUND_COUNTDOWN || 30);
const CALL_INTERVAL_MS = Number(process.env.CALL_INTERVAL_MS || 3500);
const WINNER_POPUP_SECONDS = Number(process.env.WINNER_POPUP_SECONDS || 4);
const BOT_COUNT = Number(process.env.BOT_COUNT || 3);         // bots to add each round

// Telebirr receiving account (shown to depositors)
const TB_NUMBER = process.env.TB_NUMBER || "0911-000-000";
const TB_NAME = process.env.TB_NAME || "Zoma Bingo";

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

// Accept initData via x-init (frontend) OR x-telegram-init-data OR body/query
function extractInitData(req) {
  return (
    req.headers["x-init"] ||
    req.headers["x-telegram-init-data"] ||
    req.body?.initData ||
    req.query?.initData ||
    null
  );
}

async function authMiddleware(req, res, next) {
  try {
    const tgUser = validateInitData(extractInitData(req));
    if (!tgUser) {
      return res.status(401).json({ error: "Invalid Telegram Mini App authentication" });
    }
    req.tgUser = tgUser;

    await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         updated_at = NOW()`,
      [
        tgUser.id,
        tgUser.username || null,
        tgUser.first_name || null,
        tgUser.last_name || null
      ]
    );

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

// ============================================================
// HTTP + WS
// ============================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ============================================================
// POSTGRES
// ============================================================

if (!DATABASE_URL) console.error("❌ DATABASE_URL missing");
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing — auth will fail");

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  console.log("✅ Database initialized");
}

// ============================================================
// CARD LOGIC (mirror of public/cards.js)
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

function hasLine(card, drawnSet) {
  const marked = card.map((row) => row.map((n) => n === 0 || drawnSet.has(n)));
  for (let r = 0; r < 5; r++) if (marked[r].every(Boolean)) return true;
  for (let c = 0; c < 5; c++) {
    let ok = true;
    for (let r = 0; r < 5; r++) if (!marked[r][c]) { ok = false; break; }
    if (ok) return true;
  }
  if (marked[0][0] && marked[1][1] && marked[2][2] && marked[3][3] && marked[4][4]) return true;
  if (marked[0][4] && marked[1][3] && marked[2][2] && marked[3][1] && marked[4][0]) return true;
  return false;
}

// ============================================================
// IN-MEMORY GAME STATE
// ============================================================

/*
  state = {
    phase: 'lobby' | 'playing' | 'over',
    countdown: number | null,
    drawn: number[],
    drawnSet: Set<number>,
    prize: number,
    players: Map<telegramId, { names: string[], isBot: boolean }>,
    cards: Map<cardNo, telegramId>,   // which player owns card #
    bots: [{ id, names, cards: [1,2] }],
    winner: null | { names, card, prize, you? }
  }
*/

const game = {
  phase: "lobby",
  countdown: null,
  drawn: [],
  drawnSet: new Set(),
  prize: 0,
  players: new Map(),       // telegramId -> { names, isBot }
  cards: new Map(),         // cardNo -> telegramId (or 'bot:ID')
  bots: [],                 // [{ id, names, cards }]
  winner: null,
  lobbyTimer: null,
  callTimer: null,
  endTimer: null
};

function drawnPrize() {
  return Math.max(0, Math.floor(game.cards.size * CARD_PRICE * (1 - HOUSE_CUT)));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch {}
    }
  }
}

// Build state payload for a specific user (or anonymous)
function publicState(forTgId) {
  const cardsForUser = [];
  for (const [cardNo, owner] of game.cards) {
    const isMine = owner === forTgId;
    const ownerObj = typeof owner === "string" && owner.startsWith("bot:")
      ? game.bots.find((b) => `bot:${b.id}` === owner)
      : game.players.get(owner);

    // Only send the user their own cards
    if (isMine) {
      cardsForUser.push({ no: cardNo, card: cardFor(cardNo) });
    }
  }

  // Taken = every card number already purchased (humans + bots)
  const taken = [...game.cards.keys()].sort((a, b) => a - b);

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

// ============================================================
// GAME LOOP
// ============================================================

function startLobby() {
  clearTimers();
  game.phase = "lobby";
  game.countdown = null;
  game.drawn = [];
  game.drawnSet = new Set();
  game.cards.clear();
  game.bots = [];
  game.winner = null;
  game.prize = 0;
  sendState();
}

function startCountdown() {
  if (game.phase !== "lobby") return;
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

function addBots() {
  game.bots = [];
  const usedCards = new Set(game.cards.keys());
  for (let i = 0; i < BOT_COUNT; i++) {
    const names = [`Bot ${i + 1}`];
    const botCards = [];
    // give each bot 1–2 random unused cards
    const nCards = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < nCards; k++) {
      let n;
      let guard = 0;
      do {
        n = 1 + Math.floor(Math.random() * TOTAL_CARDS);
        guard++;
      } while (usedCards.has(n) && guard < 5000);
      if (usedCards.has(n)) continue;
      usedCards.add(n);
      botCards.push(n);
      game.cards.set(n, `bot:${i}`);
    }
    game.bots.push({ id: i, names, cards: botCards });
  }
}

async function startRound() {
  if (game.phase === "playing" || game.phase === "over") return;

  // Need at least 1 human + bots (or MIN_PLAYERS humans)
  const humanCount = game.players.size;
  const total = humanCount + BOT_COUNT;
  if (total < MIN_PLAYERS_TO_START) {
    // reset to lobby
    startLobby();
    return;
  }

  addBots();
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
  // First call after a short delay to let clients render
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

  // Check each player's cards for a line
  const winner = findWinner();
  if (winner) return finishRound(winner);

  sendState();
}

function findWinner() {
  for (const [cardNo, owner] of game.cards) {
    const card = cardFor(cardNo);
    if (hasLine(card, game.drawnSet)) {
      let names;
      let tgId = null;
      if (typeof owner === "string" && owner.startsWith("bot:")) {
        const bot = game.bots.find((b) => `bot:${b.id}` === owner);
        names = bot ? bot.names : ["Bot"];
      } else {
        const p = game.players.get(owner);
        names = p ? p.names : ["Player"];
        tgId = owner;
      }
      return { names, card: cardNo, tgId };
    }
  }
  return null;
}

async function finishRound(winner) {
  clearInterval(game.callTimer);
  game.callTimer = null;
  game.phase = "over";

  const prize = drawnPrize();

  if (winner) {
    game.winner = {
      names: winner.names,
      card: winner.card,
      prize,
      tgId: winner.tgId
    };

    // Pay human winners
    if (winner.tgId) {
      try {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2`,
            [prize, winner.tgId]
          );
          await client.query(
            `INSERT INTO transactions (telegram_id, type, amount, status) VALUES ($1,'win',$2,'completed')`,
            [winner.tgId, prize]
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
        // Push balance update to that client
        for (const ws of wss.clients) {
          if (ws.tgId === winner.tgId) {
            try { ws.send(JSON.stringify({ type: "balance", balance: await getBalance(winner.tgId) })); } catch {}
          }
        }
      } catch (err) {
        console.error("payout:", err);
      }
    }
  } else {
    game.winner = null;
  }

  try {
    await pool.query(
      `UPDATE rounds SET phase='over', drawn=$1, winner_names=$2, winner_card=$3, prize=$4, ended_at=NOW()
       WHERE id = (SELECT id FROM rounds ORDER BY id DESC LIMIT 1)`,
      [game.drawn, winner ? winner.names : null, winner ? winner.card : null, prize]
    );
  } catch (err) {
    console.error("round update:", err);
  }

  sendState();

  game.endTimer = setTimeout(() => {
    startLobby();
  }, WINNER_POPUP_SECONDS * 1000);
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

// Auto-start first lobby
startLobby();

// ============================================================
// WEBSOCKET
// ============================================================

wss.on("connection", (ws) => {
  ws.tgId = null;
  ws.isAlive = true;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "auth") {
      const tg = validateInitData(msg.initData);
      if (!tg) {
        try { ws.send(JSON.stringify({ type: "error", msg: "Invalid Telegram authentication" })); } catch {}
        return;
      }
      ws.tgId = tg.id;

      // register in players map
      const names = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || `Player ${String(tg.id).slice(-4)}`;
      if (!game.players.has(tg.id)) {
        game.players.set(tg.id, { names: [names], isBot: false, tg });
      }

      try { ws.send(JSON.stringify({ type: "balance", balance: await getBalance(tg.id) })); } catch {}
      try { ws.send(JSON.stringify(publicState(tg.id))); } catch {}

      // Start countdown if enough players and still lobby
      const total = game.players.size + BOT_COUNT;
      if (game.phase === "lobby" && !game.lobbyTimer && total >= MIN_PLAYERS_TO_START) {
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

      // Enforce rules
      const owned = [...game.cards.entries()].filter(([, o]) => o === ws.tgId).map(([n]) => n);
      const room = MAX_CARDS_PER_PLAYER - owned.length;

      const valid = [];
      for (const n of requested) {
        if (!Number.isInteger(n) || n < 1 || n > TOTAL_CARDS) continue;
        if (game.cards.has(n)) continue;              // already taken
        if (owned.includes(n)) continue;              // already owned by you
        if (valid.includes(n)) continue;              // dupe in this request
        valid.push(n);
      }
      const take = valid.slice(0, room);
      const cost = take.length * CARD_PRICE;

      if (!take.length) {
        try { ws.send(JSON.stringify({ type: "error", msg: "No valid cards to buy" })); } catch {}
        return;
      }

      // Charge
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const u = await client.query(
          `SELECT balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
          [ws.tgId]
        );
        const bal = Number(u.rows[0]?.balance || 0);
        if (bal < cost) {
          await client.query("ROLLBACK");
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
        try { ws.send(JSON.stringify({ type: "error", msg: "Could not buy cards" })); } catch {}
        return;
      } finally {
        client.release();
      }

      for (const n of take) game.cards.set(n, ws.tgId);

      try { ws.send(JSON.stringify({ type: "balance", balance: await getBalance(ws.tgId) })); } catch {}
      sendState();

      // If the lobby is full/ready, start the countdown
      if (!game.lobbyTimer && game.phase === "lobby") {
        const total = game.players.size + BOT_COUNT;
        if (total >= MIN_PLAYERS_TO_START && game.cards.size > 0) {
          startCountdown();
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    // Note: we do NOT remove the player from game.players on disconnect.
    // Their balance is safe, their cards remain owned for the current round.
    // This is simpler and avoids accidental card loss on network blips.
  });

  ws.on("error", () => {});
});

// ============================================================
// REST: /api/me, /api/deposit, /api/withdraw
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
      tb: { number: TB_NUMBER, name: TB_NAME }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load user" });
  }
});

app.post("/api/deposit", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);
  const txId = String(req.body?.txId || "").trim().toUpperCase();

  if (!Number.isFinite(amount) || amount < 10) {
    return res.status(400).json({ error: "Minimum deposit is 10 birr" });
  }
  if (!txId || txId.length > 12) {
    return res.status(400).json({ error: "Invalid transaction ID" });
  }

  try {
    // Prevent duplicate txId claims
    const dupe = await pool.query(`SELECT id FROM transactions WHERE tx_id = $1 LIMIT 1`, [txId]);
    if (dupe.rows.length) {
      return res.status(400).json({ error: "This transaction ID was already used" });
    }

    await pool.query(
      `INSERT INTO transactions (telegram_id, type, amount, status, tx_id)
       VALUES ($1, 'deposit', $2, 'pending', $3)`,
      [req.tgUser.id, amount, txId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

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
// HEALTH + FALLBACK
// ============================================================

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected", botToken: !!BOT_TOKEN, game: game.phase });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SPA fallback — every non-API path serves index.html
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
// BOOT
// ============================================================

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🎱 Zoma Bingo on :${PORT}`);
  console.log(`🤖 ENABLE_BOT not used — WS auth only`);
  console.log(`💵 CARD_PRICE=${CARD_PRICE}  🏆 HOUSE_CUT=${HOUSE_CUT}`);
  console.log(`👥 MIN_PLAYERS=${MIN_PLAYERS_TO_START}  🤖 BOT_COUNT=${BOT_COUNT}`);

  try {
    await initDatabase();
    console.log("✅ Database ready");
  } catch (err) {
    console.error("❌ DB init failed:", err);
  }
});

// ============================================================
// SHUTDOWN
// ============================================================

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
