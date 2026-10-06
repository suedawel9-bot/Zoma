import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { Bot, InlineKeyboard } from "grammy";
import pg from "pg";
import crypto from "crypto";
import { cardFor, TOTAL } from "./public/cards.js";

const { BOT_TOKEN, ADMIN_ID, DATABASE_URL, TELEBIRR_NUMBER, TELEBIRR_NAME, PORT = 3000 } = process.env;
const CARD_PRICE = 10, HOUSE_CUT = 0.2, MIN_DEPOSIT = 10, MIN_WITHDRAW = 50;
const REQUIRE_DEPOSIT = process.env.PROMO_REQUIRE_DEPOSIT !== "false"; // promo needs 1 approved deposit
const MIN_PLAYERS = 2, LOBBY_SECS = 30, DRAW_MS = 4000;
const RECEIPT = "https://transactioninfo.ethiotelecom.et/receipt/";

const db = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("railway.internal") ? false : { rejectUnauthorized: false },
});
await db.query(`
CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, name TEXT, balance INT NOT NULL DEFAULT 0 CHECK(balance>=0));
CREATE TABLE IF NOT EXISTS deposits(id SERIAL PRIMARY KEY, user_id BIGINT, amount INT, tx_id TEXT UNIQUE, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS withdrawals(id SERIAL PRIMARY KEY, user_id BIGINT, amount INT, phone TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());`);

await db.query(`
CREATE TABLE IF NOT EXISTS promos(code TEXT PRIMARY KEY, amount INT NOT NULL, max_uses INT NOT NULL, used INT NOT NULL DEFAULT 0, active BOOL NOT NULL DEFAULT true, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS promo_uses(code TEXT, user_id BIGINT, used_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(code, user_id));`);

// ---------- Telegram auth ----------
function verify(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get("hash"); p.delete("hash");
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const key = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", key).update(str).digest("hex");
    if (calc !== hash) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
    return JSON.parse(p.get("user"));
  } catch { return null; }
}
const upsert = async (u) => (await db.query(
  `INSERT INTO users(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=$2 RETURNING balance`,
  [u.id, u.first_name || "Player"])).rows[0].balance;

// ---------- Bot (admin approvals) ----------
const bot = new Bot(BOT_TOKEN);
const isAdmin = (ctx) => String(ctx.from?.id) === String(ADMIN_ID);
const tell = (id, text) => bot.api.sendMessage(id, text).catch(() => {});

bot.command("start", (ctx) => ctx.reply("Welcome to Bingo! Tap the Play button to start."));

// Admin promo commands
bot.command("newpromo", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [code, amount, max, days] = ctx.match.trim().split(/\s+/);
  const a = parseInt(amount), m = parseInt(max), d = parseInt(days);
  if (!/^[A-Za-z0-9]{3,20}$/.test(code || "") || !(a > 0) || !(m > 0))
    return ctx.reply("Usage: /newpromo CODE BIRR MAX_USES [DAYS]\nExample: /newpromo WELCOME20 20 100 7");
  try {
    await db.query(`INSERT INTO promos(code,amount,max_uses,expires_at) VALUES($1,$2,$3,${d > 0 ? "now() + make_interval(days => $4)" : "NULL"})`,
      d > 0 ? [code.toUpperCase(), a, m, d] : [code.toUpperCase(), a, m]);
    ctx.reply(`✅ Promo ${code.toUpperCase()}: ${a} birr, ${m} uses${d > 0 ? `, expires in ${d} days` : ""}`);
  } catch (e) { ctx.reply(e.code === "23505" ? "That code already exists." : "Error creating code."); }
});
bot.command("promos", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = (await db.query(`SELECT * FROM promos ORDER BY created_at DESC LIMIT 20`)).rows;
  ctx.reply(r.length ? r.map((p) => `${p.code}: ${p.amount} birr, ${p.used}/${p.max_uses} used${p.active ? "" : " (stopped)"}${p.expires_at ? `, expires ${p.expires_at.toISOString().slice(0, 10)}` : ""}`).join("\n") : "No promo codes yet.");
});
bot.command("stoppromo", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = await db.query(`UPDATE promos SET active=false WHERE code=$1`, [ctx.match.trim().toUpperCase()]);
  ctx.reply(r.rowCount ? "Promo stopped." : "Code not found.");
});

