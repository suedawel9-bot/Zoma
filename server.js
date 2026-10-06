import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { Bot, InlineKeyboard } from "grammy";
import pg from "pg";
import crypto from "crypto";
import { cardFor, TOTAL } from "./public/cards.js";

const {
  BOT_TOKEN,
  ADMIN_ID,
  DATABASE_URL,
  TELEBIRR_NUMBER,
  TELEBIRR_NAME
} = process.env;

// Railway assigns PORT automatically.
const PORT = Number(process.env.PORT) || 8080;

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------

const CARD_PRICE = 10;
const HOUSE_CUT = 0.20;

const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;

const REQUIRE_DEPOSIT =
  process.env.PROMO_REQUIRE_DEPOSIT !== "false";

const MIN_PLAYERS = 2;
const LOBBY_SECS = 30;
const DRAW_MS = 4000;

const MAX_CARDS = 4;
const BOTS = Math.max(
  0,
  Number(process.env.BOTS ?? 100)
);

const RECEIPT =
  "https://transactioninfo.ethiotelecom.et/receipt/";

// ---------------------------------------------------------
// ENVIRONMENT VALIDATION
// ---------------------------------------------------------

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}

if (!ADMIN_ID) {
  throw new Error("ADMIN_ID is not set");
}

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// ---------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------

const app = express();

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static("public")
);

// ---------------------------------------------------------
// APPLICATION STATE
// ---------------------------------------------------------

let databaseReady = false;
let applicationReady = false;

let game;
let timer = null;

// ---------------------------------------------------------
// POSTGRESQL
// ---------------------------------------------------------

