import express from "express";
import http from "http";
import crypto from "crypto";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import { Bot } from "grammy";

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 8080);

const ENABLE_BOT =
  String(process.env.ENABLE_BOT || "false").toLowerCase() === "true";

const BOT_TOKEN = process.env.BOT_TOKEN || "";

const DATABASE_URL = process.env.DATABASE_URL || "";

const CARD_PRICE = Number(process.env.CARD_PRICE || 10);

// Keep 0 if your prize must be:
// purchased cards × 10 birr
const HOUSE_CUT = Number(process.env.HOUSE_CUT || 0);

const ROUND_COUNTDOWN = 30;
const WINNER_POPUP_SECONDS = 3;

const MAX_CARDS_PER_USER = 500;

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Bingo Mini App",
    botEnabled: ENABLE_BOT,
    time: new Date().toISOString()
  });
});

app.get("/health", async (req, res) => {
  let database = "unknown";

  if (pool) {
    try {
      await pool.query("SELECT 1");
      database = "connected";
    } catch {
      database = "error";
    }
  } else {
    database = "disabled";
  }

  res.json({
    ok: true,
    server: "running",
    database,
    telegram: ENABLE_BOT ? "enabled" : "disabled",
    round: game.phase,
    uptime: process.uptime()
  });
});

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(app);

/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {
  if (!pool) {
    console.log("⚠️ DATABASE_URL not configured");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      balance NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT DEFAULT 'completed',
      reference TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      max_uses INTEGER DEFAULT 1,
      uses INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_claims (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      telegram_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(code, telegram_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_rounds (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      called_numbers JSONB DEFAULT '[]'::jsonb,
      winner_telegram_id BIGINT,
      winner_card_id TEXT,
      prize NUMERIC(12,2) DEFAULT 0,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    )
  `);

  console.log("✅ PostgreSQL connected");
}

/* =========================================================
   TELEGRAM MINI APP AUTH
========================================================= */

function validateTelegramWebAppData(initData) {
  if (!BOT_TOKEN || !initData) {
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

    const valid = crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "hex"),
      Buffer.from(hash, "hex")
    );

    if (!valid) {
      return null;
    }

    const userString = params.get("user");

    if (!userString) {
      return null;
    }

    return JSON.parse(userString);
  } catch (error) {
    console.error("Telegram auth error:", error.message);
    return null;
  }
}

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function telegramAuth(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      error: "Database is not configured"
    });
  }

  const initData =
    req.headers["x-telegram-init-data"] ||
    req.body?.initData ||
    req.query?.initData;

  const user = validateTelegramWebAppData(initData);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: "Invalid Telegram authentication"
    });
  }

  req.telegramUser = user;

  try {
    await pool.query(
      `
      INSERT INTO users
        (telegram_id, username, first_name)
      VALUES
        ($1, $2, $3)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name
      `,
      [
        user.id,
        user.username || null,
        user.first_name || null
      ]
    );

    next();
  } catch (error) {
    console.error("Auth DB error:", error);

    res.status(500).json({
      ok: false,
      error: "Database error"
    });
  }
}

/* =========================================================
   USER API
========================================================= */

app.get("/api/me", telegramAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        telegram_id,
        username,
        first_name,
        balance
      FROM users
      WHERE telegram_id = $1
      `,
      [req.telegramUser.id]
    );

    res.json({
      ok: true,
      user: result.rows[0] || null
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Database error"
    });
  }
});

/* =========================================================
   BALANCE
========================================================= */

app.get("/api/balance", telegramAuth, async (req, res) => {
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
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Database error"
    });
  }
});

/* =========================================================
   DEPOSIT
========================================================= */

app.post("/api/deposit", telegramAuth, async (req, res) => {
  const amount = Number(req.body?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Invalid amount"
    });
  }

  try {
    await pool.query(
      `
      UPDATE users
      SET balance = balance + $1
      WHERE telegram_id = $2
      `,
      [amount, req.telegramUser.id]
    );

    await pool.query(
      `
      INSERT INTO transactions
        (telegram_id, type, amount, status)
      VALUES
        ($1, 'deposit', $2, 'completed')
      `,
      [req.telegramUser.id, amount]
    );

    res.json({
      ok: true,
      amount
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Deposit failed"
    });
  }
});

