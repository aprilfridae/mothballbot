# Selling Bot Part 1 (Foundation + eBay + Mom's Telegram) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Discord bot on the homelab with four jobs:
- Turn photos plus `title $price` into an AI-drafted eBay listing.
- Mirror eBay buyer conversations into Discord threads, so replies can go both ways.
- Post eBay sales to `#to-ship`.
- Alert Mom on Telegram, where a 📦 Shipped button marks each order shipped.

**Architecture:**
- One TypeScript Node process (`app`) runs the Discord bot (discord.js), Mom's Telegram bot (grammY, long polling) and scheduled jobs (pg-boss), all backed by Postgres.
- Platform code sits behind a `PlatformConnector` interface, so Etsy and Facebook plug in later.
- All HTTP calls take an injected `fetch`, so tests run without the network.
- *Plan call:* the design's separate `worker` container only appears in Part 2, when Playwright arrives. Part 1 has no browser work, so one process is simpler.

**Tech Stack:**
- Node 22, TypeScript (strict, ESM), pnpm, vitest
- Postgres 16, `pg`, pg-boss, zod
- discord.js v14, grammY
- `@anthropic-ai/sdk` (model `claude-haiku-5-5`)
- Docker Compose

**Spec:** `docs/superpowers/specs/2026-11-13-selling-bot-design.md`

## Global Constraints

- **Ownership:** only the Discord user `OWNER_DISCORD_ID` can trigger actions, and the bot ignores everyone else. Only Mom's linked Telegram chat is accepted.
- **Buyer thread name:** `buyer: {username} · eBay`, truncated to Discord's 100-character limit by shortening the username, never the suffix.
- **Channels:** `#new-listing`, `#buyers` (forum), `#sales`, `#to-ship`, `#bot-status`, with IDs supplied in `.env`.
- **Polling:** eBay messages and orders are polled every 2 minutes. There are no inbound ports, webhooks or tunnels.
- **Reply results:** every reply sent from Discord gets ✅ (delivered) or ❌ plus a one-line reason.
- **Failures:** every scheduled-job failure posts to `#bot-status`, and the bot never fails silently.
- **Secrets:** secrets live only in `.env`, which is gitignored. `.env.example` lists every key with no values.
- **Photos:** stored under `/data/photos/{itemId}/` on a Docker volume.

## Review Focus

1. Intake text that's sloppy: `hoodie 35`, `$35.50`, `$1,200`, or no price at all. The bot should parse what it reasonably can and otherwise reply with a short usage hint, never crash.
2. The same eBay message or order seen on two polls. It must never post twice to Discord or Telegram (dedupe on the platform ID).
3. iPhone photos (HEIC) and non-image attachments. Images are uploaded, and anything that isn't an image is skipped with a note in the preview.
4. Mom taps Shipped twice, or after you already reacted 📦. This is idempotent: one fulfillment call and one "✅ Shipped" state.
5. eBay rejects a send or a publish (expired token, a missing item aspect, a deleted conversation). Show ❌ or the embed error with eBay's message, keep the draft editable, and report to `#bot-status` for auth failures.

Each item's test is pinned in the task that owns the code (marked **RF1–RF5**).

---

## File Structure

```
src/
  config.ts                 env → Config (zod)
  db/schema.sql             tables
  db/db.ts                  pool + migrate()
  db/repo.ts                typed queries (items, listings, conversations, messages, orders, settings)
  intake/parseIntake.ts     "title $price" → {title, priceCents}
  ai/draftListing.ts        photos + title → ListingDraft (Claude)
  platforms/types.ts        PlatformConnector + shared types
  platforms/ebay/auth.ts    refresh-token → access token (cached)
  platforms/ebay/client.ts  ebayFetch wrapper (auth header, errors → EbayError)
  platforms/ebay/listings.ts  uploadImage, suggestCategory, createListing
  platforms/ebay/messages.ts  fetchNewMessages, sendReply
  platforms/ebay/orders.ts    fetchNewOrders, uploadTracking
  shipping/detectCarrier.ts tracking number → carrier code
  discord/bot.ts            client, routing by channel
  discord/newListing.ts     intake → draft → preview embed/buttons/edit modal → post
  discord/buyerThreads.ts   threadName(), mirror messages, owner replies
  discord/toShip.ts         sale posts, 📦 reaction
  discord/status.ts         reportStatus()
  telegram/momBot.ts        link via deep-link code, sale alerts, Shipped button, tracking replies
  orders/markShipped.ts     single idempotent shipping path used by Discord + Telegram
  jobs/schedule.ts          pg-boss: poll-ebay-messages, poll-ebay-orders
  main.ts                   wires everything
tests/                      mirrors src/
Dockerfile, docker-compose.yml, .env.example, README.md
```