const db = new pg.Pool({
  connectionString: DATABASE_URL,

  // Railway private PostgreSQL hostname:
  // no SSL required.
  //
  // Public PostgreSQL connection:
  // SSL enabled.
  ssl: DATABASE_URL.includes("railway.internal")
    ? false
    : { rejectUnauthorized: false },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

db.on("error", (err) => {
  console.error(
    "Unexpected PostgreSQL pool error:",
    err
  );
});

// ---------------------------------------------------------
// DATABASE INITIALIZATION
// ---------------------------------------------------------

async function initDatabase() {
  console.log("Connecting to PostgreSQL...");

  await db.query("SELECT 1");

  console.log("PostgreSQL connection OK");

  await db.query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGINT PRIMARY KEY,
      name TEXT,
      balance INT NOT NULL DEFAULT 0
        CHECK(balance >= 0)
    );

    CREATE TABLE IF NOT EXISTS deposits(
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      amount INT,
      tx_id TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS withdrawals(
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      amount INT,
      phone TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promos(
      code TEXT PRIMARY KEY,
      amount INT NOT NULL,
      max_uses INT NOT NULL,
      used INT NOT NULL DEFAULT 0,
      active BOOL NOT NULL DEFAULT true,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_uses(
      code TEXT,
      user_id BIGINT,
      used_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(code, user_id)
    );
  `);

  databaseReady = true;

  console.log("Database tables ready");
}

// ---------------------------------------------------------
// TELEGRAM MINI APP AUTHENTICATION
// ---------------------------------------------------------

function verify(initData) {
  try {
    if (!initData || !BOT_TOKEN) {
      return null;
    }

    const p = new URLSearchParams(initData);

    const hash = p.get("hash");

    if (!hash) {
      return null;
    }

    p.delete("hash");

    const dataCheckString = [...p.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("\n");

    const secretKey = crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return null;
    }

    const authDate =
      Number(p.get("auth_date"));

    if (!authDate) {
      return null;
    }

    // Telegram Mini App authentication valid for 24 hours.
    if (
      Date.now() / 1000 -
        authDate >
      86400
    ) {
      return null;
    }

    const userData = p.get("user");

    if (!userData) {
      return null;
    }

    return JSON.parse(userData);

  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// USER DATABASE HELPER
// ---------------------------------------------------------

async function upsert(u) {
  const r = await db.query(
    `
      INSERT INTO users(
        id,
        name
      )

      VALUES(
        $1,
        $2
      )

      ON CONFLICT(id)
      DO UPDATE SET
        name = EXCLUDED.name

      RETURNING balance
    `,
    [
      u.id,
      u.first_name || "Player"
    ]
  );

  return r.rows[0].balance;
}

// ---------------------------------------------------------
// TELEGRAM BOT
// ---------------------------------------------------------

const bot = new Bot(BOT_TOKEN);

const isAdmin = (ctx) =>
  String(ctx.from?.id) ===
  String(ADMIN_ID);

const tell = (id, text) =>
  bot.api
    .sendMessage(id, text)
    .catch(() => {});

// ---------------------------------------------------------
// /START
// ---------------------------------------------------------

bot.command(
  "start",
  async (ctx) => {
    await ctx.reply(
      "Welcome to Bingo! Tap the Play button to start."
    );
  }
);

// ---------------------------------------------------------
// ADMIN: NEW PROMO
// ---------------------------------------------------------

bot.command(
  "newpromo",
  async (ctx) => {
    if (!isAdmin(ctx)) {
      return;
    }

    const [
      code,
      amount,
      max,
      days
    ] =
      ctx.match
        .trim()
        .split(/\s+/);

    const a =
      parseInt(amount);

    const m =
      parseInt(max);

    const d =
      parseInt(days);

    if (
      !/^[A-Za-z0-9]{3,20}$/.test(
        code || ""
      ) ||
      !(a > 0) ||
      !(m > 0)
    ) {
      return ctx.reply(
        "Usage: /newpromo CODE BIRR MAX_USES [DAYS]\n" +
        "Example: /newpromo WELCOME20 20 100 7"
      );
    }

    try {
      await db.query(
        `
          INSERT INTO promos(
            code,
            amount,
            max_uses,
            expires_at
          )

          VALUES(
            $1,
            $2,
            $3,
            ${
              d > 0
                ? "now() + make_interval(days => $4)"
                : "NULL"
            }
          )
        `,
        d > 0
          ? [
              code.toUpperCase(),
              a,
              m,
              d
            ]
          : [
              code.toUpperCase(),
              a,
              m
            ]
      );

      await ctx.reply(
        `✅ Promo ${code.toUpperCase()}: ${a} birr, ${m} uses` +
        `${
          d > 0
            ? `, expires in ${d} days`
            : ""
        }`
      );

    } catch (e) {
      await ctx.reply(
        e.code === "23505"
          ? "That code already exists."
          : "Error creating code."
      );
    }
  }
);

// ---------------------------------------------------------
// ADMIN: PROMOS
// ---------------------------------------------------------

bot.command(
  "promos",
  async (ctx) => {
    if (!isAdmin(ctx)) {
      return;
    }

    try {
      const r =
        await db.query(`
          SELECT *
          FROM promos
          ORDER BY created_at DESC
          LIMIT 20
        `);

      if (!r.rows.length) {
        return ctx.reply(
          "No promo codes yet."
        );
      }

      const text =
        r.rows
          .map(
            (p) =>
              `${p.code}: ${p.amount} birr, ` +
              `${p.used}/${p.max_uses} used` +
              `${
                p.active
                  ? ""
                  : " (stopped)"
              }` +
              `${
                p.expires_at
                  ? `, expires ${p.expires_at
                      .toISOString()
                      .slice(0, 10)}`
                  : ""
              }`
          )
          .join("\n");

      await ctx.reply(text);

    } catch (e) {
      console.error(
        "Promos command:",
        e
      );

      await ctx.reply(
        "Error loading promos."
      );
    }
  }
);

// ---------------------------------------------------------
// ADMIN: STOP PROMO
// ---------------------------------------------------------

bot.command(
  "stoppromo",
  async (ctx) => {
    if (!isAdmin(ctx)) {
      return;
    }

    const code =
      ctx.match
        .trim()
        .toUpperCase();

    const r =
      await db.query(
        `
          UPDATE promos
          SET active = false
          WHERE code = $1
        `,
        [code]
      );

    await ctx.reply(
      r.rowCount
        ? "Promo stopped."
        : "Code not found."
    );
  }
);

// ---------------------------------------------------------
// WEBSOCKET CLIENTS
// ---------------------------------------------------------

const clients =
  new Set();

const send = (
  ws,
  object
) => {
  if (
    ws.readyState === 1
  ) {
    try {
      ws.send(
        JSON.stringify(object)
      );
    } catch {}
  }
};

function pushBalance(
  uid,
  balance
) {
  clients.forEach(
    (ws) => {
      if (
        ws.uid == uid
      ) {
        send(
          ws,
          {
            type:
              "balance",
            balance
          }
        );
      }
    }
  );
}

// ---------------------------------------------------------
// ADMIN CALLBACKS
// ---------------------------------------------------------

bot.on(
  "callback_query:data",
  async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.answerCallbackQuery(
        "Not allowed"
      );
    }

    const [
      kind,
      action,
      id
    ] =
      ctx.callbackQuery.data
        .split(":");

    let message =
      "Already handled";

    // -------------------------------
    // DEPOSIT APPROVE
    // -------------------------------

    if (
      kind === "dep" &&
      action === "ok"
    ) {
      const r =
        (
          await db.query(
            `
              WITH d AS (
                UPDATE deposits

                SET status =
                  'approved'

                WHERE id = $1
                  AND status =
                    'pending'

                RETURNING
                  user_id,
                  amount
              )

              UPDATE users u

              SET balance =
                u.balance + d.amount

              FROM d

              WHERE u.id =
                d.user_id

              RETURNING
                u.id,
                d.amount,
                u.balance
            `,
            [id]
          )
        ).rows[0];

      if (r) {
        message =
          `✅ Approved ${r.amount} birr`;

        tell(
          r.id,
          `✅ Deposit of ${r.amount} birr approved.\n` +
          `Balance: ${r.balance} birr.`
        );

        pushBalance(
          r.id,
          r.balance
        );
      }
    }

    // -------------------------------
    // DEPOSIT REJECT
    // -------------------------------

    else if (
      kind === "dep"
    ) {
      const r =
        (
          await db.query(
            `
              UPDATE deposits

              SET status =
                'rejected'

              WHERE id = $1
                AND status =
                  'pending'

              RETURNING user_id
            `,
            [id]
          )
        ).rows[0];

      if (r) {
        message =
          "❌ Rejected";

        tell(
          r.user_id,
          "❌ Your deposit was rejected. " +
          "Check the transaction ID and try again."
        );
      }
    }

    // -------------------------------
    // WITHDRAWAL PAID
    // -------------------------------

    else if (
      kind === "wd" &&
      action === "paid"
    ) {
      const r =
        (
          await db.query(
            `
              UPDATE withdrawals

              SET status =
                'paid'

              WHERE id = $1
                AND status =
                  'pending'

              RETURNING
                user_id,
                amount
            `,
            [id]
          )
        ).rows[0];

      if (r) {
        message =
          "✅ Marked paid";

        tell(
          r.user_id,
          `✅ ${r.amount} birr was sent to your Telebirr.`
        );
      }
    }

    // -------------------------------
    // WITHDRAWAL REJECT
    // -------------------------------

    else if (
      kind === "wd"
    ) {
      const r =
        (
          await db.query(
            `
              WITH w AS (
                UPDATE withdrawals

                SET status =
                  'rejected'

                WHERE id = $1
                  AND status =
                    'pending'

                RETURNING
                  user_id,
                  amount
              )

              UPDATE users u

              SET balance =
                u.balance + w.amount

              FROM w

              WHERE u.id =
                w.user_id

              RETURNING
                u.id,
                u.balance
            `,
            [id]
          )
        ).rows[0];

      if (r) {
        message =
          "❌ Rejected, refunded";

        tell(
          r.id,
          "❌ Withdrawal rejected. " +
          "The amount was returned to your balance."
        );

        pushBalance(
          r.id,
          r.balance
        );
      }
    }

    await ctx.answerCallbackQuery(
      message
    );

    const oldText =
      ctx.callbackQuery
        .message?.text || "";

    await ctx
      .editMessageText(
        `${oldText}\n\n${message}`
      )
      .catch(() => {});
  }
);

// ---------------------------------------------------------
// BINGO HELPERS
// ---------------------------------------------------------

const rnd = (
  min,
  max
) =>
  min +
  Math.floor(
    Math.random() *
      (max - min + 1)
  );

const shuffle = (
  array
) => {
  for (
    let i =
      array.length - 1;
    i > 0;
    i--
  ) {
    const j =
      rnd(0, i);

    [
      array[i],
      array[j]
    ] = [
      array[j],
      array[i]
    ];
  }

  return array;
};

const hasLine = (
  card,
  drawn
) => {
  const ok = (
    value
  ) =>
    value === 0 ||
    drawn.includes(value);

  const lines = [];

  for (
    let i = 0;
    i < 5;
    i++
  ) {
    lines.push(
      card[i],
      card.map(
        (row) =>
          row[i]
      )
    );
  }

  lines.push(
    card.map(
      (row, i) =>
        row[i]
    ),

    card.map(
      (row, i) =>
        row[4 - i]
    )
  );

  return lines.some(
    (line) =>
      line.every(ok)
  );
};

// ---------------------------------------------------------
// GAME RESET
// ---------------------------------------------------------

function reset() {
  clearInterval(timer);

  const taken =
    new Map();

  // House-funded bots reserve cards.
  // Bots cannot win.
  const botCards =
    shuffle(
      Array.from(
        {
          length: TOTAL
        },
        (_, i) =>
          i + 1
      )
    ).slice(
      0,
      Math.min(
        BOTS,
        TOTAL
      )
    );

  botCards.forEach(
    (number) => {
      taken.set(
        number,
        0
      );
    }
  );

  game = {
    phase:
      "lobby",

    players:
      new Map(),

    taken,

    drawn: [],

    pool:
      shuffle(
        Array.from(
          {
            length: 75
          },
          (_, i) =>
            i + 1
        )
      ),

    countdown:
      null,

    winner:
      null
  };

  broadcast();
}

// ---------------------------------------------------------
// GAME CALCULATIONS
// ---------------------------------------------------------

const cardCount = () =>
  [
    ...game.players.values()
  ].reduce(
    (total, player) =>
      total +
      player.cards.length,
    0
  );

const prize = () =>
  Math.floor(
    cardCount() *
      CARD_PRICE *
      (1 - HOUSE_CUT)
  );

// ---------------------------------------------------------
// GAME VIEW
// ---------------------------------------------------------

const view = (
  uid
) => {
  const player =
    game.players.get(
      uid
    );

  const winner =
    game.winner;

  return {
    type:
      "state",

    phase:
      game.phase,

    countdown:
      game.countdown,

    players:
      game.players.size,

    bots:
      BOTS,

    prize:
      prize(),

    price:
      CARD_PRICE,

    max:
      MAX_CARDS,

    drawn:
      game.drawn,

    cards:
      player?.cards || [],

    taken:
      [
        ...game.taken.keys()
      ],

    winner:
      winner
        ? {
            names:
              winner.names,

            prize:
              winner.prize,

            you:
              winner.ids.includes(
                uid
              )
          }
        : null
  };
};

// ---------------------------------------------------------
// BROADCAST
// ---------------------------------------------------------

function broadcast() {
  clients.forEach(
    (ws) => {
      if (ws.uid) {
        send(
          ws,
          view(ws.uid)
        );
      }
    }
  );
}

// ---------------------------------------------------------
// LOBBY COUNTDOWN
// ---------------------------------------------------------

function startCountdown() {
  clearInterval(timer);

  if (
    game.phase !==
    "lobby"
  ) {
    return;
  }

  game.countdown =
    LOBBY_SECS;

  timer =
    setInterval(
      () => {
        if (
          !game ||
          game.phase !==
            "lobby"
        ) {
          clearInterval(
            timer
          );

          return;
        }

        game.countdown--;

        if (
          game.countdown <=
          0
        ) {
          clearInterval(
            timer
          );

          if (
            game.players.size >=
            MIN_PLAYERS
          ) {
            startDraw();

            return;
          }

          game.countdown =
            null;

          if (
            game.players.size
          ) {
            startCountdown();
          }
        }

        broadcast();
      },
      1000
    );

  broadcast();
}

// ---------------------------------------------------------
// START DRAWING
// ---------------------------------------------------------

function startDraw() {
  clearInterval(timer);

  game.phase =
    "playing";

  game.countdown =
    null;

  timer =
    setInterval(
      async () => {
        if (
          !game ||
          game.phase !==
            "playing"
        ) {
          clearInterval(
            timer
          );

          return;
        }

        const next =
          game.pool.pop();

        if (
          next ===
          undefined
        ) {
          clearInterval(
            timer
          );

          game.phase =
            "ended";

          game.winner =
            null;

          broadcast();

          setTimeout(
            reset,
            10000
          );

          return;
        }

        game.drawn.push(
          next
        );

        try {
          const won =
            await autoBingo();

          if (won) {
            return;
          }
        } catch (e) {
          console.error(
            "Auto bingo error:",
            e
          );
        }

        broadcast();
      },
      DRAW_MS
    );

  broadcast();
}

// ---------------------------------------------------------
// AUTOMATIC BINGO
// ---------------------------------------------------------

async function autoBingo() {
  const ids = [];
  const names = [];

  for (
    const [
      uid,
      player
    ] of game.players
  ) {
    const won =
      player.cards.some(
        (item) =>
          hasLine(
            item.card,
            game.drawn
          )
      );

    if (won) {
      ids.push(uid);
      names.push(
        player.name
      );
    }
  }

  if (!ids.length) {
    return false;
  }

  clearInterval(timer);

  const totalPrize =
    prize();

  const each =
    Math.floor(
      totalPrize /
        ids.length
    );

  game.phase =
    "ended";

  game.winner = {
    ids,
    names,
    prize:
      each
  };

  // Pay winners.
  if (each > 0) {
    const rows =
      (
        await db.query(
          `
            UPDATE users

            SET balance =
              balance + $1

            WHERE id =
              ANY($2::bigint[])

            RETURNING
              id,
              balance
          `,
          [
            each,
            ids
          ]
        )
      ).rows;

    rows.forEach(
      (row) => {
        pushBalance(
          row.id,
          row.balance
        );
      }
    );
  }

  broadcast();

  // Winner remains in the game state
  // for 10 seconds.
  //
  // Your frontend can show its popup
  // for 3 seconds.
  setTimeout(
    reset,
    10000
  );

  return true;
}

// ---------------------------------------------------------
// JOIN CARDS
// ---------------------------------------------------------

async function join(
  ws,
  list
) {
  const currentGame =
    game;

  const error = (
    message
  ) => {
    send(
      ws,
      {
        type:
          "error",
        msg:
          message
      }
    );
  };

  if (
    currentGame.phase !==
    "lobby"
  ) {
    return error(
      "Round already started. Wait for the next one."
    );
  }

  const numbers =
    [
      ...new Set(
        (
          Array.isArray(list)
            ? list
            : []
        ).map(Number)
      )
    ];

  const currentCards =
    currentGame.players.get(
      ws.uid
    )?.cards.length || 0;

  if (
    !numbers.length ||
    numbers.some(
      (number) =>
        !Number.isInteger(
          number
        ) ||
        number < 1 ||
        number > TOTAL
    )
  ) {
    return error(
      `Pick cards from 1 to ${TOTAL}.`
    );
  }

  if (
    currentCards +
      numbers.length >
    MAX_CARDS
  ) {
    return error(
      `You can have up to ${MAX_CARDS} cards.`
    );
  }

  if (
    numbers.some(
      (number) =>
        currentGame.taken.has(
          number
        )
    )
  ) {
    return error(
      "One of those cards is taken. Pick another."
    );
  }

  // Reserve selected cards.
  numbers.forEach(
    (number) => {
      currentGame.taken.set(
        number,
        ws.uid
      );
    }
  );

  const cost =
    numbers.length *
    CARD_PRICE;

  // Charge player.
  const balanceResult =
    (
      await db.query(
        `
          UPDATE users

          SET balance =
            balance - $1

          WHERE id = $2
            AND balance >= $1

          RETURNING balance
        `,
        [
          cost,
          ws.uid
        ]
      )
    ).rows[0];

  if (!balanceResult) {
    numbers.forEach(
      (number) =>
        currentGame.taken.delete(
          number
        )
    );

    return error(
      "Not enough balance. Deposit first."
    );
  }

  // Make sure round did not change
  // during the database operation.
  if (
    game !==
      currentGame ||
    currentGame.phase !==
      "lobby"
  ) {
    const refunded =
      (
        await db.query(
          `
            UPDATE users

            SET balance =
              balance + $1

            WHERE id = $2

            RETURNING balance
          `,
          [
            cost,
            ws.uid
          ]
        )
      ).rows[0];

    pushBalance(
      ws.uid,
      refunded.balance
    );

    return error(
      "Round just started. You were not charged."
    );
  }

  const player =
    currentGame.players.get(
      ws.uid
    ) || {
      name:
        ws.name ||
        "Player",

      cards: []
    };

  numbers.forEach(
    (number) => {
      player.cards.push({
        no:
          number,

        card:
          cardFor(number)
      });
    }
  );

  currentGame.players.set(
    ws.uid,
    player
  );

  pushBalance(
    ws.uid,
    balanceResult.balance
  );

  // Start the 30-second lobby
  // once minimum players join.
  if (
    currentGame.players.size >=
      MIN_PLAYERS &&
    currentGame.countdown ===
      null
  ) {
    startCountdown();
  }

  broadcast();
}

// ---------------------------------------------------------
// HEALTH CHECKS
// ---------------------------------------------------------

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      ok: true,
      service:
        "bingo",
      port:
        PORT,
      database:
        databaseReady,
      application:
        applicationReady
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.status(200).json({
      ok: true,
      database:
        databaseReady,
      application:
        applicationReady
    });
  }
);

// ---------------------------------------------------------
// AUTH MIDDLEWARE
// ---------------------------------------------------------

const auth = (
  req,
  res,
  next
) => {
  const user =
    verify(
      req.get(
        "x-init"
      )
    );

  if (!user) {
    return res
      .status(401)
      .json({
        error:
          "Open this app from Telegram"
      });
  }

  if (!databaseReady) {
    return res
      .status(503)
      .json({
        error:
          "Server is starting. Try again."
      });
  }

  req.user =
    user;

  next();
};

// ---------------------------------------------------------
// /API/ME
// ---------------------------------------------------------

app.get(
  "/api/me",
  auth,
  async (
    req,
    res
  ) => {
    try {
      const balance =
        await upsert(
          req.user
        );

      res.json({
        balance,

        tb: {
          number:
            TELEBIRR_NUMBER ||
            "0982372677",

          name:
            TELEBIRR_NAME ||
            "Telebirr account"
        },

        price:
          CARD_PRICE,

        minDeposit:
          MIN_DEPOSIT,

        minWithdraw:
          MIN_WITHDRAW
      });

    } catch (e) {
      console.error(
        "GET /api/me:",
        e
      );

      res.status(500).json({
        error:
          "Server error"
      });
    }
  }
);

// ---------------------------------------------------------
// DEPOSIT
// ---------------------------------------------------------

app.post(
  "/api/deposit",
  auth,
  async (
    req,
    res
  ) => {
    const amount =
      parseInt(
        req.body.amount
      );

    const tx =
      String(
        req.body.txId ||
          ""
      )
        .trim()
        .toUpperCase();

    if (
      !(amount >=
        MIN_DEPOSIT)
    ) {
      return res
        .status(400)
        .json({
          error:
            `Minimum deposit is ${MIN_DEPOSIT} birr`
        });
    }

    if (
      !/^[A-Z0-9]{10}$/.test(
        tx
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Transaction ID must be 10 letters/numbers"
        });
    }

    try {
      await upsert(
        req.user
      );

      const id =
        (
          await db.query(
            `
              INSERT INTO deposits(
                user_id,
                amount,
                tx_id
              )

              VALUES(
                $1,
                $2,
                $3
              )

              RETURNING id
            `,
            [
              req.user.id,
              amount,
              tx
            ]
          )
        ).rows[0].id;

      const keyboard =
        new InlineKeyboard()
          .text(
            "✅ Approve",
            `dep:ok:${id}`
          )
          .text(
            "❌ Reject",
            `dep:no:${id}`
          );

      bot.api
        .sendMessage(
          ADMIN_ID,

          `Deposit #${id}\n` +
          `${req.user.first_name} (${req.user.id})\n` +
          `Amount: ${amount} birr\n` +
          `Tx: ${tx}\n` +
          `${RECEIPT}${tx}`,

          {
            reply_markup:
              keyboard
          }
        )
        .catch(
          console.error
        );

      res.json({
        ok:
          true
      });

    } catch (e) {
      if (
        e.code ===
        "23505"
      ) {
        return res
          .status(409)
          .json({
            error:
              "This transaction ID was already submitted"
          });
      }

      console.error(
        "Deposit error:",
        e
      );

      res.status(500).json({
        error:
          "Server error"
      });
    }
  }
);

// ---------------------------------------------------------
// WITHDRAWAL
// ---------------------------------------------------------

app.post(
  "/api/withdraw",
  auth,
  async (
    req,
    res
  ) => {
    const amount =
      parseInt(
        req.body.amount
      );

    const phone =
      String(
        req.body.phone ||
          ""
      ).trim();

    if (
      !(amount >=
        MIN_WITHDRAW)
    ) {
      return res
        .status(400)
        .json({
          error:
            `Minimum withdrawal is ${MIN_WITHDRAW} birr`
        });
    }

    if (
      !/^(09|07|\+2519|\+2517)\d{8}$/.test(
        phone
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Enter a valid Telebirr phone number"
        });
    }

    try {
      const balanceResult =
        (
          await db.query(
            `
              UPDATE users

              SET balance =
                balance - $1

              WHERE id = $2
                AND balance >= $1

              RETURNING balance
            `,
            [
              amount,
              req.user.id
            ]
          )
        ).rows[0];

      if (!balanceResult) {
        return res
          .status(400)
          .json({
            error:
              "Not enough balance"
          });
      }

      const id =
        (
          await db.query(
            `
              INSERT INTO withdrawals(
                user_id,
                amount,
                phone
              )

              VALUES(
                $1,
                $2,
                $3
              )

              RETURNING id
            `,
            [
              req.user.id,
              amount,
              phone
            ]
          )
        ).rows[0].id;

      const keyboard =
        new InlineKeyboard()
          .text(
            "✅ Mark paid",
            `wd:paid:${id}`
          )
          .text(
            "❌ Reject",
            `wd:no:${id}`
          );

      bot.api
        .sendMessage(
          ADMIN_ID,

          `Withdrawal #${id}\n` +
          `${req.user.first_name} (${req.user.id})\n` +
          `Amount: ${amount} birr\n` +
          `Telebirr: ${phone}`,

          {
            reply_markup:
              keyboard
          }
        )
        .catch(
          console.error
        );

      res.json({
        ok:
          true,

        balance:
          balanceResult.balance
      });

    } catch (e) {
      console.error(
        "Withdrawal error:",
        e
      );

      res.status(500).json({
        error:
          "Server error"
      });
    }
  }
);

