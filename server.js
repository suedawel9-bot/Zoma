"use strict";

/*
  BINGO TELEGRAM MINI APP SERVER
  --------------------------------
  Railway + PostgreSQL + Express + WebSocket + Grammy

  Important:
  - Railway PORT is used automatically.
  - Server binds to 0.0.0.0.
  - PostgreSQL uses DATABASE_URL.
  - Telegram 409 polling conflicts DO NOT crash Node.
  - WebSocket remains available.
  - Bingo game continues running.
*/

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");
const { Bot } = require("grammy");


// ============================================================
// ENVIRONMENT
// ============================================================

const PORT = Number(process.env.PORT) || 8080;

const DATABASE_URL = process.env.DATABASE_URL;

const BOT_TOKEN = process.env.BOT_TOKEN;

const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

const TELEBIRR_NUMBER =
  process.env.TELEBIRR_NUMBER || "";

const TELEBIRR_NAME =
  process.env.TELEBIRR_NAME || "Telebirr";

const CARD_PRICE =
  Number(process.env.CARD_PRICE || 10);

const HOUSE_CUT =
  Number(process.env.HOUSE_CUT || 0.20);

const MIN_PLAYERS =
  Number(process.env.MIN_PLAYERS || 1);

const BOTS =
  Number(process.env.BOTS || 100);

const REQUIRE_DEPOSIT =
  String(process.env.REQUIRE_DEPOSIT || "false").toLowerCase() === "true";

const PROMO_REQUIRE_DEPOSIT =
  String(process.env.PROMO_REQUIRE_DEPOSIT || "false").toLowerCase() === "true";


// ============================================================
// VALIDATION
// ============================================================

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing");
  process.exit(1);
}

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}


// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));

app.use(express.urlencoded({
  extended: true,
  limit: "1mb"
}));


// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(app);


// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocketServer({
  server,
  path: "/ws"
});


// ============================================================
// POSTGRESQL
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl: DATABASE_URL.includes("railway.internal")
    ? false
    : {
        rejectUnauthorized: false
      },

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});

