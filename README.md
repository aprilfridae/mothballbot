# mothballbot

A Discord bot that runs the shop. Everything happens in Discord:

| Channel | What happens there |
|---|---|
| `#new-listing` | Post photos with `Nike hoodie size L $35`. The bot drafts the listing with AI, and you tap **Post to eBay**. |
| `#buyers` (Forum) | Each buyer gets a thread named `buyer: sam_92 · eBay`. Type in the thread to reply to them. ✅ means it was delivered, ❌ means it failed and the bot says why. |
| `#sales` | A line for every sale. |
| `#to-ship` | The item, address and ship-by date for each sale. React 📦 when it's shipped. |
| `#bot-status` | Warnings when something needs you, like an expired eBay login. |

Mom gets each sale on **Telegram** with a **📦 Shipped** button. To add tracking, she replies to the sale message with the tracking number. The bot uploads it to eBay.

Part 1 covers **eBay**. Etsy and Facebook Marketplace come in later parts. The design is in `docs/superpowers/specs/`.

---

## Setup (one time, about 45 minutes)

You'll fill in `.env` as you go:

```bash
git clone https://github.com/aprilfridae/mothballbot.git
cd mothballbot
cp .env.example .env
```

### 1. Discord bot

1. Go to <https://discord.com/developers/applications>, click **New Application**, and open **Bot**.
   - Click **Reset Token** and put the token in `DISCORD_TOKEN`.
   - Turn on **Message Content Intent**.
2. Open **OAuth2 → URL Generator**.
   - Scopes: `bot`.
   - Permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Embed Links, Attach Files, Add Reactions.
   - Open the generated URL and add the bot to your server.
3. Create the channels `#new-listing`, `#sales`, `#to-ship` and `#bot-status`. Create **`#buyers` as a Forum channel**.
4. In Discord, go to **Settings → Advanced** and turn on Developer Mode.
   - Right-click each channel, choose **Copy Channel ID**, and fill in the `CHANNEL_*` values.
   - Right-click yourself and copy **your** user ID into `OWNER_DISCORD_ID`. The bot only listens to you.

### 2. eBay keys

1. Go to <https://developer.ebay.com>, sign in, and open **Application Keys**. Create a **Production** keyset.
   - App ID goes in `EBAY_CLIENT_ID`. Cert ID goes in `EBAY_CLIENT_SECRET`.
   - If eBay asks about "marketplace account deletion notifications", choose the exemption (this app stores no eBay user data for other people).
2. Open **User Tokens → Get a Token from eBay via Your Application**. Add an **eBay Redirect URL** (any name; the accept URL can be `https://example.com`). Copy its **RuName**.
3. Open this URL in your browser, filling in your App ID and RuName. Sign in with the **seller** account and click Agree.

   ```
   https://auth.ebay.com/oauth2/authorize?client_id=YOUR_APP_ID&redirect_uri=YOUR_RUNAME&response_type=code&scope=https://api.ebay.com/oauth/api_scope%20https://api.ebay.com/oauth/api_scope/sell.inventory%20https://api.ebay.com/oauth/api_scope/sell.account%20https://api.ebay.com/oauth/api_scope/sell.fulfillment%20https://api.ebay.com/oauth/api_scope/commerce.message
   ```

4. You'll land on a page whose address contains `code=...`. Copy that code (URL-decoded) and run:

   ```bash
   curl -s -X POST https://api.ebay.com/identity/v1/oauth2/token \
     -u 'YOUR_APP_ID:YOUR_CERT_ID' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     --data-urlencode grant_type=authorization_code \
     --data-urlencode 'code=PASTE_CODE' \
     --data-urlencode 'redirect_uri=YOUR_RUNAME'
   ```

   Put `refresh_token` from the response in `EBAY_REFRESH_TOKEN`. It lasts about 18 months. When it expires, `#bot-status` will tell you, and you repeat steps 3–4.
5. Put your eBay seller username in `EBAY_USERNAME`.
6. In eBay **Seller Hub → Account → Business policies**, make sure you have a shipping, payment and return policy.
7. Pick a name for your ship-from location (e.g. `home`) and put it in `EBAY_MERCHANT_LOCATION_KEY`.

You'll get the policy IDs in step 5 below.

### 3. Mom's Telegram bot

1. In Telegram, message **@BotFather** and send `/newbot`. Put the token in `TELEGRAM_TOKEN`.
   - **If the token was ever pasted somewhere public or into a chat, send `/revoke` to BotFather and use the new one.**
2. Put a random code in `MOM_LINK_CODE`, e.g. from `openssl rand -hex 8`.
3. Once the bot is running, send Mom `https://t.me/YOUR_BOT_USERNAME?start=YOUR_MOM_LINK_CODE`. She taps it, then taps **Start**, and she's connected. Only the first chat that uses the code is accepted.

### 4. AI key

Create an API key at <https://console.anthropic.com> and put it in `ANTHROPIC_API_KEY`. Drafts cost a cent or two each.

### 5. Start it

1. Set `POSTGRES_PASSWORD` to a long random string of letters and numbers only (e.g. `openssl rand -hex 16`).
2. Print your eBay policy IDs and create the ship-from location (use your ZIP, city and state):

   ```bash
   docker compose run --rm app node dist/tools/ebaySetup.js 95112 "San Jose" CA
   ```

   Copy the three policy IDs into `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_PAYMENT_POLICY_ID` and `EBAY_RETURN_POLICY_ID`.
3. Start everything:

   ```bash
   docker compose up -d --build
   docker compose logs -f app     # should say "Discord connected as …"
   ```

### Test it end to end

1. Post one photo plus `test item $5` in `#new-listing`. The preview should appear.
2. Tap **Post to eBay**. The link should open your live listing. End it on eBay afterwards.
3. From a second eBay account, message about the item. Within about 2 minutes, a `buyer: …` thread should appear. Reply there, and the bot should react ✅.

## Updating

```bash
git pull && docker compose up -d --build
```

## Troubleshooting

- **Nothing happens when I post in #new-listing.** Check that Message Content Intent is on and that `OWNER_DISCORD_ID` is your ID.
- **"eBay needs these item specifics: …"** Tap **Edit** and add lines like `Color: Black` under Item specifics.
- **`#bot-status` says the eBay login failed.** The refresh token expired or was revoked. Redo eBay steps 3–4, update `.env`, and run `docker compose up -d`.
- **Mom didn't get a sale.** She hasn't tapped the start link yet. Once she does, unshipped sales from the last poll window are sent to her.
- **Logs:** `docker compose logs -f app`

## Development

```bash
pnpm install
pnpm test        # needs Postgres; set TEST_DATABASE_URL (default postgres://bot:bot@localhost:5432/bot_test)
pnpm build
```