// ---------------------------------------------------------
// HISTORY
// ---------------------------------------------------------

app.get(
  "/api/history",
  auth,
  async (
    req,
    res
  ) => {
    try {
      const result =
        await db.query(
          `
            SELECT
              'Deposit' AS kind,
              amount,
              status,
              created_at

            FROM deposits

            WHERE user_id = $1

            UNION ALL

            SELECT
              'Withdrawal',
              amount,
              status,
              created_at

            FROM withdrawals

            WHERE user_id = $1

            ORDER BY created_at DESC

            LIMIT 15
          `,
          [
            req.user.id
          ]
        );

      res.json({
        items:
          result.rows
      });

    } catch (e) {
      console.error(
        "History error:",
        e
      );

      res.status(500).json({
        error:
          "Server error"
      });
    }
  }
);

// ---------------------------------------------------------
// PROMO
// ---------------------------------------------------------

const promoTries =
  new Map();

app.post(
  "/api/promo",
  auth,
  async (
    req,
    res
  ) => {
    const code =
      String(
        req.body.code ||
          ""
      )
        .trim()
        .toUpperCase();

    const recent =
      (
        promoTries.get(
          req.user.id
        ) || []
      ).filter(
        (time) =>
          Date.now() -
            time <
          60000
      );

    if (
      recent.length >= 8
    ) {
      return res
        .status(429)
        .json({
          error:
            "Too many tries. Wait a minute."
        });
    }

    promoTries.set(
      req.user.id,
      [
        ...recent,
        Date.now()
      ]
    );

    if (
      !/^[A-Z0-9]{3,20}$/.test(
        code
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid promo code"
        });
    }

    const connection =
      await db.connect();

    const fail = (
      message
    ) => {
      throw Object.assign(
        new Error(message),
        {
          user:
            true
        }
      );
    };

    try {
      await connection.query(
        "BEGIN"
      );

      const promo =
        (
          await connection.query(
            `
              SELECT *
              FROM promos

              WHERE code = $1

              FOR UPDATE
            `,
            [code]
          )
        ).rows[0];

      if (
        !promo ||
        !promo.active ||
        (
          promo.expires_at &&
          promo.expires_at <
            new Date()
        )
      ) {
        fail(
          "Invalid or expired promo code"
        );
      }

      if (
        promo.used >=
        promo.max_uses
      ) {
        fail(
          "This promo code has been fully used"
        );
      }

      if (
        REQUIRE_DEPOSIT
      ) {
        const deposit =
          await connection.query(
            `
              SELECT 1

              FROM deposits

              WHERE user_id = $1
                AND status =
                  'approved'

              LIMIT 1
            `,
            [
              req.user.id
            ]
          );

        if (
          !deposit.rowCount
        ) {
          fail(
            "Make your first approved deposit to use promo codes"
          );
        }
      }

      const used =
        await connection.query(
          `
            INSERT INTO promo_uses(
              code,
              user_id
            )

            VALUES(
              $1,
              $2
            )

            ON CONFLICT DO NOTHING
          `,
          [
            code,
            req.user.id
          ]
        );

      if (!used.rowCount) {
        fail(
          "You already used this code"
        );
      }

      await connection.query(
        `
          UPDATE promos

          SET used =
            used + 1

          WHERE code = $1
        `,
        [code]
      );

      const balance =
        (
          await connection.query(
            `
              UPDATE users

              SET balance =
                balance + $1

              WHERE id = $2

              RETURNING balance
            `,
            [
              promo.amount,
              req.user.id
            ]
          )
        ).rows[0];

      await connection.query(
        "COMMIT"
      );

      pushBalance(
        req.user.id,
        balance.balance
      );

      res.json({
        ok:
          true,

        amount:
          promo.amount,

        balance:
          balance.balance
      });

    } catch (e) {
      await connection
        .query(
          "ROLLBACK"
        )
        .catch(() => {});

      if (e.user) {
        return res
          .status(400)
          .json({
            error:
              e.message
          });
      }

      console.error(
        "Promo error:",
        e
      );

      res.status(500).json({
        error:
          "Server error"
      });

    } finally {
      connection.release();
    }
  }
);

