# Selling Bot: Design

**Date:** 2026-11-13 · **Status:** Draft, awaiting approval

## 1. Intent

You run the online selling. Your mom sources the items and ships them. You don't want to check eBay, Etsy and Facebook Marketplace every day, and you live in Discord anyway. So the whole operation runs through Discord: you create listings there, talk to buyers there, and get told when something sells.

## 2. Goals

1. **List from Discord.** You drop photos plus a short line (`Nike hoodie size L $35`) in `#new-listing`. The bot drafts the full listing with AI and shows a preview with buttons, and one tap posts it to eBay, Etsy and/or Facebook Marketplace.
2. **Two-way buyer messages in Discord.** Each buyer gets a thread named `buyer: {username} · {platform}`. Their messages show up there, and whatever you type in the thread is sent back to them on that platform.
3. **No double-selling.** When an item sells on one platform, the bot removes it from the others and tells you.
4. **Shipping hand-off.** Sales post to `#to-ship` with the item and the shipping address, so your mom knows what to pack.

## 3. Non-goals

- No web app or web inbox. Discord is the only interface.
- No platforms beyond eBay, Etsy and Facebook Marketplace for now. Poshmark, Mercari and others can be added later as more connectors.
- Not a product for other sellers. It serves one shop.

## 4. Anti-goals (failures even if it "works")

- **Silent breakage.** If a session expires, a CAPTCHA appears or a site layout changes, the bot must say so loudly in `#bot-status`. It must never quietly stop delivering messages.
- **Lost replies.** Every reply you send gets a ✅ (delivered) or ❌ (failed, with the reason). There's never an unknown state.
- **Careless automation.** Browser automation must behave like a person (see §6). Bursts, datacenter IPs and repeated fresh logins are out.

## 5. Approaches considered

| Decision | Options | Chosen | Why |
|---|---|---|---|
| Overall | Existing crosslister (Vendoo, List Perfectly) · custom build | **Custom** | You want everything in one place, with no extensions or third-party tools |
| Interface | Web app inbox · Discord | **Discord only** | You're always on Discord. Dropping the web app also shrinks the build a lot |
| Listing input | **A: photos + one line in a channel** · B: `/list` slash command with form | **A** | Fastest, especially on a phone. A form appears only when you tap Edit |
| Buyer conversations | Channel per buyer · thread per buyer in one forum channel | **Threads** | Discord caps a server at 500 channels. Threads auto-archive and reopen when the buyer writes again |
| Non-API platforms | Notify-and-link only · full browser automation | **Full automation** (your call, ToS risk accepted) | You want true two-way, all in Discord |

## 6. How it works

### Platforms

| Platform | Listings | Messages in | Replies out | Sale detection |
|---|---|---|---|---|
| **eBay** | Official Inventory API | Official Message API (polled) | Official Message API | Orders API (polled) |
| **Etsy** | Official API (needs Etsy app approval) | Email notification triggers a browser fetch of the thread | Browser | Receipts API (polled) |
| **Facebook** | Browser | Email notification triggers a browser fetch of the thread | Browser | Email notification, plus a manual `sold` button |

**Detecting new messages through email (my call).** The bot gets a dedicated Gmail inbox, which all three platforms send their notifications to, and reads it over IMAP every minute or two. A notification triggers a single browser visit to fetch the full conversation. That means the browser only opens Etsy and Facebook when something actually happened, which is far less exposure than watching the sites all day.

**Polling eBay instead of webhooks (my call).** eBay's push notifications would need your homelab exposed to the internet. Polling every 2 minutes needs no open ports and is plenty fast.

### Browser automation rules

- Playwright with a persistent, logged-in browser profile per platform, stored on a Docker volume. The bot never logs in from scratch automatically.
- Runs on the homelab's home IP only. No VPN or datacenter proxies.
- One action at a time per platform, with random human-like delays.
- If it hits a login wall, 2FA or a CAPTCHA, it stops that platform and posts in `#bot-status` with a screenshot. You fix it once through a remote browser view (noVNC), and it resumes.

### Listing flow

