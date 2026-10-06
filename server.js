// ============================================================
// BINGO TELEGRAM MINI APP SERVER
// Updated: 2026-10-06
// ES MODULE VERSION
// ============================================================

console.log("🔥 BINGO SERVER NEW VERSION 2026-10-06");

import express from "express";
import http from "http";
import crypto from "crypto";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import { Bot } from "grammy";

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 8080);

const ENABLE_BOT =
  String(process.env.ENABLE_BOT || "false").toLowerCase() === "true";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

const CARD_PRICE = Number(process.env.CARD_PRICE || 10);
const HOUSE_CUT = Number(process.env.HOUSE_CUT || 0);

const ROUND_COUNTDOWN = Number(process.env.ROUND_COUNTDOWN || 30);
const WINNER_POPUP_SECONDS =
  Number(process.env.WINNER_POPUP_SECONDS || 3);

const MAX_CARDS_PER_ROUND =
  Number(process.env.MAX_CARDS_PER_ROUND || 500);

const MAX_CARDS_PER_USER =
  Number(process.env.MAX_CARDS_PER_USER || 500);

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(app);

// ============================================================
// POSTGRESQL
// ============================================================

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing");
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,

  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err);
});

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);

  console.log(`🔌 WebSocket connected. Clients: ${clients.size}`);

  ws.on("close", () => {
    clients.delete(ws);

    console.log(
      `🔌 WebSocket disconnected. Clients: ${clients.size}`
    );
  });

  ws.on("error", () => {
    clients.delete(ws);
  });

  ws.send(
    JSON.stringify({
      type: "gameState",
      state: publicGameState()
    })
  );
});

function broadcast(message) {
  const data = JSON.stringify(message);

  for (const ws of clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  }
}

function broadcastGameState() {
  broadcast({
    type: "gameState",
    state: publicGameState()
  });
}

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }

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
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_claims (
      id SERIAL PRIMARY KEY,
      promo_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      telegram_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(promo_id, telegram_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_rounds (
      id SERIAL PRIMARY KEY,
      round_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      called_numbers INTEGER[] NOT NULL DEFAULT '{}',
      winner_telegram_id BIGINT,
      winner_card_id INTEGER,
      prize NUMERIC(18,2) NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
  `);

  console.log("✅ PostgreSQL database initialized");
}

// ============================================================
// TELEGRAM MINI APP AUTH
// ============================================================

function validateTelegramWebAppData(initData) {
  if (!initData || !BOT_TOKEN) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);

    const hash = params.get("hash");

    if (!hash) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return null;
    }

    const userRaw = params.get("user");

    if (!userRaw) {
      return null;
    }

    return JSON.parse(userRaw);
  } catch (err) {
    console.error("Telegram auth error:", err);
    return null;
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function authMiddleware(req, res, next) {
  try {
    const initData =
      req.headers["x-telegram-init-data"] ||
      req.body?.initData ||
      req.query?.initData;

    const telegramUser = validateTelegramWebAppData(initData);

    if (!telegramUser) {
      return res.status(401).json({
        ok: false,
        error: "Invalid Telegram Mini App authentication"
      });
    }

    req.telegramUser = telegramUser;

    await pool.query(
      `
      INSERT INTO users
        (telegram_id, username, first_name, last_name)
      VALUES
        ($1, $2, $3, $4)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        updated_at = NOW()
      `,
      [
        telegramUser.id,
        telegramUser.username || null,
        telegramUser.first_name || null,
        telegramUser.last_name || null
      ]
    );

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);

    res.status(500).json({
      ok: false,
      error: "Authentication error"
    });
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Bingo Server</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #111;
          color: white;
          text-align: center;
          padding: 40px;
        }
        .ok {
          color: #00ff88;
        }
      </style>
    </head>
    <body>
      <h1>🎱 Bingo Server</h1>
      <p class="ok">Server is running</p>
      <p>Telegram Bot: ${ENABLE_BOT ? "Enabled" : "Disabled"}</p>
    </body>
    </html>
  `);
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      server: "running",
      database: "connected",
      botPolling: ENABLE_BOT,
      port: PORT,
      time: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      server: "running",
      database: "error",
      error: err.message
    });
  }
});