---

### Task 1: Scaffold, config and database

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml` (postgres only for now), `src/config.ts`, `src/db/schema.sql`, `src/db/db.ts`, `src/db/repo.ts`
- Test: `tests/config.test.ts`, `tests/db/repo.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string,string|undefined>): Config`, which throws listing every missing key.
  - `Config` fields: `databaseUrl`, `discordToken`, `ownerDiscordId`, `channels:{newListing,buyers,sales,toShip,botStatus}`, `ebay:{clientId,clientSecret,refreshToken,fulfillmentPolicyId,paymentPolicyId,returnPolicyId,merchantLocationKey}`, `anthropicApiKey`, `telegramToken`, `momLinkCode`, `photoDir`.
  - `createDb(url): Db` and `migrate(db): Promise<void>`, which is idempotent.
  - Repo functions: `insertItem`, `getItem`, `updateItemDraft`, `upsertListing(itemId, platform, {externalId,url,status,error})`, `upsertConversation(platform, externalId, buyerUsername) → {id, discordThreadId|null}`, `setConversationThread`, `insertMessageIfNew(conversationId, externalId, fromBuyer, body, sentAt) → boolean`, `insertOrderIfNew(platform, externalId, data) → Order|null`, `getOrder`, `setOrderTelegramMessage`, `setOrderDiscordMessage`, `findOrderByTelegramMessage`, `markOrderShippedRow(orderId, by, tracking|null) → boolean` (false if already shipped), `getSetting`/`setSetting`.
- Schema:
  - `items` (id, title, price_cents, photos jsonb, draft jsonb, discord_message_id, created_at)
  - `listings` (item_id, platform, external_id, url, status, error; unique (item_id, platform))
  - `conversations` (id, platform, external_id, buyer_username, discord_thread_id; unique (platform, external_id))
  - `messages` (conversation_id, external_id unique, from_buyer, body, sent_at)
  - `orders` (id serial, platform, external_id, item_title, buyer, ship_to jsonb|null, local_pickup bool, ship_by, discord_message_id, telegram_message_id, shipped_at, shipped_by, tracking; unique (platform, external_id))
  - `settings` (key primary, value)

- [ ] **Step 1:** Init with pnpm. Add the deps from the Tech Stack, plus `"type":"module"` and the scripts `test`, `build`, `start`. Put Postgres 16 in the compose file with a `pgdata` volume and port 5432 bound to localhost.
- [ ] **Step 2: Write failing tests.**
  - `loadConfig({})` throws an error whose message contains `DISCORD_TOKEN` and `EBAY_REFRESH_TOKEN`.
  - Against `TEST_DATABASE_URL`: `migrate` runs twice without error.
  - `insertMessageIfNew` returns `true` then `false` for the same `externalId` **(RF2)**.
  - `insertOrderIfNew` returns an Order and then `null` on a repeat **(RF2)**.
  - `markOrderShippedRow` returns `true` then `false` **(RF4)**.
- [ ] **Step 3:** Run `docker compose up -d postgres && pnpm test`. Expect FAIL (modules missing).
- [ ] **Step 4:** Implement the config, the schema, `migrate` (run `schema.sql` with `CREATE TABLE IF NOT EXISTS`) and the repo functions. Use the unique constraints together with `ON CONFLICT DO NOTHING RETURNING` for the `IfNew` functions.
- [ ] **Step 5:** Run `pnpm test`. Expect PASS.
- [ ] **Step 6:** Commit with `chore: scaffold, config, db schema`.

### Task 2: Intake parsing and AI listing draft

**Files:**
- Create: `src/intake/parseIntake.ts`, `src/ai/draftListing.ts`
- Test: `tests/intake/parseIntake.test.ts`, `tests/ai/draftListing.test.ts`

**Interfaces:**
- Produces:
  - `parseIntake(text: string): {ok:true,title:string,priceCents:number} | {ok:false,hint:string}`
  - `ListingDraft = {title:string(≤80), description:string, condition:'NEW'|'NEW_OTHER'|'USED_EXCELLENT'|'USED_GOOD'|'USED_ACCEPTABLE', brand:string|null, aspects:Record<string,string[]>, categoryQuery:string}`
  - `draftListing(input:{title:string,priceCents:number,photos:{mime:string,data:Buffer}[]}, client: AnthropicLike): Promise<ListingDraft>`
- eBay titles cap at 80 characters, so `draft.title` is truncated at a word boundary.

- [ ] **Step 1: Write failing tests.**
  - `parseIntake('Nike hoodie size L $35')` returns `{title:'Nike hoodie size L', priceCents:3500}`.
  - `'$35.50 vintage lamp'` returns 3550, with the price allowed anywhere in the text.
  - `'$1,200 couch'` returns 120000.
  - `'hoodie 35'` returns 3500, with a trailing bare number taken as the price.
  - `'hoodie'` returns `ok:false`, with a hint containing `Nike hoodie size L $35` **(RF1)**.
  - `draftListing` with a fake client returning a JSON string yields the parsed draft. A 120-character title comes back ≤80. Malformed JSON from the model throws `DraftError` **(RF5)**.
- [ ] **Step 2:** Run `pnpm test tests/intake tests/ai`. Expect FAIL.
- [ ] **Step 3:** Implement both. `draftListing` sends the images as base64 image blocks with a system prompt asking for JSON matching `ListingDraft`, validates the response with zod, and uses model `claude-haiku-5-5`.
- [ ] **Step 4:** Run the same tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: intake parsing and AI listing draft`.

