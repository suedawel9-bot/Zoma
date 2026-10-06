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

// Railway provides PORT automatically.
// 8080 is only the fallback for local/self-hosted use.
const PORT = Number(process.env.PORT) || 8080;

const CARD_PRICE = 10;
const HOUSE_CUT = 0.2;
const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;

const REQUIRE_DEPOSIT =
  process.env.PROMO_REQUIRE_DEPOSIT !== "false";

const MIN_PLAYERS = 2;
const LOBBY_SECS = 30;
const DRAW_MS = 4000;

const MAX_CARDS = 4;
const BOTS = Number(process.env.BOTS ?? 100);

const RECEIPT =
  "https://transactioninfo.ethiotelecom.et/receipt/";

// ---------------------------------------------------------
// Environment validation
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
// PostgreSQL
// ---------------------------------------------------------

const db = new pg.Pool({
  connectionString: DATABASE_URL,

  // Railway internal PostgreSQL connections do not need SSL.
  // Public PostgreSQL URLs normally do.
  ssl: DATABASE_URL.includes("railway.internal")
    ? false
    : { rejectUnauthorized: false },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

db.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

// ---------------------------------------------------------
// Database initialization
// ---------------------------------------------------------

async function initDatabase() {
  console.log("Connecting to PostgreSQL...");

  await db.query("SELECT 1");

  console.log("PostgreSQL connection OK");

  await db.query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGINT PRIMARY KEY,
      name TEXT,
      balance INT NOT NULL DEFAULT 0 CHECK(balance >= 0)
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
  `);

  await db.query(`
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

  console.log("Database tables ready");
}

// ---------------------------------------------------------
// Telegram Mini App authentication
// ---------------------------------------------------------

function verify(initData) {
  try {
    if (!initData || !BOT_TOKEN) return null;

    const p = new URLSearchParams(initData);

    const hash = p.get("hash");

    if (!hash) return null;

    p.delete("hash");

    const str = [...p.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");

    const key = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calc = crypto
      .createHmac("sha256", key)
      .update(str)
      .digest("hex");

    if (calc !== hash) {
      return null;
    }

    const authDate = Number(p.get("auth_date"));

    if (!authDate || Date.now() / 1000 - authDate > 86400) {
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
// User helper
// ---------------------------------------------------------

const upsert = async (u) => {
  const r = await db.query(
    `
      INSERT INTO users(id, name)
      VALUES($1, $2)

      ON CONFLICT(id)
      DO UPDATE SET name = $2

      RETURNING balance
    `,
    [
      u.id,
      u.first_name || "Player"
    ]
  );

  return r.rows[0].balance;
};

// ---------------------------------------------------------
// Telegram Bot
// ---------------------------------------------------------

const bot = new Bot(BOT_TOKEN);

const isAdmin = (ctx) =>
  String(ctx.from?.id) === String(ADMIN_ID);

const tell = (id, text) =>
  bot.api
    .sendMessage(id, text)
    .catch(() => {});

bot.command("start", (ctx) =>
  ctx.reply(
    "Welcome to Bingo! Tap the Play button to start."
  )
);

// ---------------------------------------------------------
// Promo commands
// ---------------------------------------------------------

bot.command("newpromo", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const [code, amount, max, days] =
    ctx.match.trim().split(/\s+/);

  const a = parseInt(amount);
  const m = parseInt(max);
  const d = parseInt(days);

  if (
    !/^[A-Za-z0-9]{3,20}$/.test(code || "") ||
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
      `✅ Promo ${code.toUpperCase()}: ${a} birr, ` +
      `${m} uses` +
      `${d > 0 ? `, expires in ${d} days` : ""}`
    );
  } catch (e) {
    await ctx.reply(
      e.code === "23505"
        ? "That code already exists."
        : "Error creating code."
    );
  }
});

bot.command("promos", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const r = (
    await db.query(
      `
      SELECT *
      FROM promos
      ORDER BY created_at DESC
      LIMIT 20
      `
    )
  ).rows;

  await ctx.reply(
    r.length
      ? r
          .map(
            (p) =>
              `${p.code}: ${p.amount} birr, ` +
              `${p.used}/${p.max_uses} used` +
              `${p.active ? "" : " (stopped)"}` +
              `${
                p.expires_at
                  ? `, expires ${p.expires_at
                      .toISOString()
                      .slice(0, 10)}`
                  : ""
              }`
          )
          .join("\n")
      : "No promo codes yet."
  );
});

bot.command("stoppromo", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const r = await db.query(
    `
    UPDATE promos
    SET active = false
    WHERE code = $1
    `,
    [
      ctx.match
        .trim()
        .toUpperCase()
    ]
  );

  await ctx.reply(
    r.rowCount
      ? "Promo stopped."
      : "Code not found."
  );
});

// ---------------------------------------------------------
// Admin deposit / withdrawal buttons
// ---------------------------------------------------------

bot.on("callback_query:data", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery("Not allowed");
  }

  const [
    kind,
    act,
    id
  ] = ctx.callbackQuery.data.split(":");

  let msg = "Already handled";

  // ---------------- Deposit approve ----------------

  if (
    kind === "dep" &&
    act === "ok"
  ) {
    const r = (
      await db.query(
        `
        WITH d AS (
          UPDATE deposits
          SET status = 'approved'
          WHERE id = $1
            AND status = 'pending'
          RETURNING user_id, amount
        )

        UPDATE users u
        SET balance = u.balance + d.amount

        FROM d

        WHERE u.id = d.user_id

        RETURNING
          u.id,
          d.amount,
          u.balance
        `,
        [id]
      )
    ).rows[0];

    if (r) {
      msg = `✅ Approved ${r.amount} birr`;

      tell(
        r.id,
        `✅ Deposit of ${r.amount} birr approved. ` +
        `Balance: ${r.balance} birr.`
      );

      pushBalance(
        r.id,
        r.balance
      );
    }
  }

  // ---------------- Deposit reject ----------------

  else if (kind === "dep") {
    const r = (
      await db.query(
        `
        UPDATE deposits
        SET status = 'rejected'

        WHERE id = $1
          AND status = 'pending'

        RETURNING user_id
        `,
        [id]
      )
    ).rows[0];

    if (r) {
      msg = "❌ Rejected";

      tell(
        r.user_id,
        "❌ Your deposit was rejected. " +
        "Check the transaction ID and try again."
      );
    }
  }

  // ---------------- Withdrawal paid ----------------

  else if (
    kind === "wd" &&
    act === "paid"
  ) {
    const r = (
      await db.query(
        `
        UPDATE withdrawals
        SET status = 'paid'

        WHERE id = $1
          AND status = 'pending'

        RETURNING user_id, amount
        `,
        [id]
      )
    ).rows[0];

    if (r) {
      msg = "✅ Marked paid";

      tell(
        r.user_id,
        `✅ ${r.amount} birr was sent to your Telebirr.`
      );
    }
  }

  // ---------------- Withdrawal reject ----------------

  else if (kind === "wd") {
    const r = (
      await db.query(
        `
        WITH w AS (
          UPDATE withdrawals
          SET status = 'rejected'

          WHERE id = $1
            AND status = 'pending'

          RETURNING user_id, amount
        )

        UPDATE users u
        SET balance = u.balance + w.amount

        FROM w

        WHERE u.id = w.user_id

        RETURNING
          u.id,
          u.balance
        `,
        [id]
      )
    ).rows[0];

    if (r) {
      msg = "❌ Rejected, refunded";

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

  await ctx.answerCallbackQuery(msg);

  await ctx
    .editMessageText(
      `${ctx.callbackQuery.message.text}\n\n${msg}`
    )
    .catch(() => {});
});

// ---------------------------------------------------------
// Bingo game
// ---------------------------------------------------------

const rnd = (a, b) =>
  a +
  Math.floor(
    Math.random() * (b - a + 1)
  );

const shuffle = (a) => {
  for (
    let i = a.length - 1;
    i > 0;
    i--
  ) {
    const j = rnd(0, i);

    [
      a[i],
      a[j]
    ] = [
      a[j],
      a[i]
    ];
  }

  return a;
};

const hasLine = (
  card,
  drawn
) => {
  const ok = (v) =>
    v === 0 ||
    drawn.includes(v);

  const lines = [];

  for (let i = 0; i < 5; i++) {
    lines.push(
      card[i],
      card.map((r) => r[i])
    );
  }

  lines.push(
    card.map((r, i) => r[i]),
    card.map((r, i) => r[4 - i])
  );

  return lines.some((l) =>
    l.every(ok)
  );
};

let game;
let timer;

// ---------------------------------------------------------
// WebSocket clients
// ---------------------------------------------------------

const clients = new Set();

const send = (ws, obj) => {
  if (
    ws.readyState === 1
  ) {
    ws.send(
      JSON.stringify(obj)
    );
  }
};

function broadcast() {
  clients.forEach((ws) => {
    if (ws.uid) {
      send(
        ws,
        view(ws.uid)
      );
    }
  });
}

function pushBalance(
  uid,
  balance
) {
  clients.forEach((ws) => {
    if (ws.uid == uid) {
      send(
        ws,
        {
          type: "balance",
          balance
        }
      );
    }
  });
}

// ---------------------------------------------------------
// Game state
// ---------------------------------------------------------

function reset() {
  clearInterval(timer);

  const taken = new Map();

  // Bots are house-funded.
  // They reserve cards but never win.
  shuffle(
    Array.from(
      {
        length: TOTAL
      },
      (_, i) => i + 1
    )
  )
    .slice(
      0,
      BOTS
    )
    .forEach((n) => {
      taken.set(n, 0);
    });

  game = {
    phase: "lobby",

    players: new Map(),

    taken,

    drawn: [],

    pool: shuffle(
      Array.from(
        {
          length: 75
        },
        (_, i) => i + 1
      )
    ),

    countdown: null,

    winner: null
  };

  broadcast();
}

const cardCount = () =>
  [
    ...game.players.values()
  ].reduce(
    (n, p) =>
      n + p.cards.length,
    0
  );

const prize = () =>
  Math.floor(
    cardCount() *
    CARD_PRICE *
    (1 - HOUSE_CUT)
  );

const view = (uid) => {
  const p =
    game.players.get(uid);

  const w =
    game.winner;

  return {
    type: "state",

    phase: game.phase,

    countdown:
      game.countdown,

    players:
      game.players.size,

    bots: BOTS,

    prize:
      prize(),

    price:
      CARD_PRICE,

    max:
      MAX_CARDS,

    drawn:
      game.drawn,

    cards:
      p?.cards ?? [],

    taken:
      [...game.taken.keys()],

    winner:
      w
        ? {
            names: w.names,
            prize: w.prize,
            you: w.ids.includes(uid)
          }
        : null
  };
};

// ---------------------------------------------------------
// Bingo lobby countdown
// ---------------------------------------------------------

function startCountdown() {
  clearInterval(timer);

  game.countdown =
    LOBBY_SECS;

  timer = setInterval(() => {
    if (
      !game ||
      game.phase !== "lobby"
    ) {
      clearInterval(timer);
      return;
    }

    game.countdown--;

    if (
      game.countdown <= 0
    ) {
      clearInterval(timer);

      if (
        game.players.size >=
        MIN_PLAYERS
      ) {
        startDraw();
        return;
      }

      game.countdown = null;

      if (
        game.players.size
      ) {
        startCountdown();
      }
    }

    broadcast();
  }, 1000);

  broadcast();
}

// ---------------------------------------------------------
// Start number drawing
// ---------------------------------------------------------

function startDraw() {
  clearInterval(timer);

  game.phase =
    "playing";

  game.countdown =
    null;

  timer = setInterval(
    async () => {
      if (
        !game ||
        game.phase !==
          "playing"
      ) {
        clearInterval(timer);
        return;
      }

      const next =
        game.pool.pop();

      if (
        next === undefined
      ) {
        clearInterval(timer);

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

      game.drawn.push(next);

      try {
        if (
          await autoBingo()
        ) {
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
// Automatic Bingo checking
// ---------------------------------------------------------

async function autoBingo() {
  const ids = [];
  const names = [];

  for (
    const [
      uid,
      p
    ] of game.players
  ) {
    if (
      p.cards.some(
        (c) =>
          hasLine(
            c.card,
            game.drawn
          )
      )
    ) {
      ids.push(uid);
      names.push(p.name);
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
    prize: each
  };

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

          RETURNING id, balance
          `,
          [
            each,
            ids
          ]
        )
      ).rows;

    rows.forEach(
      (r) => {
        pushBalance(
          r.id,
          r.balance
        );
      }
    );
  }

  broadcast();

  // Keep winner visible for 10 seconds.
  // Your frontend can display the winner popup
  // for 3 seconds as already implemented.
  setTimeout(
    reset,
    10000
  );

  return true;
}

// ---------------------------------------------------------
// Join Bingo cards
// ---------------------------------------------------------

async function join(
  ws,
  list
) {
  const g =
    game;

  const err = (msg) =>
    send(
      ws,
      {
        type: "error",
        msg
      }
    );

  if (
    g.phase !== "lobby"
  ) {
    return err(
      "Round already started. Wait for the next one."
    );
  }

  const nos = [
    ...new Set(
      (
        Array.isArray(list)
          ? list
          : []
      ).map(Number)
    )
  ];

  const mine =
    g.players.get(
      ws.uid
    )?.cards.length ?? 0;

  if (
    !nos.length ||
    nos.some(
      (n) =>
        !Number.isInteger(n) ||
        n < 1 ||
        n > TOTAL
    )
  ) {
    return err(
      "Pick cards from 1 to 500."
    );
  }

  if (
    mine + nos.length >
    MAX_CARDS
  ) {
    return err(
      `You can have up to ${MAX_CARDS} cards.`
    );
  }

  if (
    nos.some((n) =>
      g.taken.has(n)
    )
  ) {
    return err(
      "One of those cards is taken. Pick another."
    );
  }

  // Reserve cards before charging.
  nos.forEach((n) =>
    g.taken.set(
      n,
      ws.uid
    )
  );

  const cost =
    nos.length *
    CARD_PRICE;

  const r = (
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

  if (!r) {
    nos.forEach((n) =>
      g.taken.delete(n)
    );

    return err(
      "Not enough balance. Deposit first."
    );
  }

  // Protect against round changing while
  // the database transaction is happening.
  if (
    game !== g ||
    g.phase !== "lobby"
  ) {
    const b = (
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
      b.balance
    );

    return err(
      "Round just started. You were not charged."
    );
  }

  const p =
    g.players.get(
      ws.uid
    ) ?? {
      name:
        ws.name,
      cards: []
    };

  nos.forEach(
    (n) => {
      p.cards.push({
        no: n,
        card:
          cardFor(n)
      });
    }
  );

  g.players.set(
    ws.uid,
    p
  );

  pushBalance(
    ws.uid,
    r.balance
  );

  if (
    g.players.size >=
      MIN_PLAYERS &&
    g.countdown === null
  ) {
    startCountdown();
  }

  broadcast();
}

// ---------------------------------------------------------
// Express HTTP server
// ---------------------------------------------------------

const app =
  express();

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static("public")
);

// Railway health check
app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      ok: true,
      service: "bingo",
      port: PORT
    });
  }
);

// Root fallback
           