let dbReady = false;


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {

  console.log("📦 Initializing PostgreSQL...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_deposit NUMERIC(18,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      reference TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS promos (
      code TEXT PRIMARY KEY,
      amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      require_deposit BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_uses (
      code TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(code, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_deposits_status
      ON deposits(status);

    CREATE INDEX IF NOT EXISTS idx_withdrawals_status
      ON withdrawals(status);

    CREATE INDEX IF NOT EXISTS idx_promo_uses_user
      ON promo_uses(user_id);
  `);

  console.log("✅ PostgreSQL ready");

  dbReady = true;
}


// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new Bot(BOT_TOKEN);

let botRunning = false;
let botStarting = false;


// ============================================================
// SAFE TELEGRAM BOT START
// ============================================================

async function startTelegramBot() {

  if (botStarting || botRunning) {
    return;
  }

  botStarting = true;

  try {

    /*
      Drop any webhook before getUpdates polling.

      This is safe for this architecture because
      the bot uses long polling.
    */

    try {
      await bot.api.deleteWebhook({
        drop_pending_updates: false
      });

      console.log("✅ Telegram webhook cleared");
    } catch (err) {
      console.error(
        "⚠️ Could not clear Telegram webhook:",
        err.message
      );
    }


    console.log("🤖 Starting Telegram bot...");


    /*
      IMPORTANT:

      Do NOT await bot.start() forever.

      Also attach .catch() so Grammy 409 cannot
      become an unhandled rejection/process crash.
    */

    bot.start({
      onStart: (info) => {

        botRunning = true;

        console.log(
          `🤖 Telegram bot started: @${info.username}`
        );
      }
    })
    .then(() => {

      botRunning = false;

      console.log(
        "ℹ️ Telegram bot polling stopped."
      );

    })
    .catch((err) => {

      botRunning = false;

      const code =
        err?.error_code ||
        err?.errorCode;

      const description =
        err?.description ||
        err?.message ||
        "Unknown Telegram error";


      if (code === 409) {

        /*
          MOST IMPORTANT FIX:

          A second getUpdates consumer exists.

          DO NOT throw.
          DO NOT process.exit().
          DO NOT crash Node.

          Keep HTTP/WebSocket/PostgreSQL alive.
        */

        console.error("");
        console.error(
          "⚠️ TELEGRAM 409 CONFLICT"
        );
        console.error(
          "Another instance is currently using this BOT_TOKEN."
        );
        console.error(
          "Bingo HTTP/WebSocket/PostgreSQL will continue running."
        );
        console.error(
          "Stop the other bot instance, then restart this service."
        );
        console.error("");

        botStarting = false;

        return;
      }


      console.error(
        "❌ Telegram polling error:",
        description
      );

      /*
        Do not crash the application.

        Reset the flag so a retry can happen.
      */

      botStarting = false;

      setTimeout(() => {

        if (!shuttingDown && dbReady) {
          console.log(
            "🔄 Retrying Telegram bot..."
          );

          startTelegramBot();
        }

      }, 10000);
    });

  } catch (err) {

    console.error(
      "❌ Telegram startup error:",
      err.message
    );

  } finally {

    botStarting = false;
  }
}


// ============================================================
// TELEGRAM COMMANDS
// ============================================================

bot.command("start", async (ctx) => {

  try {

    const user = ctx.from;

    await ensureUser(user);

    await ctx.reply(
      "🎱 Welcome to Bingo!\n\n" +
      "Open the Bingo Mini App to play."
    );

  } catch (err) {

    console.error(
      "/start error:",
      err.message
    );

  }
});


bot.command("balance", async (ctx) => {

  try {

    if (!ctx.from) return;

    await ensureUser(ctx.from);

    const result = await pool.query(
      `SELECT balance
       FROM users
       WHERE id = $1`,
      [ctx.from.id]
    );

    const balance =
      Number(result.rows[0]?.balance || 0);

    await ctx.reply(
      `💰 Balance: ${balance.toFixed(2)} Birr`
    );

  } catch (err) {

    console.error(
      "/balance error:",
      err.message
    );

  }
});


// ============================================================
// ADMIN PROMO COMMAND
// ============================================================

bot.command("newpromo", async (ctx) => {

  try {

    if (!ADMIN_ID || ctx.from?.id !== ADMIN_ID) {
      return;
    }

    const parts =
      String(ctx.message?.text || "")
        .trim()
        .split(/\s+/);

    /*
      /newpromo CODE AMOUNT USES DAYS [deposit]

      Example:

      /newpromo BONUS100 100 50 30
    */

    if (parts.length < 5) {

      await ctx.reply(
        "Usage:\n" +
        "/newpromo CODE AMOUNT USES DAYS"
      );

      return;
    }

    const code =
      parts[1].toUpperCase();

    const amount =
      Number(parts[2]);

    const maxUses =
      Number(parts[3]);

    const days =
      Number(parts[4]);

    if (
      !code ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isInteger(maxUses) ||
      maxUses <= 0 ||
      !Number.isFinite(days) ||
      days <= 0
    ) {

      await ctx.reply(
        "❌ Invalid promo parameters."
      );

      return;
    }

    const expiresAt =
      new Date(
        Date.now() +
        days * 24 * 60 * 60 * 1000
      );

    await pool.query(
      `
      INSERT INTO promos
        (code, amount, max_uses, require_deposit, expires_at)
      VALUES
        ($1, $2, $3, $4, $5)
      ON CONFLICT (code)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        max_uses = EXCLUDED.max_uses,
        require_deposit = EXCLUDED.require_deposit,
        expires_at = EXCLUDED.expires_at
      `,
      [
        code,
        amount,
        maxUses,
        PROMO_REQUIRE_DEPOSIT,
        expiresAt
      ]
    );

    await ctx.reply(
      `✅ Promo created\n\n` +
      `Code: ${code}\n` +
      `Amount: ${amount} Birr\n` +
      `Uses: ${maxUses}\n` +
      `Expires: ${expiresAt.toISOString()}`
    );

  } catch (err) {

    console.error(
      "/newpromo error:",
      err.message
    );

  }
});


// ============================================================
// USER DATABASE
// ============================================================

async function ensureUser(user) {

  if (!user?.id) {
    throw new Error("Invalid Telegram user");
  }

  await pool.query(
    `
    INSERT INTO users
      (id, username, first_name)
    VALUES
      ($1, $2, $3)
    ON CONFLICT (id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      updated_at = NOW()
    `,
    [
      user.id,
      user.username || null,
      user.first_name || null
    ]
  );
}


// ============================================================
// TELEGRAM MINI APP AUTH
// ============================================================

function verifyTelegramInitData(initData) {

  if (!initData) {
    return null;
  }

  try {

    const params =
      new URLSearchParams(initData);

    const hash =
      params.get("hash");

    if (!hash) {
      return null;
    }

    params.delete("hash");

    const dataCheckString =
      [...params.entries()]
        .sort(([a], [b]) =>
          a.localeCompare(b)
        )
        .map(([key, value]) =>
          `${key}=${value}`
        )
        .join("\n");


    const secretKey =
      crypto
        .createHmac(
          "sha256",
          "WebAppData"
        )
        .update(BOT_TOKEN)
        .digest();


    const calculatedHash =
      crypto
        .createHmac(
          "sha256",
          secretKey
        )
        .update(dataCheckString)
        .digest("hex");


    if (
      calculatedHash.length !== hash.length ||
      !crypto.timingSafeEqual(
        Buffer.from(calculatedHash),
        Buffer.from(hash)
      )
    ) {
      return null;
    }


    const authDate =
      Number(params.get("auth_date") || 0);


    if (!authDate) {
      return null;
    }


    /*
      24-hour validation.
    */

    if (
      Math.floor(Date.now() / 1000) -
      authDate >
      86400
    ) {
      return null;
    }


    const userJson =
      params.get("user");

    if (!userJson) {
      return null;
    }


    return JSON.parse(userJson);

  } catch (err) {

    console.error(
      "Telegram auth error:",
      err.message
    );

    return null;
  }
}


// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function authMiddleware(req, res, next) {

  if (!dbReady) {

    return res.status(503).json({
      ok: false,
      error: "Server is starting"
    });
  }


  const initData =
    req.headers["x-telegram-init-data"] ||
    req.headers["x-init-data"] ||
    req.body?.initData;


  const user =
    verifyTelegramInitData(initData);


  if (!user) {

    return res.status(401).json({
      ok: false,
      error: "Invalid Telegram authentication"
    });
  }


  try {

    await ensureUser(user);

    req.telegramUser = user;

    next();

  } catch (err) {

    console.error(
      "Auth error:",
      err.message
    );

    res.status(500).json({
      ok: false,
      error: "Authentication failed"
    });
  }
}


// ============================================================
// BINGO GAME
// ============================================================

let game = null;


/*
  Generate a standard 5x5 Bingo card.

  Columns:
  B: 1-15
  I: 16-30
  N: 31-45
  G: 46-60
  O: 61-75
*/

function shuffle(array) {

  const a = [...array];

  for (
    let i = a.length - 1;
    i > 0;
    i--
  ) {

    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      a[i],
      a[j]
    ] = [
      a[j],
      a[i]
    ];
  }

  return a;
}


function createCard() {

  const columns = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];


  const card = [];


  for (let c = 0; c < 5; c++) {

    const [
      min,
      max
    ] = columns[c];

    const nums =
      shuffle(
        Array.from(
          {
            length:
              max - min + 1
          },
          (_, i) =>
            min + i
        )
      )
      .slice(0, 5);


    card.push(nums);
  }


  /*
    Convert columns → rows.
  */

  const rows =
    Array.from(
      { length: 5 },
      (_, r) =>
        Array.from(
          { length: 5 },
          (_, c) =>
            card[c][r]
        )
    );


  /*
    Free center.
  */

  rows[2][2] = 0;

  return rows;
}


function createGame() {

  return {

    roundId:
      crypto.randomUUID(),

    status: "lobby",

    cards: new Map(),

    taken: new Set(),

    called: [],

    calledSet: new Set(),

    winner: null,

    winners: [],

    prize: 0,

    createdAt: Date.now(),

    countdownEndsAt: null,

    nextCallAt: null,

    timers: {
      countdown: null,
      calling: null,
      finish: null
    }
  };
}


function resetGame() {

  if (game?.timers) {

    clearTimeout(
      game.timers.countdown
    );

    clearTimeout(
      game.timers.calling
    );

    clearTimeout(
      game.timers.finish
    );
  }


  game = createGame();

  broadcastGame();

  console.log(
    `🎱 New Bingo round: ${game.roundId}`
  );
}


resetGame();


// ============================================================
// CARD ID
// ============================================================

function randomCardId() {

  let id;

  do {

    id =
      Math.floor(
        Math.random() * 1000000
      )
      .toString()
      .padStart(6, "0");

  } while (
    game.taken.has(id)
  );


  return id;
}


// ============================================================
// PLAYER CARD COUNT
// ============================================================

function cardCount() {

  let count = 0;

  for (const card of game.cards.values()) {

    if (!card.bot) {
      count++;
    }
  }

  return count;
}


// ============================================================
// PRIZE
// ============================================================

function calculatePrize() {

  const total =
    cardCount() *
    CARD_PRICE;


  return Math.floor(
    total *
    (1 - HOUSE_CUT)
  );
}


// ============================================================
// BINGO CHECK
// ============================================================

function hasBingo(card) {

  const marked =
    card.marked;


  /*
    Rows
  */

  for (let r = 0; r < 5; r++) {

    let complete = true;

    for (let c = 0; c < 5; c++) {

      if (
        card.numbers[r][c] !== 0 &&
        !marked.has(
          card.numbers[r][c]
        )
      ) {

        complete = false;

        break;
      }
    }


    if (complete) {
      return true;
    }
  }


  /*
    Columns
  */

  for (let c = 0; c < 5; c++) {

    let complete = true;

    for (let r = 0; r < 5; r++) {

      if (
        card.numbers[r][c] !== 0 &&
        !marked.has(
          card.numbers[r][c]
        )
      ) {

        complete = false;

        break;
      }
    }


    if (complete) {
      return true;
    }
  }


  /*
    Diagonal 1
  */

  let complete = true;

  for (let i = 0; i < 5; i++) {

    if (
      card.numbers[i][i] !== 0 &&
      !marked.has(
        card.numbers[i][i]
      )
    ) {

      complete = false;

      break;
    }
  }


  if (complete) {
    return true;
  }


  /*
    Diagonal 2
  */

  complete = true;

  for (let i = 0; i < 5; i++) {

    if (
      card.numbers[i][4 - i] !== 0 &&
      !marked.has(
        card.numbers[i][4 - i]
      )
    ) {

      complete = false;

      break;
    }
  }


  return complete;
}


// ============================================================
// MARK CALLED NUMBER
// ============================================================

function markCard(card) {

  for (
    const number of game.called
  ) {

    if (number !== 0) {

      card.marked.add(number);
    }
  }
}


// ============================================================
// FIND WINNERS
// ============================================================

function findWinners() {

  const winners = [];


  for (
    const card of game.cards.values()
  ) {

    if (card.bot) {
      continue;
    }


    markCard(card);


    if (hasBingo(card)) {

      winners.push(card);
    }
  }


  return winners;
}


// ============================================================
// BROADCAST
// ============================================================

function publicGameState() {

  return {

    roundId:
      game.roundId,

    status:
      game.status,

    called:
      game.called,

    currentBall:
      game.called[
        game.called.length - 1
      ] || null,

    playerCount:
      cardCount(),

    prize:
      calculatePrize(),

    winner:
      game.winner
        ? {
            userId:
              game.winner.userId,

            cardId:
              game.winner.cardId
          }
        : null,

    winners:
      game.winners.map(w => ({
        userId:
          w.userId,

        cardId:
          w.cardId
      })),

    countdownEndsAt:
      game.countdownEndsAt,

    nextCallAt:
      game.nextCallAt
  };
}


function broadcastGame() {

  const data =
    JSON.stringify({
      type: "game",
      game: publicGameState()
    });


  for (
    const ws of wss.clients
  ) {

    if (
      ws.readyState === ws.OPEN
    ) {

      try {
        ws.send(data);
      } catch (err) {
        console.error(
          "WS send error:",
          err.message
        );
      }
    }
  }
}


// ============================================================
// START COUNTDOWN
// ============================================================

function startCountdown() {

  if (
    !game ||
    game.status !== "lobby"
  ) {
    return;
  }


  if (
    cardCount() < MIN_PLAYERS
  ) {

    console.log(
      `Waiting for players: ${cardCount()}/${MIN_PLAYERS}`
    );

    return;
  }


  const seconds = 30;

  game.countdownEndsAt =
    Date.now() +
    seconds * 1000;


  broadcastGame();


  clearTimeout(
    game.timers.countdown
  );


  game.timers.countdown =
    setTimeout(
      () => {

        if (
          game.status !== "lobby"
        ) {
          return;
        }


        game.status = "calling";

        game.countdownEndsAt = null;

        game.called = [];

        game.calledSet.clear();

        game.winner = null;

        game.winners = [];

        game.prize =
          calculatePrize();


        broadcastGame();

        callNextNumber();

      },
      seconds * 1000
    );
}


// ============================================================
// CALL NEXT NUMBER
// ============================================================

function callNextNumber() {

  if (
    game.status !== "calling"
  ) {
    return;
  }


  if (
    game.called.length >= 75
  ) {

    finishRound();

    return;
  }


  let number;

  do {

    number =
      Math.floor(
        Math.random() * 75
      ) + 1;

  } while (
    game.calledSet.has(number)
  );


  game.called.push(number);

  game.calledSet.add(number);

  game.nextCallAt =
    Date.now() + 3000;


  broadcastGame();


  const winners =
    findWinners();


  if (winners.length > 0) {

    finishRound(winners);

    return;
  }


  clearTimeout(
    game.timers.calling
  );


  game.timers.calling =
    setTimeout(
      callNextNumber,
      3000
    );
}


// ============================================================
// FINISH ROUND
// ============================================================

async function finishRound(
  winners = []
) {

  if (
    game.status === "finished"
  ) {
    return;
  }


  game.status = "finished";

  game.nextCallAt = null;

  game.winners = winners;

  game.winner =
    winners[0] || null;

  game.prize =
    calculatePrize();


  broadcastGame();


  console.log(
    `🏆 Round finished. Winners: ${winners.length}`
  );


  /*
    Pay winners.

    Prize is divided equally.
  */

  if (
    winners.length > 0 &&
    game.prize > 0
  ) {

    const each =
      Math.floor(
        game.prize /
        winners.length
      );


    if (each > 0) {

      for (
        const winner of winners
      ) {

        try {

          await pool.query(
            `
            UPDATE users
            SET
              balance = balance + $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [
              each,
              winner.userId
            ]
          );

        } catch (err) {

          console.error(
            "Winner payment error:",
            err.message
          );
        }
      }
    }
  }


  /*
    Winner popup remains visible
    for approximately 3 seconds.
  */

  clearTimeout(
    game.timers.finish
  );


  game.timers.finish =
    setTimeout(
      () => {

        resetGame();

      },
      3000
    );
}