// ============================================================
// USER API
// ============================================================

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        telegram_id,
        username,
        first_name,
        last_name,
        balance
      FROM users
      WHERE telegram_id = $1
      `,
      [req.telegramUser.id]
    );

    res.json({
      ok: true,
      user: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      error: "Unable to load user"
    });
  }
});

app.get("/api/balance", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT balance
      FROM users
      WHERE telegram_id = $1
      `,
      [req.telegramUser.id]
    );

    res.json({
      ok: true,
      balance: Number(result.rows[0]?.balance || 0)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Unable to load balance"
    });
  }
});

// ============================================================
// DEPOSIT
// ============================================================

app.post("/api/deposit", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Invalid amount"
    });
  }

  try {
    /*
      IMPORTANT:
      This endpoint is currently a simple internal/demo deposit.

      For real money, DO NOT allow the client to directly credit
      its own balance. Replace this with verified payment-provider
      confirmation/admin approval.
    */

    await pool.query(
      `
      UPDATE users
      SET balance = balance + $1,
          updated_at = NOW()
      WHERE telegram_id = $2
      `,
      [amount, req.telegramUser.id]
    );

    await pool.query(
      `
      INSERT INTO transactions
        (telegram_id, type, amount, status, reference)
      VALUES
        ($1, 'deposit', $2, 'completed', $3)
      `,
      [
        req.telegramUser.id,
        amount,
        `deposit_${Date.now()}`
      ]
    );

    res.json({
      ok: true,
      amount,
      message: "Deposit credited"
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      error: "Deposit failed"
    });
  }
});

// ============================================================
// WITHDRAW
// ============================================================

app.post("/api/withdraw", authMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Invalid amount"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT balance
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [req.telegramUser.id]
    );

    const balance = Number(
      userResult.rows[0]?.balance || 0
    );

    if (balance < amount) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Insufficient balance"
      });
    }

    await client.query(
      `
      UPDATE users
      SET balance = balance - $1,
          updated_at = NOW()
      WHERE telegram_id = $2
      `,
      [amount, req.telegramUser.id]
    );

    const reference = `withdraw_${Date.now()}`;

    await client.query(
      `
      INSERT INTO transactions
        (telegram_id, type, amount, status, reference)
      VALUES
        ($1, 'withdraw', $2, 'pending', $3)
      `,
      [
        req.telegramUser.id,
        amount,
        reference
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      amount,
      status: "pending",
      reference
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(500).json({
      ok: false,
      error: "Withdrawal failed"
    });
  } finally {
    client.release();
  }
});

// ============================================================
// PROMO CODE
// ============================================================

app.post("/api/promo", authMiddleware, async (req, res) => {
  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!code) {
    return res.status(400).json({
      ok: false,
      error: "Promo code required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const promoResult = await client.query(
      `
      SELECT *
      FROM promo_codes
      WHERE code = $1
        AND active = TRUE
      FOR UPDATE
      `,
      [code]
    );

    if (!promoResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Invalid promo code"
      });
    }

    const promo = promoResult.rows[0];

    if (promo.used_count >= promo.max_uses) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Promo code already used"
      });
    }

    const claimCheck = await client.query(
      `
      SELECT id
      FROM promo_claims
      WHERE promo_id = $1
        AND telegram_id = $2
      `,
      [
        promo.id,
        req.telegramUser.id
      ]
    );

    if (claimCheck.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Promo already claimed"
      });
    }

    await client.query(
      `
      INSERT INTO promo_claims
        (promo_id, telegram_id)
      VALUES
        ($1, $2)
      `,
      [
        promo.id,
        req.telegramUser.id
      ]
    );

    await client.query(
      `
      UPDATE promo_codes
      SET used_count = used_count + 1
      WHERE id = $1
      `,
      [promo.id]
    );

    await client.query(
      `
      UPDATE users
      SET balance = balance + $1,
          updated_at = NOW()
      WHERE telegram_id = $2
      `,
      [
        promo.amount,
        req.telegramUser.id
      ]
    );

    await client.query(
      `
      INSERT INTO transactions
        (telegram_id, type, amount, status, reference)
      VALUES
        ($1, 'promo', $2, 'completed', $3)
      `,
      [
        req.telegramUser.id,
        promo.amount,
        `promo_${code}`
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      amount: Number(promo.amount),
      message: "Promo claimed successfully"
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(500).json({
      ok: false,
      error: "Promo failed"
    });
  } finally {
    client.release();
  }
});