// ---------------------------------------------------------
// HTTP + WEBSOCKET
// ---------------------------------------------------------

const server =
  createServer(app);

const wss =
  new WebSocketServer({
    server,
    path:
      "/ws"
  });

// ---------------------------------------------------------
// WEBSOCKET CONNECTION
// ---------------------------------------------------------

wss.on(
  "connection",
  (ws) => {
    clients.add(ws);

    ws.isAlive =
      true;

    ws.on(
      "pong",
      () => {
        ws.isAlive =
          true;
      }
    );

    ws.on(
      "error",
      (error) => {
        console.error(
          "WebSocket error:",
          error.message
        );
      }
    );

    ws.on(
      "close",
      () => {
        clients.delete(
          ws
        );
      }
    );

    ws.on(
      "message",
      async (raw) => {
        let message;

        try {
          message =
            JSON.parse(
              raw.toString()
            );
        } catch {
          return;
        }

        // -------------------------------
        // AUTH
        // -------------------------------

        if (
          message.type ===
          "auth"
        ) {
          try {
            if (
              !databaseReady
            ) {
              return send(
                ws,
                {
                  type:
                    "error",
                  msg:
                    "Server is starting. Try again."
                }
              );
            }

            const user =
              verify(
                message.initData
              );

            if (!user) {
              ws.close();
              return;
            }

            ws.uid =
              user.id;

            ws.name =
              user.first_name ||
              "Player";

            const balance =
              await upsert(
                user
              );

            send(
              ws,
              {
                type:
                  "balance",
                balance
              }
            );

            send(
              ws,
              view(
                user.id
              )
            );

          } catch (e) {
            console.error(
              "WebSocket auth error:",
              e
            );

            ws.close();
          }

          return;
        }

        if (!ws.uid) {
          return;
        }

        // -------------------------------
        // GAME MESSAGES
        // -------------------------------

        try {
          if (
            message.type ===
            "join"
          ) {
            await join(
              ws,
              message.cards
            );
          }

        } catch (e) {
          console.error(
            "WebSocket message error:",
            e
          );

          send(
            ws,
            {
              type:
                "error",

              msg:
                "Server error"
            }
          );
        }
      }
    );
  }
);