// ============================================================
// JOIN GAME
// ============================================================

async function joinGame(
  userId,
  requestedCards
) {

  if (
    game.status !== "lobby"
  ) {

    throw new Error(
      "Round is not accepting cards"
    );
  }


  const cardsToBuy =
    Math.max(
      1,
      Math.min(
        Number(requestedCards) || 1,
        20
      )
    );


  const cost =
    cardsToBuy *
    CARD_PRICE;


  /*
    Reserve cards before DB await.
  */

  const cards = [];


  for (
    let i = 0;
    i < cardsToBuy;
    i++
  ) {

    const cardId =
      randomCardId();


    game.taken.add(cardId);


    cards.push({
      cardId,
      numbers:
        createCard(),
      marked:
        new Set()
    });
  }


  try {

    const result =
      await pool.query(
        `
        UPDATE users
        SET
          balance = balance - $1,
          updated_at = NOW()
        WHERE
          id = $2
          AND balance >= $1
        RETURNING balance
        `,
        [
          cost,
          userId
        ]
      );


    if (
      result.rowCount !== 1
    ) {

      for (
        const card of cards
      ) {

        game.taken.delete(
          card.cardId
        );
      }


      throw new Error(
        "Insufficient balance"
      );
    }


    for (
      const card of cards
    ) {

      game.cards.set(
        `${userId}:${card.cardId}`,
        {
          userId,
          cardId:
            card.cardId,
          numbers:
            card.numbers,
          marked:
            card.marked,
          bot: false
        }
      );
    }


    startCountdown();

    broadcastGame();


    return {
      cards,
      cost,
      balance:
        Number(
          result.rows[0].balance
        )
    };

  } catch (err) {

    for (
      const card of cards
    ) {

      game.taken.delete(
        card.cardId
      );
    }

    throw err;
  }
}


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    /*
      Always return HTTP 200.

      Railway can therefore see that the
      HTTP server is alive even when Telegram
      polling has a 409 conflict.
    */

    res.status(200).json({

      ok: true,

      service: "bingo",

      port: PORT,

      database:
        dbReady
          ? "ready"
          : "starting",

      telegram:
        botRunning
          ? "running"
          : "not-running",

      game:
        game
          ? game.status
          : "starting",

      timestamp:
        new Date().toISOString()
    });
  }
);