### Task 3: eBay auth and listing creation

**Files:**
- Create: `src/platforms/types.ts`, `src/platforms/ebay/auth.ts`, `src/platforms/ebay/client.ts`, `src/platforms/ebay/listings.ts`
- Test: `tests/platforms/ebay/listings.test.ts`

**Interfaces:**
- Produces:
  - `EbayError {status:number, message:string, isAuth:boolean}`
  - `createEbay(cfg: Config['ebay'], fetchFn = fetch): EbayClient`
  - `EbayClient.request(method, url, body?) → json`. It refreshes the token through `POST https://api.ebay.com/identity/v1/oauth2/token` (`grant_type=refresh_token`), caches it until 60s before expiry, and maps 401 responses or `invalid_grant` errors to `isAuth:true`.
  - `uploadImage(ebay, file:{mime,data}) → imageUrl`, via Media API `create_image_from_file`.
  - `suggestCategory(ebay, query) → {categoryId, requiredAspects:string[]}`, via Taxonomy `get_category_suggestions` and `get_item_aspects_for_category` on tree `0`.
  - `createListing(ebay, cfg, item:{sku, priceCents, draft, imageUrls}) → {listingId, url}`. It runs PUT `inventory_item/{sku}`, then POST `offer` (with the policy IDs and `merchantLocationKey` from config, format `FIXED_PRICE`, marketplace `EBAY_US`), then POST `offer/{id}/publish`. The URL is `https://www.ebay.com/itm/{listingId}`.
- `PlatformConnector` (types.ts): `{platform:'ebay'|'etsy'|'facebook', createListing?, fetchNewMessages, sendReply, fetchNewOrders, uploadTracking?}`
- *Verify while implementing:* check the exact OAuth scope strings and the Media API host against current eBay docs. Write them as constants in `auth.ts`.