bot.on("callback_query:data", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery("Not allowed");
  const [kind, act, id] = ctx.callbackQuery.data.split(":");
  let msg = "Already handled";
  if (kind === "dep" && act === "ok") {
    const r = (await db.query(
      `WITH d AS (UPDATE deposits SET status='approved' WHERE id=$1 AND status='pending' RETURNING user_id, amount)
       UPDATE users u SET balance=u.balance+d.amount FROM d WHERE u.id=d.user_id RETURNING u.id, d.amount, u.balance`, [id])).rows[0];
    if (r) { msg = `✅ Approved ${r.amount} birr`; tell(r.id, `✅ Deposit of ${r.amount} birr approved. Balance: ${r.balance} birr.`); pushBalance(r.id, r.balance); }
  } else if (kind === "dep") {
    const r = (await db.query(`UPDATE deposits SET status='rejected' WHERE id=$1 AND status='pending' RETURNING user_id`, [id])).rows[0];
    if (r) { msg = "❌ Rejected"; tell(r.user_id, "❌ Your deposit was rejected. Check the transaction ID and try again."); }
  } else if (kind === "wd" && act === "paid") {
    const r = (await db.query(`UPDATE withdrawals SET status='paid' WHERE id=$1 AND status='pending' RETURNING user_id, amount`, [id])).rows[0];
    if (r) { msg = "✅ Marked paid"; tell(r.user_id, `✅ ${r.amount} birr was sent to your Telebirr.`); }
  } else if (kind === "wd") {
    const r = (await db.query(
      `WITH w AS (UPDATE withdrawals SET status='rejected' WHERE id=$1 AND status='pending' RETURNING user_id, amount)
       UPDATE users u SET balance=u.balance+w.amount FROM w WHERE u.id=w.user_id RETURNING u.id, u.balance`, [id])).rows[0];
    if (r) { msg = "❌ Rejected, refunded"; tell(r.id, "❌ Withdrawal rejected. The amount was returned to your balance."); pushBalance(r.id, r.balance); }
  }
  await ctx.answerCallbackQuery(msg);
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n${msg}`).catch(() => {});
});

// ---------- Game (in memory, single instance) ----------
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const hasLine = (card, drawn) => {
  const ok = (v) => v === 0 || drawn.includes(v);
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push(card[i], card.map((r) => r[i]));
  }
  lines.push(card.map((r, i) => r[i]), card.map((r, i) => r[4 - i]));
  return lines.some((l) => l.every(ok));
};

const MAX_CARDS = 4, BOTS = Number(process.env.BOTS ?? 100);
let game, timer;
function reset() {
  clearInterval(timer);
  const taken = new Map();
  // Bots are house-funded, labelled "bots" in the app, and never win or take prize money.
  shuffle(Array.from({ length: TOTAL }, (_, i) => i + 1)).slice(0, BOTS).forEach((n) => taken.set(n, 0));
  game = { phase: "lobby", players: new Map(), taken, drawn: [], pool: shuffle(Array.from({ length: 75 }, (_, i) => i + 1)), countdown: null, winner: null };
  broadcast();
}
const cardCount = () => [...game.players.values()].reduce((n, p) => n + p.cards.length, 0);
const prize = () => Math.floor(cardCount() * CARD_PRICE * (1 - HOUSE_CUT));
const view = (uid) => {
  const p = game.players.get(uid), w = game.winner;
  return {
    type: "state", phase: game.phase, countdown: game.countdown, players: game.players.size, bots: BOTS, prize: prize(),
    price: CARD_PRICE, max: MAX_CARDS, drawn: game.drawn, cards: p?.cards ?? [], taken: [...game.taken.keys()],
    winner: w && { names: w.names, prize: w.prize, you: w.ids.includes(uid) },
  };
};
const clients = new Set();
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
function broadcast() { clients.forEach((ws) => ws.uid && send(ws, view(ws.uid))); }
function pushBalance(uid, balance) { clients.forEach((ws) => ws.uid == uid && send(ws, { type: "balance", balance })); }

function startCountdown() {
  game.countdown = LOBBY_SECS;
  timer = setInterval(() => {
    game.countdown--;
    if (game.countdown <= 0) {
      clearInterval(timer);
      if (game.players.size >= MIN_PLAYERS) return startDraw();
      game.countdown = null; if (game.players.size) startCountdown();
    }
    broadcast();
  }, 1000);
  broadcast();
}
function startDraw() {
  game.phase = "playing"; game.countdown = null;
  timer = setInterval(async () => {
    game.drawn.push(game.pool.pop());
    try { if (await autoBingo()) return; } catch (e) { console.error(e); }
    broadcast();
  }, DRAW_MS);
  broadcast();
}
// Auto bingo: after every draw the server checks every real player's cards. No button needed.
async function autoBingo() {
  const ids = [], names = [];
  for (const [uid, p] of game.players) if (p.cards.some((c) => hasLine(c.card, game.drawn))) { ids.push(uid); names.push(p.name); }
  if (!ids.length) return false;
  clearInterval(timer);
  const each = Math.floor(prize() / ids.length);
  game.phase = "ended"; game.winner = { ids, names, prize: each };
  const rows = (await db.query(`UPDATE users SET balance=balance+$1 WHERE id=ANY($2::bigint[]) RETURNING id, balance`, [each, ids])).rows;
  rows.forEach((r) => pushBalance(r.id, r.balance));
  broadcast();
  setTimeout(reset, 10000);
  return true;
}
async function join(ws, list) {
  const g = game, err = (msg) => send(ws, { type: "error", msg });
  if (g.phase !== "lobby") return err("Round already started. Wait for the next one.");
  const nos = [...new Set((Array.isArray(list) ? list : []).map(Number))];
  const mine = g.players.get(ws.uid)?.cards.length ?? 0;
  if (!nos.length || nos.some((n) => !Number.isInteger(n) || n < 1 || n > TOTAL)) return err("Pick cards from 1 to 500.");
  if (mine + nos.length > MAX_CARDS) return err(`You can have up to ${MAX_CARDS} cards.`);
  if (nos.some((n) => g.taken.has(n))) return err("One of those cards is taken. Pick another.");
  nos.forEach((n) => g.taken.set(n, ws.uid));
  const cost = nos.length * CARD_PRICE;
  const r = (await db.query(`UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING balance`, [cost, ws.uid])).rows[0];
  if (!r) { nos.forEach((n) => g.taken.delete(n)); return err("Not enough balance. Deposit first."); }
  if (game !== g || g.phase !== "lobby") { // round started while paying: refund
    const b = (await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING balance`, [cost, ws.uid])).rows[0];
    pushBalance(ws.uid, b.balance); return err("Round just started. You were not charged.");
  }
  const p = g.players.get(ws.uid) ?? { name: ws.name, cards: [] };
  nos.forEach((n) => p.cards.push({ no: n, card: cardFor(n) }));
  g.players.set(ws.uid, p);
  pushBalance(ws.uid, r.balance);
  if (g.players.size >= MIN_PLAYERS && g.countdown === null) startCountdown();
  broadcast();
}