app.get(
  "/api/health",
  (req, res) => {

    res.status(200).json({
      ok: true,
      database: dbReady,
      telegram: botRunning,
      game: game?.status || null
    });
  }
);


// ============================================================
// BASIC GAME API
// ============================================================

app.get(
  "/api/game",
  (req, res) => {

    res.json({
      ok: true,
      game: publicGameState()
    });
  }
);


// ============================================================
// USER BALANCE
// ============================================================

app.get(
  "/api/me",
  authMiddleware,
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT
            id,
            username,
            first_name,
            balance,
            total_deposit
          FROM users
          WHERE id = $1
          `,
          [
            req.telegramUser.id
          ]
        );


      if (!result.rows.length) {

        return res.status(404).json({
          ok: false,
          error: "User not found"
        });
      }


      res.json({
        ok: true,
        user: result.rows[0]
      });

    } catch (err) {

      console.error(
        "/api/me error:",
        err.message
      );

      res.status(500).json({
        ok: false,
        error: "Database error"
      });
    }
  }
);


// ============================================================
// JOIN
// ============================================================

app.post(
  "/api/join",
  authMiddleware,
  async (req, res) => {

    try {

      const count =
        Number(
          req.body?.cards ||
          req.body?.cardCount ||
          1
        );


      const result =
        await joinGame(
          req.telegramUser.id,
          count
        );


      res.json({
        ok: true,
        ...result
      });

    } catch (err) {

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Could not join"
      });
    }
  }
);


// ============================================================
// MY CARDS
// ============================================================

app.get(
  "/api/cards",
  authMiddleware,
  (req, res) => {

    const cards = [];


    for (
      const card of game.cards.values()
    ) {

      if (
        card.userId ===
        req.telegramUser.id
      ) {

        cards.push({
          cardId:
            card.cardId,

          numbers:
            card.numbers,

          marked:
            [...card.marked]
        });
      }
    }


    res.json({
      ok: true,
      cards
    });
  }
);


// ============================================================
// DEPOSIT REQUEST
// ============================================================

app.post(
  "/api/deposit",
  authMiddleware,
  async (req, res) => {

    try {

      const amount =
        Number(
          req.body?.amount
        );

      const reference =
        String(
          req.body?.reference ||
          ""
        ).trim();


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({
          ok: false,
          error: "Invalid amount"
        });
      }


      const result =
        await pool.query(
          `
          INSERT INTO deposits
            (user_id, amount, reference)
          VALUES
            ($1, $2, $3)
          RETURNING id, amount, status
          `,
          [
            req.telegramUser.id,
            amount,
            reference || null
          ]
        );


      res.json({
        ok: true,
        deposit:
          result.rows[0],

        paymentNumber:
          TELEBIRR_NUMBER,

        paymentName:
          TELEBIRR_NAME
      });

    } catch (err) {

      console.error(
        "Deposit error:",
        err.message
      );

      res.status(500).json({
        ok: false,
        error: "Deposit request failed"
      });
    }
  }
);


// ============================================================
// WITHDRAW
// ============================================================

app.post(
  "/api/withdraw",
  authMiddleware,
  async (req, res) => {

    const client =
      await pool.connect();


    try {

      const amount =
        Number(
          req.body?.amount
        );

      const destination =
        String(
          req.body?.destination ||
          ""
        ).trim();


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({
          ok: false,
          error: "Invalid amount"
        });
      }


      if (!destination) {

        return res.status(400).json({
          ok: false,
          error: "Destination is required"
        });
      }


      /*
        Use a transaction so the balance
        cannot be deducted without creating
        the withdrawal.
      */

      await client.query("BEGIN");


      const balanceResult =
        await client.query(
          `
          UPDATE users
          SET
            balance = balance - $1,
            updated_at = NOW()
          WHERE
            id = $2
            AND balance >= $1
          RETURNING balance
          `,
          [
            amount,
            req.telegramUser.id
          ]
        );


      if (
        balanceResult.rowCount !== 1
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error: "Insufficient balance"
        });
      }


      const withdrawal =
        await client.query(
          `
          INSERT INTO withdrawals
            (user_id, amount, destination)
          VALUES
            ($1, $2, $3)
          RETURNING id, amount, destination, status
          `,
          [
            req.telegramUser.id,
            amount,
            destination
          ]
        );


      await client.query(
        "COMMIT"
      );


      res.json({
        ok: true,

        withdrawal:
          withdrawal.rows[0],

        balance:
          Number(
            balanceResult.rows[0].balance
          )
      });

    } catch (err) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}


      console.error(
        "Withdrawal error:",
        err.message
      );


      res.status(500).json({
        ok: false,
        error: "Withdrawal failed"
      });

    } finally {

      client.release();
    }
  }
);


// ============================================================
// PROMO
// ============================================================

app.post(
  "/api/promo",
  authMiddleware,
  async (req, res) => {

    const client =
      await pool.connect();


    try {

      const code =
        String(
          req.body?.code ||
          ""
        )
        .trim()
        .toUpperCase();


      if (!code) {

        return res.status(400).json({
          ok: false,
          error: "Promo code required"
        });
      }


      await client.query(
        "BEGIN"
      );


      const promoResult =
        await client.query(
          `
          SELECT *
          FROM promos
          WHERE code = $1
          FOR UPDATE
          `,
          [code]
        );


      if (
        promoResult.rowCount !== 1
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          ok: false,
          error: "Invalid promo code"
        });
      }


      const promo =
        promoResult.rows[0];


      if (
        promo.expires_at &&
        new Date(
          promo.expires_at
        ).getTime() <
        Date.now()
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error: "Promo expired"
        });
      }


      if (
        Number(promo.uses) >=
        Number(promo.max_uses)
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error: "Promo fully used"
        });
      }


      const already =
        await client.query(
          `
          SELECT 1
          FROM promo_uses
          WHERE
            code = $1
            AND user_id = $2
          `,
          [
            code,
            req.telegramUser.id
          ]
        );


      if (
        already.rowCount
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error: "Promo already used"
        });
      }


      if (
        promo.require_deposit
      ) {

        const deposit =
          await client.query(
            `
            SELECT 1
            FROM deposits
            WHERE
              user_id = $1
              AND status = 'approved'
            LIMIT 1
            `,
            [
              req.telegramUser.id
            ]
          );


        if (
          deposit.rowCount === 0
        ) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            ok: false,
            error:
              "Deposit required before using this promo"
          });
        }
      }


      await client.query(
        `
        UPDATE users
        SET
          balance = balance + $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          Number(promo.amount),
          req.telegramUser.id
        ]
      );


      await client.query(
        `
        INSERT INTO promo_uses
          (code, user_id)
        VALUES
          ($1, $2)
        `,
        [
          code,
          req.telegramUser.id
        ]
      );


      await client.query(
        `
        UPDATE promos
        SET
          uses = uses + 1
        WHERE code = $1
        `,
        [code]
      );


      await client.query(
        "COMMIT"
      );


      res.json({
        ok: true,
        amount:
          Number(promo.amount)
      });

    } catch (err) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}


      console.error(
        "Promo error:",
        err.message
      );


      res.status(500).json({
        ok: false,
        error: "Promo failed"
      });

    } finally {

      client.release();
    }
  }
);