// ============================================================
// BINGO GAME STATE
// ============================================================

const game = {
  roundId: null,
  roundNumber: 0,

  status: "countdown",

  countdown: ROUND_COUNTDOWN,

  calledNumbers: [],

  currentNumber: null,

  cards: new Map(),

  nextCardId: 1,

  winner: null,

  prize: 0,

  countdownTimer: null,

  callingTimer: null,

  popupTimer: null
};

// ============================================================
// CARD GENERATION
// ============================================================

function shuffle(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function generateColumnNumbers(min, max, count) {
  const numbers = [];

  for (let n = min; n <= max; n++) {
    numbers.push(n);
  }

  return shuffle(numbers).slice(0, count);
}

function generateCard() {
  const B = generateColumnNumbers(1, 15, 5);
  const I = generateColumnNumbers(16, 30, 5);
  const N = generateColumnNumbers(31, 45, 5);
  const G = generateColumnNumbers(46, 60, 5);
  const O = generateColumnNumbers(61, 75, 5);

  const card = [
    [B[0], I[0], N[0], G[0], O[0]],
    [B[1], I[1], N[1], G[1], O[1]],
    [B[2], I[2], 0, G[2], O[2]],
    [B[3], I[3], N[3], G[3], O[3]],
    [B[4], I[4], N[4], G[4], O[4]]
  ];

  return card;
}

function cardHasWin(card) {
  const marked = card.map((row) =>
    row.map((number) => {
      if (number === 0) return true;

      return game.calledNumbers.includes(number);
    })
  );

  // Rows
  for (let r = 0; r < 5; r++) {
    if (marked[r].every(Boolean)) {
      return true;
    }
  }

  // Columns
  for (let c = 0; c < 5; c++) {
    let win = true;

    for (let r = 0; r < 5; r++) {
      if (!marked[r][c]) {
        win = false;
        break;
      }
    }

    if (win) return true;
  }

  // Main diagonal
  if (
    marked[0][0] &&
    marked[1][1] &&
    marked[2][2] &&
    marked[3][3] &&
    marked[4][4]
  ) {
    return true;
  }

  // Other diagonal
  if (
    marked[0][4] &&
    marked[1][3] &&
    marked[2][2] &&
    marked[3][1] &&
    marked[4][0]
  ) {
    return true;
  }

  return false;
}

// ============================================================
// CARD COUNT
// ============================================================

function cardCount() {
  return game.cards.size;
}

function calculatePrize() {
  const gross = cardCount() * CARD_PRICE;

  const prize = gross * (1 - HOUSE_CUT);

  return Math.max(0, Math.floor(prize));
}

// ============================================================
// PUBLIC GAME STATE
// ============================================================

function publicGameState() {
  const cards = [];

  for (const [id, card] of game.cards.entries()) {
    cards.push({
      id,
      telegramId: card.telegramId,
      card: card.card,
      purchasedAt: card.purchasedAt
    });
  }

  return {
    roundId: game.roundId,
    roundNumber: game.roundNumber,

    status: game.status,

    countdown: game.countdown,

    calledNumbers: game.calledNumbers,

    currentNumber: game.currentNumber,

    cards,

    cardCount: cardCount(),

    maxCards: MAX_CARDS_PER_ROUND,

    cardPrice: CARD_PRICE,

    prize: game.prize,

    winner: game.winner
      ? {
          telegramId: game.winner.telegramId,
          cardId: game.winner.cardId,
          card: game.winner.card
        }
      : null
  };
}

// ============================================================
// SAVE ROUND
// ============================================================

async function saveRoundStart() {
  const result = await pool.query(
    `
    INSERT INTO bingo_rounds
      (
        round_number,
        status,
        called_numbers,
        prize
      )
    VALUES
      ($1, $2, $3, $4)
    RETURNING id
    `,
    [
      game.roundNumber,
      game.status,
      game.calledNumbers,
      game.prize
    ]
  );

  game.roundId = result.rows[0].id;
}

async function saveRoundEnd() {
  if (!game.roundId) return;

  await pool.query(
    `
    UPDATE bingo_rounds
    SET
      status = $1,
      called_numbers = $2,
      winner_telegram_id = $3,
      winner_card_id = $4,
      prize = $5,
      ended_at = NOW()
    WHERE id = $6
    `,
    [
      "finished",
      game.calledNumbers,
      game.winner?.telegramId || null,
      game.winner?.cardId || null,
      game.prize,
      game.roundId
    ]
  );
}

// ============================================================
// START ROUND
// ============================================================

async function startRound() {
  clearTimers();

  game.roundNumber += 1;

  game.roundId = null;

  game.status = "countdown";

  game.countdown = ROUND_COUNTDOWN;

  game.calledNumbers = [];

  game.currentNumber = null;

  game.cards.clear();

  game.nextCardId = 1;

  game.winner = null;

  game.prize = 0;

  try {
    await saveRoundStart();
  } catch (err) {
    console.error("❌ Could not save round:", err);
  }

  broadcastGameState();

  startCountdown();
}

// ============================================================
// COUNTDOWN
// ============================================================

function startCountdown() {
  clearInterval(game.countdownTimer);

  game.status = "countdown";

  game.countdown = ROUND_COUNTDOWN;

  broadcastGameState();

  game.countdownTimer = setInterval(() => {
    game.countdown -= 1;

    if (game.countdown <= 0) {
      clearInterval(game.countdownTimer);

      game.countdownTimer = null;

      startCalling();

      return;
    }

    broadcastGameState();
  }, 1000);
}

// ============================================================
// START CALLING
// ============================================================

function startCalling() {
  clearInterval(game.callingTimer);

  game.status = "playing";

  game.countdown = 0;

  broadcastGameState();

  game.callingTimer = setInterval(() => {
    callNextNumber();
  }, 3000);

  // Call first number immediately
  callNextNumber();
}

// ============================================================
// CALL NUMBER
// ============================================================

function callNextNumber() {
  if (game.status !== "playing") {
    return;
  }

  if (game.calledNumbers.length >= 75) {
    endRound(null);
    return;
  }

  const remaining = [];

  for (let n = 1; n <= 75; n++) {
    if (!game.calledNumbers.includes(n)) {
      remaining.push(n);
    }
  }

  if (!remaining.length) {
    endRound(null);
    return;
  }

  const number =
    remaining[Math.floor(Math.random() * remaining.length)];

  game.calledNumbers.push(number);

  game.currentNumber = number;

  game.prize = calculatePrize();

  const winner = findWinner();

  if (winner) {
    endRound(winner);
    return;
  }

  broadcastGameState();
}

// ============================================================
// FIND WINNER
// ============================================================

function findWinner() {
  for (const [cardId, entry] of game.cards.entries()) {
    if (cardHasWin(entry.card)) {
      return {
        telegramId: entry.telegramId,
        cardId,
        card: entry.card
      };
    }
  }

  return null;
}

// ============================================================
// END ROUND
// ============================================================

async function endRound(winner) {
  if (
    game.status === "finished" ||
    game.status === "winner_popup" ||
    game.status === "releasing"
  ) {
    return;
  }

  clearInterval(game.callingTimer);

  game.callingTimer = null;

  game.prize = calculatePrize();

  game.winner = winner;

  game.status = "winner_popup";

  broadcast({
    type: "roundEnded",
    state: publicGameState()
  });

  broadcastGameState();

  try {
    await saveRoundEnd();
  } catch (err) {
    console.error("❌ Could not save finished round:", err);
  }

  // Winner popup for 3 seconds
  game.popupTimer = setTimeout(() => {
    releaseCards();
  }, WINNER_POPUP_SECONDS * 1000);
}

// ============================================================
// RELEASE CARDS
// ============================================================

function releaseCards() {
  game.status = "releasing";

  broadcastGameState();

  setTimeout(() => {
    startNextRoundCountdown();
  }, 500);
}

// ============================================================
// NEXT ROUND COUNTDOWN
// ============================================================

function startNextRoundCountdown() {
  game.status = "countdown";

  game.countdown = ROUND_COUNTDOWN;

  game.calledNumbers = [];

  game.currentNumber = null;

  game.cards.clear();

  game.nextCardId = 1;

  game.winner = null;

  game.prize = 0;

  game.roundId = null;

  broadcast({
    type: "cardsReleased",
    state: publicGameState()
  });

  startCountdownForExistingRound();
}

function startCountdownForExistingRound() {
  clearInterval(game.countdownTimer);

  game.status = "countdown";

  game.countdown = ROUND_COUNTDOWN;

  broadcastGameState();

  game.countdownTimer = setInterval(async () => {
    game.countdown -= 1;

    if (game.countdown <= 0) {
      clearInterval(game.countdownTimer);

      game.countdownTimer = null;

      game.roundNumber += 1;

      try {
        await saveRoundStart();
      } catch (err) {
        console.error("❌ Could not create new round:", err);
      }

      startCalling();

      return;
    }

    broadcastGameState();
  }, 1000);
}

// ============================================================
// CLEAR TIMERS
// ============================================================

function clearTimers() {
  if (game.countdownTimer) {
    clearInterval(game.countdownTimer);
    game.countdownTimer = null;
  }

  if (game.callingTimer) {
    clearInterval(game.callingTimer);
    game.callingTimer = null;
  }

  if (game.popupTimer) {
    clearTimeout(game.popupTimer);
    game.popupTimer = null;
  }
}

// ============================================================
// BUY BINGO CARD
// ============================================================

app.post("/api/bingo/buy", authMiddleware, async (req, res) => {
  const telegramId = Number(req.telegramUser.id);

  if (game.status !== "countdown" && game.status !== "playing") {
    return res.status(400).json({
      ok: false,
      error: "Cards are not available right now"
    });
  }

  // Maximum 500 cards total in the 20 × 25 card grid
  if (game.cards.size >= MAX_CARDS_PER_ROUND) {
    return res.status(400).json({
      ok: false,
      error: "All 500 cards have been sold"
    });
  }

  // Maximum cards per user
  let userCardCount = 0;

  for (const entry of game.cards.values()) {
    if (Number(entry.telegramId) === telegramId) {
      userCardCount++;
    }
  }

  if (userCardCount >= MAX_CARDS_PER_USER) {
    return res.status(400).json({
      ok: false,
      error: `Maximum ${MAX_CARDS_PER_USER} cards allowed`
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT balance
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [telegramId]
    );

    const balance = Number(
      userResult.rows[0]?.balance || 0
    );

    if (balance < CARD_PRICE) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Insufficient balance",
        balance
      });
    }

    await client.query(
      `
      UPDATE users
      SET
        balance = balance - $1,
        updated_at = NOW()
      WHERE telegram_id = $2
      `,
      [
        CARD_PRICE,
        telegramId
      ]
    );

    const cardId = game.nextCardId++;

    const card = generateCard();

    game.cards.set(cardId, {
      telegramId,

      card,

      purchasedAt: new Date().toISOString()
    });

    game.prize = calculatePrize();

    await client.query(
      `
      INSERT INTO transactions
        (
          telegram_id,
          type,
          amount,
          status,
          reference
        )
      VALUES
        (
          $1,
          'bingo_card',
          $2,
          'completed',
          $3
        )
      `,
      [
        telegramId,
        CARD_PRICE,
        `bingo_${game.roundNumber}_${cardId}`
      ]
    );

    await client.query("COMMIT");

    broadcast({
      type: "cardPurchased",
      state: publicGameState()
    });

    res.json({
      ok: true,

      cardId,

      card,

      price: CARD_PRICE,

      prize: game.prize,

      cardCount: cardCount()
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("❌ Card purchase error:", err);

    res.status(500).json({
      ok: false,
      error: "Unable to purchase card"
    });
  } finally {
    client.release();
  }
});

// ============================================================
// BINGO STATE
// ============================================================

app.get("/api/bingo/state", (req, res) => {
  res.json({
    ok: true,
    state: publicGameState()
  });
});

// ============================================================
// MANUAL ADMIN/DEBUG GAME STATE
// ============================================================

app.get("/api/bingo/round", (req, res) => {
  res.json({
    ok: true,
    round: publicGameState()
  });
});

// ============================================================
// TELEGRAM BOT
// ============================================================

let bot = null;

if (ENABLE_BOT) {
  if (!BOT_TOKEN) {
    console.error(
      "❌ ENABLE_BOT=true but BOT_TOKEN is missing"
    );
  } else {
    bot = new Bot(BOT_TOKEN);

    bot.command("start", async (ctx) => {
      await ctx.reply(
        "🎱 Welcome to Bingo!\n\nOpen the Bingo Mini App to play."
      );
    });

    bot.command("balance", async (ctx) => {
      try {
        const telegramId = ctx.from.id;

        const result = await pool.query(
          `
          SELECT balance
          FROM users
          WHERE telegram_id = $1
          `,
          [telegramId]
        );

        const balance = Number(
          result.rows[0]?.balance || 0
        );

        await ctx.reply(
          `💰 Your balance: ${balance.toFixed(2)} Birr`
        );
      } catch {
        await ctx.reply(
          "Unable to load your balance."
        );
      }
    });

    bot.catch((err) => {
      console.error(
        "❌ Telegram bot error:",
        err.error
      );
    });

    async function startTelegramBot() {
      try {
        // Make sure webhook is not active
        await bot.api.deleteWebhook({
          drop_pending_updates: false
        });

        console.log("🤖 Telegram bot polling started");

        await bot.start({
          onStart: (info) => {
            console.log(
              `🤖 Bot @${info.username} is running`
            );
          }
        });
      } catch (err) {
        console.error(
          "❌ Telegram bot failed:",
          err
        );
      }
    }

    // Start polling only when explicitly enabled
    startTelegramBot();
  }
} else {
  console.log(
    "🤖 Telegram bot polling DISABLED (ENABLE_BOT=false)"
  );
}

// ============================================================
// START SERVER FIRST
// ============================================================

server.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `🎱 Bingo running on port ${PORT}`
  );

  console.log(
    `🌐 Host: 0.0.0.0`
  );

  console.log(
    `🤖 ENABLE_BOT=${ENABLE_BOT}`
  );

  console.log(
    `💵 CARD_PRICE=${CARD_PRICE}`
  );

  console.log(
    `🏆 HOUSE_CUT=${HOUSE_CUT}`
  );

  console.log(
    `🎫 MAX_CARDS_PER_ROUND=${MAX_CARDS_PER_ROUND}`
  );

  console.log(
    `⏱️ ROUND_COUNTDOWN=${ROUND_COUNTDOWN}s`
  );

  try {
    await initDatabase();

    console.log("✅ Database ready");

    await startRound();
  } catch (err) {
    console.error(
      "❌ Startup database/game error:",
      err
    );
  }
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal) {
  console.log(
    `🛑 Received ${signal}. Shutting down...`
  );

  clearTimers();

  if (bot) {
    try {
      await bot.stop();
    } catch {}
  }

  for (const ws of clients) {
    try {
      ws.close();
    } catch {}
  }

  try {
    await pool.end();
  } catch {}

  server.close(() => {
    console.log("✅ Server closed");

    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 5000);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