// ---------- HTTP + WS ----------
const app = express();
app.use(express.json());
app.use(express.static("public"));
const auth = (req, res, next) => { const u = verify(req.get("x-init")); if (!u) return res.status(401).json({ error: "Open this app from Telegram" }); req.user = u; next(); };

app.get("/api/me", auth, async (req, res) =>
  res.json({ balance: await upsert(req.user), tb: { number: TELEBIRR_NUMBER || "0982372677", name: TELEBIRR_NAME || "Telebirr account" }, price: CARD_PRICE, minDeposit: MIN_DEPOSIT, minWithdraw: MIN_WITHDRAW }));

app.post("/api/deposit", auth, async (req, res) => {
  const amount = parseInt(req.body.amount), tx = String(req.body.txId || "").trim().toUpperCase();
  if (!(amount >= MIN_DEPOSIT)) return res.status(400).json({ error: `Minimum deposit is ${MIN_DEPOSIT} birr` });
  if (!/^[A-Z0-9]{10}$/.test(tx)) return res.status(400).json({ error: "Transaction ID must be 10 letters/numbers" });
  await upsert(req.user);
  try {
    const id = (await db.query(`INSERT INTO deposits(user_id,amount,tx_id) VALUES($1,$2,$3) RETURNING id`, [req.user.id, amount, tx])).rows[0].id;
    const kb = new InlineKeyboard().text("✅ Approve", `dep:ok:${id}`).text("❌ Reject", `dep:no:${id}`);
    bot.api.sendMessage(ADMIN_ID, `Deposit #${id}\n${req.user.first_name} (${req.user.id})\nAmount: ${amount} birr\nTx: ${tx}\n${RECEIPT}${tx}`, { reply_markup: kb }).catch(console.error);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "This transaction ID was already submitted" });
    console.error(e); res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/withdraw", auth, async (req, res) => {
  const amount = parseInt(req.body.amount), phone = String(req.body.phone || "").trim();
  if (!(amount >= MIN_WITHDRAW)) return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} birr` });
  if (!/^(09|07|\+2519|\+2517)\d{8}$/.test(phone)) return res.status(400).json({ error: "Enter a valid Telebirr phone number" });
  const b = (await db.query(`UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING balance`, [amount, req.user.id])).rows[0];
  if (!b) return res.status(400).json({ error: "Not enough balance" });
  const id = (await db.query(`INSERT INTO withdrawals(user_id,amount,phone) VALUES($1,$2,$3) RETURNING id`, [req.user.id, amount, phone])).rows[0].id;
  const kb = new InlineKeyboard().text("✅ Mark paid", `wd:paid:${id}`).text("❌ Reject", `wd:no:${id}`);
  bot.api.sendMessage(ADMIN_ID, `Withdrawal #${id}\n${req.user.first_name} (${req.user.id})\nAmount: ${amount} birr\nTelebirr: ${phone}`, { reply_markup: kb }).catch(console.error);
  res.json({ ok: true, balance: b.balance });
});