- [ ] **Step 1: Write failing tests** using a recording fake `fetch`.
  - `createListing` makes calls in order: token, PUT inventory_item, POST offer, POST publish. The offer body contains the three policy IDs, and the price is `"35.00"` for 3500 cents.
  - A second `createListing` within the token lifetime makes no token call.
  - A publish response of 400 with `errors[0].message: 'Item specific Brand is missing'` throws `EbayError` with that message, `isAuth:false` **(RF5)**.
  - A token response of `invalid_grant` throws `isAuth:true` **(RF5)**.
  - `suggestCategory` returns the first suggestion's ID and the names of aspects whose `aspectConstraint.aspectRequired` is true.
- [ ] **Step 2:** Run `pnpm test tests/platforms/ebay/listings.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. SKU = `item-{itemId}`.
- [ ] **Step 4:** Run the same tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: eBay auth and listing creation`.

### Task 4: Discord listing flow

**Files:**
- Create: `src/discord/status.ts`, `src/discord/newListing.ts`, `src/discord/bot.ts`
- Test: `tests/discord/newListing.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `reportStatus(client, cfg, text)`
  - `buildPreview(item, draft, listings, skipped: string[]) → {embeds, components}`. The buttons have custom IDs `post:ebay:{itemId}`, `edit:{itemId}`, `cancel:{itemId}`. The Etsy and FB buttons are rendered disabled with the label "soon".
  - `handleIntakeMessage(msg, deps)`
  - `handleButton(interaction, deps)`
  - `handleEditModal(interaction, deps)`, with modal fields title, price, condition and description.
  - `deps = {db, cfg, ebay, anthropic, savePhoto}`
  - `bot.ts`: `startDiscord(cfg, deps): Client`. It routes `messageCreate` in `newListing` to intake and thread messages in `buyers` to Task 6, and ignores authors ≠ owner.

- [ ] **Step 1: Write failing tests** with fake deps.
  - An owner message with 2 JPEGs, 1 HEIC and 1 PDF plus `Nike hoodie size L $35` saves 3 photos, drafts once, and replies with a preview whose footer lists `skipped: manual.pdf` **(RF3)**.
  - A non-owner message does nothing.
  - A message with no image replies with a hint ("attach at least one photo").
  - Text with no price replies with the `parseIntake` hint **(RF1)**.
  - `post:ebay` calls `createListing`, and the embed shows the listing URL.
  - When `createListing` throws `EbayError('Item specific Brand is missing')`, the embed shows that error, the Post and Edit buttons stay enabled **(RF5)**, and `reportStatus` is called only when `isAuth` is true.
  - Edit-modal submit updates the draft and re-renders.
  - The test calls `buildPreview` directly to check the embed fields: title, price `$35.00`, condition, description truncated to 1024 characters.
- [ ] **Step 2:** Run `pnpm test tests/discord/newListing.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Images are accepted by `contentType` starting with `image/`, and HEIC is passed through because eBay accepts it. Photos are capped at 24, which is eBay's maximum, and any extras are listed in skipped.
- [ ] **Step 4:** Run the same tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: Discord listing flow to eBay`.

### Task 5: eBay buyer messages into Discord threads

**Files:**
- Create: `src/platforms/ebay/messages.ts`, `src/discord/buyerThreads.ts` (mirroring part)
- Test: `tests/platforms/ebay/messages.test.ts`, `tests/discord/buyerThreads.test.ts`

**Interfaces:**
- Produces:
  - `PlatformMessage = {conversationExternalId, messageExternalId, buyerUsername, body, sentAt:Date, item:{title,url}|null}`
  - `fetchNewMessages(ebay, since: Date) → PlatformMessage[]`. It calls `GET /commerce/message/v1/conversation?conversation_type=FROM_MEMBERS`, then `GET .../conversation/{id}` for conversations updated after `since`, and keeps only messages from the other party.
  - `threadName(username, platformLabel) → string`
  - `mirrorMessages(discord, db, cfg, msgs)`. It upserts each conversation, skips messages that `insertMessageIfNew` returns false for, creates the forum thread on first sight, and posts `**{item.title}** · {item.url}\n> {body}`.
  - The poll cursor is the `settings` key `ebay.messages.since`.

- [ ] **Step 1: Write failing tests.**
  - `threadName('sam_92','eBay')` returns `'buyer: sam_92 · eBay'`.
  - A 150-character username yields a name of length ≤100 that still ends with ` · eBay`.
  - Running `mirrorMessages` twice with the same 2 messages creates 1 thread and 2 posts total **(RF2)**.
  - A second buyer gets a second thread.
  - `fetchNewMessages` with fake fetch drops messages whose sender is the seller.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: mirror eBay buyer messages into Discord threads`.