// ============================================================
// ADMIN DEPOSIT APPROVAL
// ============================================================

app.post(
  "/api/admin/deposit/:id/approve",
  async (req, res) => {

    try {

      const admin =
        Number(
          req.headers["x-admin-id"] ||
          req.body?.adminId ||
          0
        );


      if (
        !ADMIN_ID ||
        admin !== ADMIN_ID
      ) {

        return res.status(403).json({
          ok: false,
          error: "Forbidden"
        });
      }


      const id =
        Number(req.params.id);


      const client =
        await pool.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const deposit =
          await client.query(
            `
            SELECT *
            FROM deposits
            WHERE id = $1
            FOR UPDATE
            `,
            [id]
          );


        if (
          deposit.rowCount !== 1
        ) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            ok: false,
            error: "Deposit not found"
          });
        }


        const d =
          deposit.rows[0];


        if (
          d.status !== "pending"
        ) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            ok: false,
            error: "Deposit already processed"
          });
        }


        await client.query(
          `
          UPDATE deposits
          SET
            status = 'approved',
            approved_at = NOW()
          WHERE id = $1
          `,
          [id]
        );


        await client.query(
          `
          UPDATE users
          SET
            balance = balance + $1,
            total_deposit =
              total_deposit + $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            d.amount,
            d.user_id
          ]
        );


        await client.query(
          "COMMIT"
        );


        res.json({
          ok: true
        });

      } catch (err) {

        try {
          await client.query(
            "ROLLBACK"
          );
        } catch (_) {}


        throw err;

      } finally {

        client.release();
      }

    } catch (err) {

      console.error(
        "Admin deposit approval error:",
        err.message
      );

      res.status(500).json({
        ok: false,
        error: "Approval failed"
      });
    }
  }
);


// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on(
  "connection",
  (ws) => {

    ws.isAlive = true;


    ws.on(
      "pong",
      () => {
        ws.isAlive = true;
      }
    );


    /*
      Immediately send current game.
    */

    try {

      ws.send(
        JSON.stringify({
          type: "game",
          game: publicGameState()
        })
      );

    } catch (err) {

      console.error(
        "Initial WS send error:",
        err.message
      );
    }


    ws.on(
      "message",
      async (raw) => {

        try {

          const message =
            JSON.parse(
              raw.toString()
            );


          if (
            message.type ===
            "ping"
          ) {

            ws.send(
              JSON.stringify({
                type: "pong"
              })
            );

            return;
          }


          /*
            The browser normally uses REST
            authentication for joining.

            Keep WS available for live game updates.
          */

        } catch (err) {

          try {

            ws.send(
              JSON.stringify({
                type: "error",
                error: "Invalid message"
              })
            );

          } catch (_) {}
        }
      }
    );


    ws.on(
      "close",
      () => {
        // Nothing required.
      }
    );


    ws.on(
      "error",
      (err) => {

        console.error(
          "WebSocket error:",
          err.message
        );
      }
    );
  }
);


// ============================================================
// WEBSOCKET HEARTBEAT
// ============================================================

const heartbeat =
  setInterval(
    () => {

      for (
        const ws of wss.clients
      ) {

        if (
          ws.isAlive === false
        ) {

          try {
            ws.terminate();
          } catch (_) {}

          continue;
        }


        ws.isAlive = false;


        try {
          ws.ping();
        } catch (_) {}
      }

    },
    30000
  );


// ============================================================
// STATIC MINI APP
// ============================================================

app.use(
  express.static("public")
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    if (
      req.path.startsWith("/api/")
    ) {

      return res.status(404).json({
        ok: false,
        error: "Not found"
      });
    }


    res.status(404).send(
      "Bingo Mini App server is running."
    );
  }
);


// ============================================================
// SERVER STARTUP
// ============================================================

let shuttingDown = false;


async function startServer() {

  /*
    IMPORTANT:

    Start HTTP server FIRST.

    This lets Railway see the application
    as alive immediately.
  */

  await new Promise(
    (resolve, reject) => {

      const onError = (err) => {

        server.off(
          "listening",
          onListening
        );

        reject(err);
      };


      const onListening = () => {

        server.off(
          "error",
          onError
        );

        resolve();
      };


      server.once(
        "error",
        onError
      );


      server.once(
        "listening",
        onListening
      );


      server.listen(
        PORT,
        "0.0.0.0"
      );
    }
  );


  console.log(
    `🎱 Bingo running on ${PORT}`
  );


  /*
    Database initialization happens after
    the HTTP server is listening.
  */

  try {

    await initDatabase();

    resetGame();

    /*
      Start Telegram only after DB is ready.
    */

    await startTelegramBot();

  } catch (err) {

    console.error(
      "❌ Startup initialization failed:",
      err
    );

    /*
      HTTP remains alive, but database-dependent
      features will report that the service is
      still starting.

      Do NOT blindly process.exit() here.
    */
  }
}


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {

  if (shuttingDown) {
    return;
  }

  shuttingDown = true;


  console.log(
    `🛑 Received ${signal}. Shutting down...`
  );


  clearInterval(
    heartbeat
  );


  if (game?.timers) {

    clearTimeout(
      game.timers.countdown
    );

    clearTimeout(
      game.timers.calling
    );

    clearTimeout(
      game.timers.finish
    );
  }


  /*
    Stop Telegram polling.
  */

  try {

    bot.stop();

    console.log(
      "🤖 Telegram bot stopped"
    );

  } catch (err) {

    console.error(
      "Telegram stop error:",
      err.message
    );
  }


  /*
    Close WebSocket clients.
  */

  for (
    const ws of wss.clients
  ) {

    try {
      ws.close();
    } catch (_) {}
  }


  try {

    await new Promise(
      (resolve) => {

        wss.close(
          () => resolve()
        );
      }
    );

  } catch (_) {}


  /*
    Close HTTP server.
  */

  try {

    await new Promise(
      (resolve) => {

        server.close(
          () => resolve()
        );
      }
    );

  } catch (_) {}


  /*
    Close PostgreSQL.
  */

  try {

    await pool.end();

    console.log(
      "📦 PostgreSQL pool closed"
    );

  } catch (err) {

    console.error(
      "PostgreSQL shutdown error:",
      err.message
    );
  }


  console.log(
    "✅ Shutdown complete"
  );
}


process.on(
  "SIGTERM",
  () => {
    shutdown("SIGTERM");
  }
);


process.on(
  "SIGINT",
  () => {
    shutdown("SIGINT");
  }
);


// ============================================================
// UNHANDLED ERRORS
// ============================================================

process.on(
  "unhandledRejection",
  (reason) => {

    console.error(
      "⚠️ Unhandled promise rejection:",
      reason
    );

    /*
      IMPORTANT:

      Do NOT process.exit() here.

      This prevents one asynchronous error
      from killing the Bingo server.
    */
  }
);


process.on(
  "uncaughtException",
  (err) => {

    console.error(
      "⚠️ Uncaught exception:",
      err
    );

    /*
      Keep process alive for recoverable
      application errors.
    */
  }
);


// ============================================================
// START
// ============================================================

startServer()
  .catch((err) => {

    console.error(
      "❌ Fatal HTTP startup error:",
      err
    );

    /*
      If the HTTP server itself cannot start,
      there is no point keeping the container.
    */

    process.exit(1);
  });