// ---------------------------------------------------------
// WEBSOCKET HEARTBEAT
// ---------------------------------------------------------

const wsHeartbeat =
  setInterval(
    () => {
      wss.clients.forEach(
        (ws) => {
          if (
            ws.isAlive ===
            false
          ) {
            clients.delete(
              ws
            );

            return ws.terminate();
          }

          ws.isAlive =
            false;

          ws.ping();
        }
      );
    },
    30000
  );

// ---------------------------------------------------------
// GRACEFUL SHUTDOWN
// ---------------------------------------------------------

let shuttingDown =
  false;

async function shutdown(
  signal
) {
  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

  console.log(
    `${signal} received. Shutting down...`
  );

  clearInterval(
    timer
  );

  clearInterval(
    wsHeartbeat
  );

  try {
    bot.stop();

    // Terminate connected sockets so
    // Railway can shut down cleanly.
    wss.clients.forEach(
      (ws) => {
        try {
          ws.close();
        } catch {}
      }
    );

    await new Promise(
      (resolve) => {
        server.close(
          () => resolve()
        );
      }
    );

    await db.end();

    console.log(
      "Shutdown complete"
    );

    process.exit(0);

  } catch (e) {
    console.error(
      "Shutdown error:",
      e
    );

    process.exit(1);
  }
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

// ---------------------------------------------------------
// RAILWAY SERVER START
// ---------------------------------------------------------
//
// IMPORTANT:
// Start listening BEFORE PostgreSQL initialization.
//
// Railway can then immediately see:
//
//     0.0.0.0:$PORT
//
// instead of waiting for PostgreSQL.
// ---------------------------------------------------------

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================="
    );

    console.log(
      `Bingo HTTP server running on ${PORT}`
    );

    console.log(
      `Listening on 0.0.0.0:${PORT}`
    );

    console.log(
      "Health: /health"
    );

    console.log(
      "WebSocket: /ws"
    );

    console.log(
      "================================="
    );

    // Initialize application AFTER
    // Railway can reach the server.
    initializeApplication();
  }
);