### Task 6: Owner replies from Discord back to eBay

**Files:**
- Modify: `src/platforms/ebay/messages.ts` (add `sendReply`), `src/discord/buyerThreads.ts` (add `handleThreadReply`)
- Test: extend both test files

**Interfaces:**
- Produces:
  - `sendReply(ebay, conversationExternalId, text) → void`, via `POST /commerce/message/v1/send_message` with `conversationId` and `messageText`.
  - `handleThreadReply(msg, deps)`. It finds the conversation by `discordThreadId`, sends the reply, then reacts ✅. On failure it reacts ❌ and replies `Couldn't send: {reason}`.

- [ ] **Step 1: Write failing tests.**
  - An owner message in a mapped thread calls `sendReply` with the conversation's external ID and reacts ✅.
  - When `sendReply` throws `EbayError('Conversation not found')`, the bot reacts ❌ and replies `Couldn't send: Conversation not found` **(RF5)**.
  - A message in an unmapped thread is ignored.
  - A non-owner message is ignored.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement. Record the sent message in `messages` with `from_buyer=false`, using the returned message ID or `local-{discordMessageId}`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: reply to eBay buyers from Discord`.

### Task 7: Sales → #to-ship and Mom's Telegram, with the Shipped flow

**Files:**
- Create: `src/platforms/ebay/orders.ts`, `src/shipping/detectCarrier.ts`, `src/orders/markShipped.ts`, `src/discord/toShip.ts`, `src/telegram/momBot.ts`
- Test: `tests/platforms/ebay/orders.test.ts`, `tests/shipping/detectCarrier.test.ts`, `tests/orders/markShipped.test.ts`, `tests/telegram/momBot.test.ts`

**Interfaces:**
- Produces:
  - `PlatformOrder = {externalId, itemTitle, buyer, shipTo:{name,line1,line2?,city,state,postalCode}|null, localPickup:boolean, shipBy:Date|null}`
  - `fetchNewOrders(ebay, since) → PlatformOrder[]`, via `GET /sell/fulfillment/v1/order?filter=creationdate:[{iso}..]`. The address comes from `fulfillmentStartInstructions[0].shippingStep.shipTo`.
  - `uploadTracking(ebay, orderExternalId, lineItemIds, tracking, carrier)`, via `POST .../order/{id}/shipping_fulfillment`.
  - `detectCarrier(tracking) → 'USPS'|'UPS'|'FedEx'|null`. The rules: UPS is `1Z` + 16 alphanumerics. USPS is 20–22 digits starting with `9`, or 13 characters like `EA123456789US`. FedEx is 12 or 15 digits.
  - `markShipped(orderId, by:'mom'|'owner', tracking|null, deps) → 'shipped'|'already'`. This is the only shipping path. It calls `markOrderShippedRow`. If that returns false, it returns `'already'` and does nothing else **(RF4)**. Otherwise it uploads tracking to eBay when there is tracking and a detected carrier, edits the `#to-ship` post to `📦 Shipped (by Mom)` or `(by you)`, and edits Mom's Telegram message to `✅ Shipped`.
  - `startMomBot(cfg, deps)`:
    - `/start {code}`: if the code matches `momLinkCode`, it stores `telegram.momChatId` in settings and replies `You're connected 👋`. Any other chat or code is ignored.
    - `notifyMom(order) → telegramMessageId` sends the item, buyer, address (or `Local pickup`) and ship-by date, plus an inline button `📦 Shipped` with callback data `ship:{orderId}`.
    - Callback: calls `markShipped(..,'mom',null)` and answers `Marked shipped` or `Already marked shipped`.
    - A reply to a sale message whose text matches a carrier calls `markShipped(..,'mom',tracking)`. When no carrier is detected, it replies `That doesn't look like a tracking number`.
  - `postToShip(order) → discordMessageId`. It also posts `Sold on eBay: {itemTitle}` to `#sales` (cross-platform delisting comes in Part 5). Reacting 📦 in `#to-ship` (owner only) calls `markShipped(..,'owner',null)`.