app.get("/api/history", auth, async (req, res) => {
  const r = await db.query(`SELECT 'Deposit' AS kind, amount, status, created_at FROM deposits WHERE user_id=$1
    UNION ALL SELECT 'Withdrawal', amount, status, created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [req.user.id]);
  res.json({ items: r.rows });
});

const tries = new Map();
app.post("/api/promo", auth, async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const recent = (tries.get(req.user.id) || []).filter((t) => Date.now() - t < 60000);
  if (recent.length >= 8) return res.status(429).json({ error: "Too many tries. Wait a minute." });
  tries.set(req.user.id, [...recent, Date.now()]);
  if (!/^[A-Z0-9]{3,20}$/.test(code)) return res.status(400).json({ error: "Invalid promo code" });
  await upsert(req.user);
  const c = await db.connect();
  const fail = (m) => { throw Object.assign(new Error(m), { user: true }); };
  try {
    await c.query("BEGIN");
    const p = (await c.query("SELECT * FROM promos WHERE code=$1 FOR UPDATE", [code])).rows[0];
    if (!p || !p.active || (p.expires_at && p.expires_at < new Date())) fail("Invalid or expired promo code");
    if (p.used >= p.max_uses) fail("This promo code has been fully used");
    if (REQUIRE_DEPOSIT && !(await c.query("SELECT 1 FROM deposits WHERE user_id=$1 AND status='approved' LIMIT 1", [req.user.id])).rowCount)
      fail("Make your first approved deposit to use promo codes");
    if (!(await c.query("INSERT INTO promo_uses(code,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [code, req.user.id])).rowCount) fail("You already used this code");
    await c.query("UPDATE promos SET used=used+1 WHERE code=$1", [code]);
    const b = (await c.query("UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING balance", [p.amount, req.user.id])).rows[0];
    await c.query("COMMIT");
    pushBalance(req.user.id, b.balance);
    res.json({ ok: true, amount: p.amount, balance: b.balance });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    if (e.user) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: "Server error" });
  } finally { c.release(); }
});

const server = createServer(app);
new WebSocketServer({ server, path: "/ws" }).on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "auth") {
      const u = verify(m.initData); if (!u) return ws.close();
      ws.uid = u.id; ws.name = u.first_name || "Player"; send(ws, { type: "balance", balance: await upsert(u) }); return send(ws, view(u.id));
    }
    if (!ws.uid) return;
    try { if (m.type === "join") await join(ws, m.cards); } catch (e) { console.error(e); }
  });
});

reset();
bot.start();
server.listen(PORT, () => console.log("Bingo running on", PORT));