1. You post photos + `title $price` in `#new-listing`.
2. The AI looks at the photos and the title, then drafts a title, description, condition, category and Etsy's required fields.
3. The bot replies with a preview embed and buttons: **eBay**, **Etsy**, **FB**, **All**, **Edit**, **Cancel**.
4. **Edit** opens a Discord form for title, price, description and condition.
5. Each platform posts in turn, and the embed updates with live links or an error.

### Buyer message flow

1. A new message is detected, and the bot finds or creates the thread `buyer: {username} · {platform}` in the `#buyers` forum.
2. It posts the message along with the item name, the listing link and the price.
3. You type a reply in the thread, it gets queued and sent, and the bot reacts ✅ or ❌.

### Sale flow

1. A sale is detected on platform X.
2. The bot ends the listings on the other platforms and posts "Sold on X, removed from Y, Z" in `#sales`.
3. It posts the item, the buyer's shipping address and the ship-by date in `#to-ship`, and sends the same details to your mom on Telegram.

### Mom's Telegram bot

- A private Telegram bot sends your mom one message per sale: item, photo, buyer name, shipping address (or "local pickup"), and ship-by date.
- Each message has a **📦 Shipped** button. Tapping it marks that exact order shipped, so she never types order numbers.
- To add tracking, she replies to the sale message with the tracking number, either typed or pasted.
- The bot then:
  - marks the order shipped,
  - edits the `#to-ship` post to "📦 Shipped (by Mom)",
  - marks it shipped on eBay or Etsy, uploading the tracking number if she sent one (Facebook orders are only marked internally),
  - and edits her Telegram message to "✅ Shipped".
- Only her Telegram account is accepted. She taps **Start** on the bot once during setup, which links her account, and every other user is ignored.
- You can still mark something shipped yourself by reacting 📦 in Discord.
- **Free, with no internet exposure (my call):** the bot pulls updates from Telegram using long polling, so there's no webhook, no tunnel and no open ports.

### Discord layout

`#new-listing` · `#buyers` (forum) · `#sales` · `#to-ship` · `#bot-status`. A private server. Only your Discord account can trigger actions. Everyone else is ignored.

## 7. Tech stack (my calls)

- **Language:** TypeScript throughout.
- **Discord:** discord.js bot.
- **Worker:** Playwright plus connector modules (`ebay`, `etsy`, `facebook`, `email`), with jobs queued in Postgres (pg-boss) so nothing is lost on restart.
- **Database:** Postgres, holding items, listings (item × platform), conversations, messages, sales and jobs.
- **Photos:** stored on a Docker volume.
- **AI:** Claude API, using a cheap vision-capable model. Expect a few cents per listing. Your existing subscription can't be called from code.
- **Mom notifications:** Telegram Bot API (grammY), running inside the `bot` container. It's free.
- **Deploy:** Docker Compose on the homelab with `bot`, `worker` and `postgres` containers, plus noVNC for fixing logins. Secrets live in `.env`.

## 8. Build order

1. **Foundation + eBay.** The bot, database, listing flow to eBay, eBay messages both ways, and eBay sales into `#to-ship`, and your mom's Telegram alerts with the Shipped button.
2. **Message detection for Etsy and FB.** Gmail inbox, browser thread fetch, and threads in Discord.
3. **Replies for Etsy and FB** through the browser.
4. **Posting to Etsy** (API) **and FB** (browser).
5. **Auto-delist across all three**, plus `#bot-status` health checks.

## 9. Decisions from you

1. **Homelab:** Debian with Docker already installed, so Docker Compose works as planned.
2. **Facebook delivery:** listings offer both local pickup and shipping.
3. **Your mom:** gets sale alerts on Telegram and marks orders shipped with a button (see "Mom's Telegram bot" in §6). This replaced SMS through Twilio, which needed prepaid credit and carrier verification.

## 10. Left to the builder

The exact database schema, polling intervals within the ranges above, the embed styling, and the specific CSS selectors and flows for Etsy and Facebook (expect these to need maintenance when the sites change).

## One-time setup you'll do

Register an eBay developer account and create shipping/return/payment business policies. Request Etsy API app access and create an Etsy shipping profile. Create a Gmail account for notifications and point all three platforms at it. Create the Discord bot in the Developer Portal. Log into Etsy and FB once through noVNC. Create a Telegram bot with @BotFather (about two minutes, free), and have your mom install Telegram and tap Start on the bot.