/* =========================================================
   WITHDRAW
========================================================= */

app.post("/api/withdraw", telegramAuth, async (req, res) => {
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

    const result = await client.query(
      `
      SELECT balance
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [req.telegramUser.id]
    );

    const balance = Number(result.rows[0]?.balance || 0);

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
      SET balance = balance - $1
      WHERE telegram_id = $2
      `,
      [amount, req.telegramUser.id]
    );

    await client.query(
      `
      INSERT INTO transactions
        (telegram_id, type, amount, status)
      VALUES
        ($1, 'withdraw', $2, 'pending')
      `,
      [req.telegramUser.id, amount]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      amount,
      status: "pending"
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Withdrawal failed"
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   PROMO CODE
========================================================= */

app.post("/api/promo", telegramAuth, async (req, res) => {
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
        AND uses < max_uses
      FOR UPDATE
      `,
      [code]
    );

    if (!promoResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Invalid or expired promo code"
      });
    }

    const promo = promoResult.rows[0];

    const claimResult = await client.query(
      `
      SELECT id
      FROM promo_claims
      WHERE code = $1
        AND telegram_id = $2
      `,
      [code, req.telegramUser.id]
    );

    if (claimResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Promo already used"
      });
    }

    await client.query(
      `
      INSERT INTO promo_claims
        (code, telegram_id)
      VALUES
        ($1, $2)
      `,
      [code, req.telegramUser.id]
    );

    await client.query(
      `
      UPDATE promo_codes
      SET uses = uses + 1
      WHERE code = $1
      `,
      [code]
    );

    await client.query(
      `
      UPDATE users
      SET balance = balance + $1
      WHERE telegram_id = $2
      `,
      [promo.amount, req.telegramUser.id]
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
        code
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      amount: Number(promo.amount)
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Promo failed"
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   BINGO GAME STATE
========================================================= */

const game = {
  roundId: null,

  phase: "waiting",

  countdown: 0,

  calledNumbers: [],

  availableNumbers: [],

  cards: new Map(),

  winner: null,

  prize: 0,

  timer: null,

  winnerTimer: null
};

/* =========================================================
   BINGO NUMBERS
========================================================= */

function resetNumbers() {
  game.availableNumbers = [];

  for (let i = 1; i <= 75; i++) {
    game.availableNumbers.push(i);
  }
}

function randomNumber() {
  if (!game.availableNumbers.length) {
    return null;
  }

  const index = Math.floor(
    Math.random() * game.availableNumbers.length
  );

  return game.availableNumbers.splice(index, 1)[0];
}

/* =========================================================
   CARD GENERATOR
========================================================= */

function generateCard() {
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];

  const columns = [];

  for (const [min, max] of ranges) {
    const nums = [];

    for (let n = min; n <= max; n++) {
      nums.push(n);
    }

    nums.sort(() => Math.random() - 0.5);

    columns.push(nums.slice(0, 5));
  }

  const grid = Array.from({ length: 5 }, () =>
    Array(5).fill(0)
  );

  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 5; row++) {
      grid[row][col] = columns[col][row];
    }
  }

  grid[2][2] = 0;

  return grid;
}

/* =========================================================
   CARD WIN CHECK
========================================================= */

function isWinningCard(card) {
  const called = new Set(game.calledNumbers);

  // Free center
  const marked = (value, row, col) =>
    value === 0 ||
    called.has(value);

  // Rows
  for (let row = 0; row < 5; row++) {
    let win = true;

    for (let col = 0; col < 5; col++) {
      if (!marked(card[row][col], row, col)) {
        win = false;
        break;
      }
    }

    if (win) return true;
  }

  // Columns
  for (let col = 0; col < 5; col++) {
    let win = true;

    for (let row = 0; row < 5; row++) {
      if (!marked(card[row][col], row, col)) {
        win = false;
        break;
      }
    }

    if (win) return true;
  }

  // Diagonal
  let diagonal1 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked(card[i][i], i, i)) {
      diagonal1 = false;
      break;
    }
  }

  if (diagonal1) return true;

  // Other diagonal
  let diagonal2 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked(card[i][4 - i], i, 4 - i)) {
      diagonal2 = false;
      break;
    }
  }

  return diagonal2;
}

/* =========================================================
   WEBSOCKET
========================================================= */

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

function gameState() {
  return {
    type: "game_state",

    roundId: game.roundId,

    phase: game.phase,

    countdown: game.countdown,

    calledNumbers: game.calledNumbers,

    lastNumber:
      game.calledNumbers.length
        ? game.calledNumbers[game.calledNumbers.length - 1]
        : null,

    prize: game.prize,

    winner: game.winner
  };
}

wss.on("connection", ws => {
  ws.send(JSON.stringify(gameState()));

  ws.on("error", error => {
    console.error("WebSocket error:", error.message);
  });
});

/* =========================================================
   ROUND PRIZE
========================================================= */

function cardCount() {
  return game.cards.size;
}

function calculatePrize() {
  return Math.floor(
    cardCount() *
      CARD_PRICE *
      (1 - HOUSE_CUT)
  );
}

/* =========================================================
   START ROUND
========================================================= */

async function startRound() {
  if (game.timer) {
    clearInterval(game.timer);
  }

  if (game.winnerTimer) {
    clearTimeout(game.winnerTimer);
  }

  game.roundId = crypto.randomUUID();

  game.phase = "playing";

  game.countdown = 0;

  game.calledNumbers = [];

  game.winner = null;

  game.prize = calculatePrize();

  resetNumbers();

  game.cards.clear();

  if (pool) {
    try {
      await pool.query(
        `
        INSERT INTO bingo_rounds
          (status, called_numbers, prize)
        VALUES
          ('playing', '[]'::jsonb, $1)
        `,
        [game.prize]
      );
    } catch (error) {
      console.error(
        "Round DB insert error:",
        error.message
      );
    }
  }

  broadcast(gameState());

  console.log(
    `🎱 Round started: ${game.roundId}`
  );

  startCalling();
}

/* =========================================================
   CALL NUMBERS
========================================================= */

function startCalling() {
  game.timer = setInterval(async () => {
    if (game.phase !== "playing") {
      return;
    }

    const number = randomNumber();

    if (number === null) {
      await endRound(null);
      return;
    }

    game.calledNumbers.push(number);

    game.prize = calculatePrize();

    broadcast({
      type: "number_called",
      number,
      calledNumbers: game.calledNumbers,
      prize: game.prize
    });

    broadcast(gameState());

    const winner = findWinner();

    if (winner) {
      await endRound(winner);
    }
  }, 3000);
}

/* =========================================================
   FIND WINNER
========================================================= */

function findWinner() {
  for (const [cardId, data] of game.cards.entries()) {
    if (isWinningCard(data.card)) {
      return {
        cardId,
        telegramId: data.telegramId,
        card: data.card
      };
    }
  }

  return null;
}

/* =========================================================
   END ROUND
========================================================= */

async function endRound(winner) {
  if (game.phase !== "playing") {
    return;
  }

  if (game.timer) {
    clearInterval(game.timer);
    game.timer = null;
  }

  game.phase = "winner";

  game.winner = winner;

  game.prize = calculatePrize();

  if (pool) {
    try {
      await pool.query(
        `
        UPDATE bingo_rounds
        SET
          status = 'finished',
          called_numbers = $1::jsonb,
          winner_telegram_id = $2,
          winner_card_id = $3,
          prize = $4,
          ended_at = NOW()
        WHERE status = 'playing'
        `,
        [
          JSON.stringify(game.calledNumbers),
          winner?.telegramId || null,
          winner?.cardId || null,
          game.prize
        ]
      );
    } catch (error) {
      console.error(
        "Round DB update error:",
        error.message
      );
    }
  }

  broadcast({
    type: "round_finished",
    winner,
    prize: game.prize,
    popupSeconds: WINNER_POPUP_SECONDS
  });

  broadcast(gameState());

  console.log(
    `🏆 Round ended. Winner: ${
      winner?.telegramId || "none"
    }`
  );

  /*
    Winner popup stays for 3 seconds.
    Then cards are released and 30-second
    countdown starts automatically.
  */

  game.winnerTimer = setTimeout(() => {
    releaseCards();
    startNextRoundCountdown();
  }, WINNER_POPUP_SECONDS * 1000);
}

/* =========================================================
   RELEASE CARDS
========================================================= */

function releaseCards() {
  game.cards.clear();

  broadcast({
    type: "cards_released"
  });

  broadcast(gameState());

  console.log("🃏 Cards released");
}

/* =========================================================
   NEXT ROUND COUNTDOWN
========================================================= */

function startNextRoundCountdown() {
  game.phase = "countdown";

  game.countdown = ROUND_COUNTDOWN;

  broadcast({
    type: "countdown",
    seconds: game.countdown
  });

  if (game.timer) {
    clearInterval(game.timer);
  }

  game.timer = setInterval(async () => {
    game.countdown--;

    broadcast({
      type: "countdown",
      seconds: game.countdown
    });

    if (game.countdown <= 0) {
      clearInterval(game.timer);
      game.timer = null;

      await startRound();
    }
  }, 1000);
}

/* =========================================================
   PURCHASE CARD
========================================================= */

app.post("/api/bingo/buy", telegramAuth, async (req, res) => {
  const cardId = String(
    req.body?.cardId || crypto.randomUUID()
  );

  if (game.phase !== "playing") {
    return res.status(400).json({
      ok: false,
      error: "Round is not accepting cards"
    });
  }

  if (game.cards.size >= MAX_CARDS_PER_USER) {
    return res.status(400).json({
      ok: false,
      error: "Maximum cards reached"
    });
  }

  const existing = [...game.cards.values()].filter(
    item =>
      String(item.telegramId) ===
      String(req.telegramUser.id)
  );

  if (existing.length >= MAX_CARDS_PER_USER) {
    return res.status(400).json({
      ok: false,
      error: "Maximum cards reached"
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

    if (balance < CARD_PRICE) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Insufficient balance",
        required: CARD_PRICE,
        balance
      });
    }

    await client.query(
      `
      UPDATE users
      SET balance = balance - $1
      WHERE telegram_id = $2
      `,
      [
        CARD_PRICE,
        req.telegramUser.id
      ]
    );

    await client.query(
      `
      INSERT INTO transactions
        (telegram_id, type, amount, status, reference)
      VALUES
        ($1, 'bingo_card', $2, 'completed', $3)
      `,
      [
        req.telegramUser.id,
        CARD_PRICE,
        game.roundId
      ]
    );

    await client.query("COMMIT");

    const card = generateCard();

    game.cards.set(cardId, {
      telegramId: req.telegramUser.id,
      card
    });

    game.prize = calculatePrize();

    broadcast({
      type: "card_purchased",
      cardId,
      cardCount: game.cards.size,
      prize: game.prize
    });

    res.json({
      ok: true,
      cardId,
      card,
      price: CARD_PRICE,
      prize: game.prize
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Buy card error:", error);

    res.status(500).json({
      ok: false,
      error: "Could not purchase card"
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   CURRENT GAME API
========================================================= */

app.get("/api/bingo/state", (req, res) => {
  res.json({
    ok: true,
    ...gameState(),
    cardPrice: CARD_PRICE
  });
});

/* =========================================================
   TELEGRAM BOT
========================================================= */

/*
 IMPORTANT:

 ENABLE_BOT=false
 =================

 The Bot object may exist, but bot.start()
 MUST NOT be called.

 This completely prevents getUpdates and therefore
 prevents Telegram 409 polling conflicts.
*/

let bot = null;
let botRunning = false;

if (ENABLE_BOT) {
  if (!BOT_TOKEN) {
    console.error(
      "❌ ENABLE_BOT=true but BOT_TOKEN is missing"
    );
  } else {
    bot = new Bot(BOT_TOKEN);

    bot.command("start", async ctx => {
      await ctx.reply(
        "🎱 Welcome to Bingo!\n\nOpen the Bingo Mini App to play."
      );
    });

    bot.command("balance", async ctx => {
      if (!pool) {
        await ctx.reply("Database unavailable.");
        return;
      }

      try {
        const result = await pool.query(
          `
          SELECT balance
          FROM users
          WHERE telegram_id = $1
          `,
          [ctx.from.id]
        );

        const balance = Number(
          result.rows[0]?.balance || 0
        );

        await ctx.reply(
          `💰 Balance: ${balance.toFixed(2)} birr`
        );
      } catch {
        await ctx.reply("Unable to read balance.");
      }
    });

    /*
      Promo creation for administrators can be added
      here when you provide the admin Telegram ID.
    */

    bot.catch(error => {
      console.error(
        "Telegram bot middleware error:",
        error.error
      );
    });
  }
}

/* =========================================================
   START TELEGRAM BOT SAFELY
========================================================= */

async function startTelegramBot() {
  if (!ENABLE_BOT) {
    console.log(
      "🤖 Telegram polling DISABLED (ENABLE_BOT=false)"
    );

    return;
  }

  if (!bot) {
    console.log(
      "🤖 Telegram bot not started"
    );

    return;
  }

  try {
    /*
      Long polling cannot coexist with a webhook.
      Only do this when polling is explicitly enabled.
    */

    await bot.api.deleteWebhook({
      drop_pending_updates: false
    });

    botRunning = true;

    console.log("🤖 Starting Telegram polling...");

    /*
      IMPORTANT:
      Attach the rejection handler immediately.
      A 409 must NOT bring down the Bingo HTTP server.
    */

    const pollingPromise = bot.start({
      onStart: info => {
        console.log(
          `🤖 Telegram bot started: @${info.username}`
        );
      }
    });

    pollingPromise.catch(error => {
      botRunning = false;

      if (error?.error_code === 409) {
        console.error(
          "⚠️ Telegram 409: another bot instance is already polling."
        );

        console.error(
          "⚠️ Bingo server will remain online."
        );

        return;
      }

      console.error(
        "❌ Telegram polling stopped:",
        error
      );
    });
  } catch (error) {
    botRunning = false;

    console.error(
      "❌ Telegram startup error:",
      error
    );
  }
}

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `\n🛑 ${signal} received. Shutting down...`
  );

  try {
    if (game.timer) {
      clearInterval(game.timer);
    }

    if (game.winnerTimer) {
      clearTimeout(game.winnerTimer);
    }

    if (bot && botRunning) {
      try {
        await bot.stop();
      } catch (error) {
        console.error(
          "Bot stop error:",
          error.message
        );
      }
    }

    for (const client of wss.clients) {
      try {
        client.close();
      } catch {}
    }

    await new Promise(resolve => {
      server.close(resolve);
    });

    if (pool) {
      await pool.end();
    }

    console.log("✅ Shutdown complete");

    process.exit(0);
  } catch (error) {
    console.error(
      "Shutdown error:",
      error
    );

    process.exit(1);
  }
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  /*
    Start HTTP FIRST.
    Railway can immediately see the service port.
  */

  server.listen(
    PORT,
    "0.0.0.0",
    async () => {
      console.log(
        `🎱 Bingo running on ${PORT}`
      );

      console.log(
        `🤖 ENABLE_BOT=${ENABLE_BOT}`
      );

      /*
        Database initialization
      */

      try {
        await initDatabase();
      } catch (error) {
        console.error(
          "❌ Database initialization failed:",
          error.message
        );
      }

      /*
        Start the first Bingo round.

        This does NOT depend on Telegram polling.
      */

      try {
        await startRound();
      } catch (error) {
        console.error(
          "❌ Failed to start Bingo round:",
          error
        );
      }

      /*
        Telegram starts ONLY when ENABLE_BOT=true.
      */

      if (ENABLE_BOT) {
        await startTelegramBot();
      } else {
        console.log(
          "✅ Bingo service running without Telegram polling"
        );
      }
    }
  );
}

startServer().catch(error => {
  console.error(
    "❌ Fatal startup error:",
    error
  );
});