// ---------------------------------------------------------
// APPLICATION INITIALIZATION
// ---------------------------------------------------------

async function initializeApplication() {
  try {
    console.log(
      "Initializing Bingo application..."
    );

    // PostgreSQL
    await initDatabase();

    // Start first Bingo round.
    reset();

    // Start Telegram bot.
    bot.start({
      onStart: (
        botInfo
      ) => {
        console.log(
          `Telegram bot started: @${botInfo.username}`
        );
      }
    }).catch(
      (error) => {
        console.error(
          "Telegram bot error:",
          error
        );
      }
    );

    applicationReady =
      true;

    console.log(
      "================================="
    );

    console.log(
      "Bingo application READY"
    );

    console.log(
      "PostgreSQL: READY"
    );

    console.log(
      "Telegram Bot: STARTING"
    );

    console.log(
      "Bingo Game: READY"
    );

    console.log(
      "================================="
    );

  } catch (error) {
    console.error(
      "FATAL APPLICATION STARTUP ERROR:"
    );

    console.error(
      error
    );

    // Keep HTTP server alive long enough
    // for Railway logs/health monitoring.
    databaseReady =
      false;

    applicationReady =
      false;

    // Retry database initialization
    // rather than immediately killing
    // the Railway container.
    setTimeout(
      initializeApplication,
      5000
    );
  }
}