- [ ] **Step 1: Write failing tests.**
  - `detectCarrier` returns `'UPS'` for `1Z999AA10123456784`, `'USPS'` for `9400111899223197428490`, and null for `hello`.
  - `fetchNewOrders` maps a sample eBay order JSON, including its address. An order without `shippingStep` gives `localPickup:true, shipTo:null`.
  - `markShipped` called twice yields `'shipped'` then `'already'`, with `uploadTracking` called at most once and the Telegram edit called once **(RF4)**.
  - With tracking `1Z999AA10123456784`, `uploadTracking` gets carrier `'UPS'`.
  - With tracking and no detected carrier, `markShipped` succeeds without calling eBay.
  - The `/start` handler links with the correct code and ignores a wrong code.
  - Callback data from a chat other than Mom's is ignored.
  - Running the order poll twice with the same order sends one Telegram message and one Discord post **(RF2)**.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: sales to #to-ship and Mom's Telegram with Shipped button`.

### Task 8: Scheduling, health reporting, Docker and setup guide

**Files:**
- Create: `src/jobs/schedule.ts`, `src/main.ts`, `Dockerfile`, `README.md`
- Modify: `docker-compose.yml` (add the `app` service and the `photos` volume), `.env.example`
- Test: `tests/jobs/schedule.test.ts`

**Interfaces:**
- Produces:
  - `registerJobs(boss, deps)` schedules `poll-ebay-messages` and `poll-ebay-orders` every 2 minutes (cron `*/2 * * * *`). Each job advances its `settings` cursor only after a successful mirror.
  - On error, a job calls `reportStatus`. Auth errors are rate-limited to one post per hour per job (`settings` key `status.last.{job}`).

- [ ] **Step 1: Write failing tests.**
  - When a job's fetch throws `EbayError(isAuth:true)`, the job reports once, and a second failure within the hour does not report again.
  - The cursor stays unchanged after a failure.
  - The cursor advances to the max `sentAt` after a success.
- [ ] **Step 2:** Run `pnpm test tests/jobs`. Expect FAIL.
- [ ] **Step 3:** Implement `schedule.ts` and `main.ts`, which loads the config, migrates, then starts Discord, the Telegram bot and pg-boss.
  - Dockerfile: multi-stage on `node:22-slim`.
  - Compose: `app` depends on `postgres`, uses `env_file: .env`, mounts `photos:/data/photos`, and sets `restart: unless-stopped`.
- [ ] **Step 4:** Run `pnpm test`. Expect all PASS. Run `docker compose build`. Expect success.
- [ ] **Step 5:** Write the README setup guide, in order:
  1. Create the eBay developer keyset and get a production refresh token.
  2. Create the eBay business policies and an inventory location, and record their IDs.
  3. Create the Discord bot (Message Content intent on), invite it, and create the channels, with `#buyers` as a Forum.
  4. Create the Telegram bot with @BotFather (send `/revoke` first if the old token was shared), set `MOM_LINK_CODE`, and send Mom the `t.me/{bot}?start={code}` link.
  5. Get the Anthropic API key.
  6. `cp .env.example .env`, fill it in, and run `docker compose up -d`.
- [ ] **Step 6:** Manual smoke test on the homelab:
  - Post a test item in `#new-listing` and confirm the preview appears.
  - Post it to eBay and confirm the link opens.
  - From a second eBay account, message about it, confirm the thread appears within about 2 minutes, reply, and confirm ✅.
- [ ] **Step 7:** Commit with `feat: job scheduling, health reporting, Docker setup`.
