# Bingo Telegram Mini App (Telebirr, manual approval)

Files: server.js, package.json, railway.json, .env.example, public/index.html, public/cards.js

## Deploy on Railway
1. Create a bot in @BotFather (/newbot) and copy the token.
2. Get your numeric Telegram ID from @userinfobot. Send /start to your new bot once.
3. Push this folder to a GitHub repo.
4. Railway: New Project > Deploy from GitHub repo > pick the repo.
5. In the project: New > Database > Add PostgreSQL.
6. Open the app service > Variables and add:
   BOT_TOKEN, ADMIN_ID, TELEBIRR_NAME, BOTS=100
   TELEBIRR_NUMBER=0982372677 (already the default in the code)
   DATABASE_URL = ${{Postgres.DATABASE_URL}}   (use the variable reference)
7. Settings > Networking > Generate Domain (HTTPS).
8. @BotFather > /mybots > your bot > Bot Settings > Menu Button > set the URL to your Railway domain.
   (Or /newapp to create a Mini App with that URL.)
9. Keep replicas at 1.

## Admin
Deposits and withdrawals arrive in your bot chat with buttons. Approve / Reject / Mark paid.

## Promo codes (admin, in your bot chat)
/newpromo WELCOME20 20 100 7   -> code, birr bonus, max uses, optional days until expiry
/promos                         -> list codes and usage
/stoppromo WELCOME20            -> stop a code
Each player can use a code once. Players need 1 approved deposit first (set PROMO_REQUIRE_DEPOSIT=false to turn this off).
