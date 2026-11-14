# Part 3: Facebook Marketplace Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mom can post an approved draft to Facebook Marketplace. FB buyer messages show up in `buyer: {name} · FB` threads, and your replies go back. A **💰 Sold on FB** button, or an FB shipping-order email, records the sale, ends the other listings and alerts Mom. A sale elsewhere marks the FB listing sold. All of this goes through the browser, because Facebook has no seller API for Marketplace.

**Architecture:**
- **Builds on Part 2** (`2026-11-13-part2-etsy.md`). It reuses the connector registry, per-listing posting and cross-delisting, the Gmail inbox and `MailEvent`, and the `worker` container (Chrome, noVNC, per-site serial queue, pause and Resume). Part 2 must be merged first.
- **Every Facebook action is a worker action under `worker/sites/facebook/`.** Facebook gets a stricter pacing layer than Etsy: daily and hourly caps, active hours, minimum gaps between listings, a warm-up period for a new account, and an auto-pause on any sign of a restriction.
- **New messages come in two ways:**
  - Facebook notification emails, which trigger a thread fetch.
  - A **backup inbox sweep about every 30 minutes, 8am–10pm**, with jitter. It catches messages whose email never arrived.
- **Posting is queued, not immediate.** When Mom taps FB, the listing is queued, and the worker posts it inside active hours, respecting the daily cap and the minimum gap.
- **Task order follows spec §8 (steps 2–5):** pacing and the session guard first, then messages in, replies out, posting, and finally sales and delisting. The account's first automated actions are reading and replying, the lighter ones, before any automated posting.
- **Sales:** most FB sales are local pickup with no checkout, so the owner or Mom taps **💰 Sold on FB**. FB shipping orders, when Facebook emails them, are read from the order page.

**Tech Stack:** unchanged from Part 2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-selling-bot-design.md` §6 (Facebook row: browser listings, email-triggered fetch, browser replies, email plus a manual `sold` button; Browser automation rules), §9.2 (listings offer local pickup and shipping).

## Decisions from you (2026-11-13)

- **Full automation,** including posting listings through the browser, as in the spec.
- **A separate Facebook account** sells for the shop, not yours or Mom's.
- **Backup inbox check** about every 30 minutes, 8am–10pm.
- **Etsy (Part 2) goes first,** so this plan reuses its email and browser groundwork.

## Account-ban risk, and how this plan limits it

**What can happen.**
- Facebook can put a **Marketplace restriction** on the selling account ("You can't buy or sell on Marketplace"). These often stick, and appeals rarely work.
- In the worst case, it **disables the whole account.**
- Because it's a separate account, your and Mom's personal accounts and Messenger aren't at stake. The shop's FB listings and buyer threads would stop, and eBay and Etsy keep running.

**Why the separate account carries its own risk.**
- Facebook's rules allow one personal account per person.
- New accounts with no history are the most likely to be checked, and some never get Marketplace access at all.
- Full automation adds posting, which is the most watched flow.

**What the plan does about it.**
- **Warm-up before automation.** Use the account by hand on your phone for **2–4 weeks** before turning this on:
  - Add a profile photo, a city and a few friends.
  - Browse Marketplace and post one or two listings yourself.
  - Turn on two-factor sign-in with your phone.
  - Only fill in the `.env` block once Marketplace works normally for it.
- **Caps that start low.**
  - For the first 30 days after `FB_START_DATE`, the bot posts at most **2 listings per day**, after that `FB_LISTINGS_PER_DAY` (default 4).
  - Listings are at least **45–90 minutes apart** (random).
  - Replies are capped at **15 per hour**.
  - Inbox sweeps run at most every 25–40 minutes, and only during active hours.
- **Active hours.** Posting and sweeps run **8am–10pm** Pacific with jitter. Your replies are sent whenever you type them, because people do reply at night, but they still respect the hourly cap.
- **Looks like one person on one computer.**
  - One saved Chrome profile on your home IP, with a visible window (not headless).
  - Real typing speed and pauses between steps, one action at a time.
  - The bot **never** fills in a password, so the session only changes when you sign in through noVNC.
- **Stops at the first warning.**
  - A sign-in wall, checkpoint, "confirm it's you", CAPTCHA, an unknown page, or any restriction or "automated behavior" text pauses Facebook straight away and posts the screenshot.
  - A **restriction** pause also says: *"Leave the bot paused for at least 48 hours and check the account on your phone before tapping Resume."* For 48 hours, its Resume button asks for a second confirmation.
- **⏸ Pause FB at any time,** with a button in `#bot-status`. While it's paused, FB posts wait in the queue and replies get ❌ with the reason.
- **Upkeep is expected.** Facebook changes its pages often. A changed page shows up as an "unknown page" pause with a screenshot, and the fix goes in one file (`worker/sites/facebook/selectors.ts`).

## Keys and accounts you need to get

Facebook has no API keys. You need these:

| What | Where | Goes in |
|---|---|---|
| The **separate Facebook account**, warmed up (see above), with Marketplace access | Facebook app on your phone | — |
| **Two-factor sign-in** on that account | Facebook → Settings → Accounts Center → Password and security | — |
| **Shipping set up** in Marketplace, only if you'll ship FB orders | Marketplace → Your account → Shipping and payouts (payout details are entered by you, by hand) | `FB_DELIVERY` |
| **Notification emails** to the bot's Gmail (from Part 2) | Facebook → Settings → Accounts Center → Personal details → add the Gmail address and make it primary. Then Notifications → Email, and turn on Marketplace and messages. | — |
| The account's **display name** exactly as shown on Facebook | Its profile | `FB_ACCOUNT_NAME` |
| Your **listing location** as you'd type it into Facebook's location box (city or ZIP) | — | `FB_LOCATION` |
| The day you finished the warm-up and turned this on | — | `FB_START_DATE` |
| The account **signed in once** in the worker's browser | `http://192.168.1.8:6080` → facebook.com → sign in, approve on your phone (Task 2) | (stored in the `browser-profiles` volume) |

## `.env` additions

The required block is **all-or-nothing**, like eBay and Etsy. Facebook also **needs** Part 2's notification inbox and browser worker blocks. If the FB block is filled but either of those is empty, startup stops with `Facebook needs the Gmail and browser blocks in .env: …`.

```bash
# ── Facebook Marketplace (fill all of these, or none) ──
# The selling account's name exactly as Facebook shows it, so its own messages aren't mirrored
FB_ACCOUNT_NAME=
# Listing location, typed the way you'd type it into Facebook (city or ZIP)
FB_LOCATION=
# pickup, shipping or both
FB_DELIVERY=both
# Date you turned on automation (YYYY-MM-DD). For 30 days after it, at most 2 listings a day are posted.
FB_START_DATE=

# ── Facebook pacing (optional; defaults shown) ──
FB_LISTINGS_PER_DAY=4
FB_REPLIES_PER_HOUR=15
```

## Global Constraints

- **Unchanged from earlier parts:** only `OWNER_DISCORD_ID` and Mom's chat. Never fail silently. Never post twice. Every reply gets ✅ or ❌.
- **Buyer thread name:** `buyer: {name} · FB` (`PLATFORM_LABEL.facebook`).
- **Pacing (enforced in the worker, counted in Postgres so restarts don't reset it):**
  - Listings: ≤2/day during the first 30 days after `FB_START_DATE`, then ≤`FB_LISTINGS_PER_DAY`. They're ≥45 minutes apart (45–90 minutes, random) and only 8:00–22:00 Pacific.
  - Replies: ≤`FB_REPLIES_PER_HOUR`, at any hour.
  - Inbox sweep: every 25–40 minutes, 8:00–22:00 only, and skipped when a thread fetch ran in the last 10 minutes.
  - Session check: once a day at a random time in active hours.
  - Between steps: 2–6 s pauses. Typing: 60–180 ms per character. After 20 minutes idle, the browser context closes.
- **Mark sold, never delete** when an item sells elsewhere, so buyer threads stay readable.
- **Photos uploaded to Facebook** are converted to JPEG with all metadata removed (no GPS), at most 10 per listing.
- **Posting is never retried automatically after a submit.** If Facebook doesn't confirm a listing, the bot reports it and waits for a person, so it can't create duplicates.

## Review Focus

1. **Posting can't be confirmed.** Submit was clicked, but the listing doesn't appear under "Your listings" within 2 minutes. The listing becomes `error` with "FB didn't confirm the listing. Check Your listings on Facebook before posting again." The bot doesn't post again by itself, and Mom's FB button stays available only after you confirm in Discord. → Task 6
2. **Restriction signals.** Any restriction, policy-rejection or "automated behavior" page pauses FB with reason `restricted` and the 48-hour Resume confirmation. A single listing rejected for a policy reason (as opposed to the account) becomes that listing's error with Facebook's text, and FB isn't paused. → Task 2, Task 6
3. **Caps across restarts and queues.** "All" for 5 items on a fresh account posts 2 today and 3 over the next days, at least 45 minutes apart and inside active hours, and the counts survive a restart. → Task 1, Task 6
4. **A manual Sold and an FB shipping-order email for the same item** create one order, not two. The email's address fills in the manual order. Sold tapped twice is one order. → Task 7
5. **The same buyer message seen by email, by the sweep and in the fetched thread** gives one Discord post. A buyer with no username uses the display name, and two buyers with the same name are kept apart by thread ID. → Task 3

---

## File Structure

```
src/config.ts                          + facebook block; requires gmail + worker blocks
src/db/schema.sql                      + browser_actions (site, kind, at); listings.status adds 'queued'
src/db/repo.ts                         + countActions, recordAction, nextQueuedListing, findOrderForItem
src/ai/draftListing.ts                 + draft.facebook {category, condition}
src/telegram/momListings.ts            + ✅ FB button, 💰 Sold on FB on live items
src/discord/newListing.ts              + "FB: queued (posts by ~3pm)", 💰 Sold on FB button
src/discord/status.ts                  + ⏸ Pause FB / ▶️ Resume FB, restriction confirmation
src/email/classify.ts                  + facebook message / facebook order kinds
src/platforms/facebook/connector.ts    NEW: PlatformConnector over the worker client
src/listings/pipeline.ts               platform 'facebook' → queue instead of immediate post
src/listings/fbQueue.ts                NEW: drains queued FB listings under pacing
src/orders/manualSale.ts               NEW: Sold-on-FB → order, delist others, Mom alert
src/worker/pacing.ts                   NEW: caps, active hours, gaps, warm-up (pure + DB counters)
src/worker/sites/facebook/selectors.ts NEW
src/worker/sites/facebook/guard.ts     NEW: FB-specific checkpoint/restriction detection
src/worker/sites/facebook/post.ts      NEW: create listing, confirm in Your listings
src/worker/sites/facebook/inbox.ts     NEW: sweep unread Marketplace threads
src/worker/sites/facebook/thread.ts    NEW: fetch one thread → PlatformMessage[]
src/worker/sites/facebook/reply.ts     NEW
src/worker/sites/facebook/listing.ts   NEW: markSold, readOrder
src/jobs/schedule.ts                   + fb-sweep (self-rescheduling), fb-post-queue, fb-session-check
tests/                                 mirrors src/; FB fixtures in tests/fixtures/facebook/
```

---

### Task 1: Config, pacing and the FB kill switch

**Files:**
- Create: `src/worker/pacing.ts`
- Modify: `src/config.ts`, `.env.example`, `src/db/schema.sql`, `src/db/repo.ts`, `src/worker/main.ts`, `src/discord/status.ts`, `src/discord/bot.ts`
- Test: `tests/config.test.ts`, `tests/worker/pacing.test.ts`, `tests/discord/status.test.ts`

**Interfaces:**
- **Produces, config:**
  - `Config.facebook: {accountName, location, delivery:'pickup'|'shipping'|'both', startDate: Date, listingsPerDay, repliesPerHour} | null`
  - A half-filled required block throws, listing the missing keys.
  - A filled FB block with `gmail` or `worker` null throws `Facebook needs the Gmail and browser blocks in .env: GMAIL_ADDRESS, …`.
  - `FB_DELIVERY` must be one of the three values. `FB_START_DATE` must be a valid `YYYY-MM-DD`.
- **Produces, pacing:**
  - `canAct(kind:'listing'|'reply'|'sweep', now, counts, cfg) → {ok:true} | {ok:false, retryAt: Date, why: string}`. It's a pure function.
  - `pickDelay(kind, rng) → ms` gives the random 45–90 minute gap for listings and 25–40 minutes for sweeps.
  - `inActiveHours(now) → boolean` checks 8:00–22:00 in `America/Los_Angeles`.
  - Counts come from `browser_actions (site, kind, at)` through `repo.countActions(site, kind, sinceDate)`. The worker calls `recordAction` after each successful post, reply or sweep.
- **Produces, kill switch:**
  - A `#bot-status` button **⏸ Pause FB** (owner only) writes a `browser_pauses` row with reason `manual`. **▶️ Resume FB** clears it.
  - A pause with reason `restricted` has a Resume that, within 48 hours of `since`, first answers `Facebook flagged this account at {time}. Resuming this soon risks a ban. Tap again to resume anyway.` A second tap within 1 minute resumes.

- [ ] **Step 1: Write failing tests.**
  - Config: the FB block without Gmail throws the "needs the Gmail and browser blocks" message. `FB_DELIVERY=boat` throws. A valid block parses, with defaults 4 and 15.
  - Pacing, with a fixed clock:
    - On day 10 after `startDate` with 2 listings today, `canAct('listing')` is false with `retryAt` the next day at or after 8:00 **(RF3)**.
    - On day 40 with 2 today, it's true unless the last listing was under 45 minutes ago.
    - At 23:00 a listing gets `retryAt` 8:00 the next day, and a reply is allowed.
    - Reply 16 within the hour is refused with `retryAt` the hour mark.
  - Counts read from the db survive a new pacing instance (a restart) **(RF3)**.
  - The restricted Resume needs two taps within 48 hours and one tap after. Manual pause and resume work, and a non-owner is ignored.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement. Add the FB blocks to `.env.example`, worded as above.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: Facebook config, pacing caps and pause switch`.

### Task 2: Facebook session, guard and fixtures

**Files:**
- Create: `src/worker/sites/facebook/selectors.ts`, `src/worker/sites/facebook/guard.ts`
- Modify: `src/worker/main.ts` (register site `facebook`), `src/jobs/schedule.ts` (`fb-session-check`), `src/main.ts` (startup check)
- Test: `tests/browser/facebook-guard.browser.test.ts`, with fixtures in `tests/fixtures/facebook/`

**Interfaces:**
- **Produces, guard:** `checkFacebook(page)` extends Part 2's `checkPage`.
  - `login`: the sign-in form, or a `/login` URL.
  - `checkpoint`: `/checkpoint/` URLs, "confirm it's you" or "secure your account".
  - `captcha`: an image or audio challenge.
  - `restricted`: Marketplace "You can't buy or sell", "your account is restricted", or "automated behavior" text, matched on stable text patterns kept in `selectors.ts`.
  - `unknown-page`: an expected element is missing after 15 s.
- **Produces, actions:** `facebook/check` makes a single visit to `facebook.com/marketplace/you/selling` and confirms the account name appears. `fb-session-check` runs it once a day at a random time in active hours, plus at startup.
- **Fixtures:** with `captureFixture` from Part 2, capture these, sanitised:
  - the selling page
  - the create-item form (empty)
  - a Marketplace inbox page
  - one thread with a listing card
  - the sign-in page
  - The checkpoint and restricted pages are written by hand from screenshots if no real one is available. Mark those files as such in a comment at the top.

- [ ] **Step 1:** Warm up the account and sign in once through noVNC (see the setup above), then capture the fixtures. Check each one by eye for personal details before committing.
- [ ] **Step 2: Write failing browser tests.**
  - Each fixture gives the right guard result: the selling page passes, sign-in gives `login`, checkpoint gives `checkpoint`, and restricted gives `restricted` **(RF2)**.
  - A blank page gives `unknown-page` after the timeout (use a short timeout in tests).
- [ ] **Step 3:** Run `pnpm test:browser`. Expect FAIL.
- [ ] **Step 4:** Implement. A `restricted` result reports with the 48-hour warning text from the risk section.
- [ ] **Step 5:** Run the tests. Expect PASS.
- [ ] **Step 6:** Commit with `feat: Facebook session check and checkpoint/restriction guard`.

### Task 3: FB buyer messages in (email plus backup sweep)

**Files:**
- Create: `src/worker/sites/facebook/inbox.ts`, `src/worker/sites/facebook/thread.ts`, `src/platforms/facebook/connector.ts` (messages only for now)
- Modify: `src/platforms/registry.ts`, `src/email/classify.ts`, `src/jobs/schedule.ts` (`fb-sweep`), `src/main.ts`
- Test: `tests/email/classify.test.ts` (FB fixtures), `tests/browser/facebook-thread.browser.test.ts`, `tests/email/flow.test.ts`

**Interfaces:**
- **Produces, classify:**
  - `{kind:'message', platform:'facebook', threadId|null, buyerName, preview, at}` for Facebook Marketplace message emails (sender `facebookmail.com`). It takes `threadId` from the `marketplace/t/{id}` or `messages/t/{id}` link when present.
  - `{kind:'order', platform:'facebook', orderId}` for shipping-order emails.
  - *Verify while implementing:* capture real emails first.
- **Produces, worker actions:**
  - `facebook/thread {threadId}` returns `PlatformMessage[]`:
    - `buyerUsername` = the display name.
    - The listing card gives `item`, with its title and Marketplace URL.
    - Messages from `FB_ACCOUNT_NAME` are dropped.
    - `messageExternalId` = `fb-{threadId}-{sha1(sentAt|body)}`, because FB doesn't expose stable message IDs.
    - `conversationExternalId` = `threadId`, which keeps two buyers with the same name apart **(RF5)**.
  - `facebook/sweep {}` opens the Marketplace inbox, reads the threads marked unread or updated since the last sweep (at most 10), and returns `{threadId, buyerName, snippet}[]`. It doesn't open them.
- **Produces, app:**
  - A message email with `threadId` triggers a thread fetch, then `mirrorMessages(db,'facebook',…)`.
  - A message email without `threadId` runs a sweep, then matches by buyer name and snippet, then fetches.
  - `fb-sweep` reschedules itself with `pickDelay('sweep')` inside active hours. It skips if a fetch ran in the last 10 minutes, and fetches each returned thread. Thread fetches don't count against any cap, but they share the serial queue.
  - Pause and error handling follow Part 2 Task 4: emails stay unhandled while paused, and after 3 failures the preview is reported.

- [ ] **Step 1:** Capture fixtures: one message email, one order email (if you can make a test shipping sale; otherwise mark the task's order parts *verify later*), and an inbox page with 2 unread threads.
- [ ] **Step 2: Write failing tests.**
  - Classify maps each FB email. A Facebook security email ("new login") gives `ignore`, and also posts `Facebook emailed about a new login. If that wasn't you in noVNC, check the account.` to `#bot-status`.
  - Browser: `thread` returns only the buyer's messages with the listing. `sweep` returns 2 threads.
  - Flow: the email, then the sweep, then a fetch of the same thread give one Discord post per message **(RF5)**.
  - Flow: two buyers both named "Sam" get two threads **(RF5)**.
  - Sweep scheduling with a fake clock: none at 23:00, and the delay lands within 25–40 minutes.
- [ ] **Step 3:** Run the tests. Expect FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run the tests. Expect PASS.
- [ ] **Step 6:** Commit with `feat: Facebook buyer messages via email and a paced inbox sweep`.

### Task 4: Replies from Discord to FB buyers

**Files:**
- Create: `src/worker/sites/facebook/reply.ts`
- Modify: `src/platforms/facebook/connector.ts` (`sendReply`)
- Test: `tests/browser/facebook-reply.browser.test.ts`, `tests/platforms/facebook/connector.test.ts`

**Interfaces:**
- **Produces:** worker action `facebook/reply {threadId, text}`. It checks `canAct('reply')`, opens the thread, types with `humanType`, presses Enter, and waits for a new bubble from you containing the text. It records the action and returns the bubble's synthetic ID.
- Connector `sendReply` maps the outcomes:
  - The reply cap gives `Couldn't send: FB reply limit reached (15/hour). It'll go through after {time}`. The reply is **not** queued, so you resend it. That keeps ✅/❌ honest.
  - A pause gives `Couldn't send: Facebook is paused ({reason}), see #bot-status`.
  - A timeout gives `Couldn't send: Facebook took too long`.

- [ ] **Step 1: Write failing tests.**
  - Browser: `reply` on a fake composer page appends the bubble and returns an ID.
  - Connector: each error kind above becomes the exact ❌ text in `handleThreadReply`.
  - A success records an action, and the 16th reply in the hour is refused.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: reply to Facebook buyers from Discord`.

### Task 5: Facebook fields in the draft, Mom's FB button, the queued status

**Files:**
- Modify: `src/ai/draftListing.ts`, `src/listings/edit.ts`, `src/telegram/momListings.ts`, `src/discord/newListing.ts`, `src/listings/pipeline.ts`, `src/db/schema.sql`
- Test: `tests/ai/draftListing.test.ts`, `tests/telegram/momListings.test.ts`, `tests/listings/pipeline.test.ts`, `tests/discord/newListing.test.ts`

**Interfaces:**
- **Produces, draft:** `ListingDraft.facebook = {category: FbCategory}`, which is optional.
  - `FbCategory` is pinned in `selectors.ts` as `FB_CATEGORIES`, the names shown in Marketplace's category picker for item listings. *Verify while implementing:* copy the list from the live create page during Task 2's fixture capture.
  - The FB condition is derived from the shared condition, not drafted separately: `NEW→'New'`, `NEW_OTHER→'Used – Like New'`, `USED_EXCELLENT→'Used – Like New'`, `USED_GOOD→'Used – Good'`, `USED_ACCEPTABLE→'Used – Fair'`.
- **Produces, Telegram:** `✅ FB` (`lpost:{id}:facebook`) when Facebook is configured and the item isn't listed on FB yet. `✅ All` includes FB.
- **Produces, pipeline:** `postItem(id, 'facebook')` doesn't post. It runs `transitionListing(…, ['none','error'] → 'queued')` and returns `'queued'`, so a double tap queues once.
  - `listings.status` gains `queued`.
  - Discord status shows `FB: queued, posts around {time}`, using pacing's next `retryAt`. Mom's message shows `FB: queued`.
- **Produces, an extra edit field:** `fbCategory` (buttons from `FB_CATEGORIES`, two per row).

- [ ] **Step 1: Write failing tests.**
  - An old draft without `facebook` still parses.
  - A category not in the list is replaced by the closest name, or by `'Miscellaneous'`. *Verify while implementing:* check that this name exists in the live list.
  - The keyboard shows `FB` when FB is configured and the item isn't on FB yet.
  - `postItem(id,'facebook')` twice gives `'queued'` and then `'busy'`.
  - `postItem(id,'all')` posts eBay and Etsy right away and queues FB.
  - Status text shows the queued time.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: Facebook draft fields, FB button and queued posting status`.

### Task 6: Posting listings through the browser

**Files:**
- Create: `src/worker/sites/facebook/post.ts`, `src/listings/fbQueue.ts`
- Modify: `src/jobs/schedule.ts` (`fb-post-queue`), `src/platforms/facebook/connector.ts`
- Test: `tests/browser/facebook-post.browser.test.ts`, `tests/listings/fbQueue.test.ts`

**Interfaces:**
- **Produces, worker action `facebook/post {title, priceCents, description, category, condition, photos: path[], location, delivery}`:**
  - Opens `facebook.com/marketplace/create/item` and runs the guard.
  - Uploads photos with `setInputFiles`. The JPEGs are prepared by the app with metadata removed and placed in the shared `photos` volume, mounted read-only in the worker.
  - Then fills, with `humanType` and `humanClick`: title (truncated to FB's limit, which is pinned in `selectors.ts` after you *verify* it), price in whole dollars (rounded half up), category, condition, description, location (type, then pick the first suggestion) and delivery options from `FB_DELIVERY`.
  - Clicks Next or Publish as the form asks.
  - **Confirms:** opens `marketplace/you/selling` and finds a listing with the exact title posted in the last 10 minutes. It returns `{externalId, url}` from that card's link.
  - If there's no match within 2 minutes, it throws `UnconfirmedPost` **(RF1)**.
  - A "listing rejected" or "doesn't follow our Commerce Policies" message for *this listing* throws `ListingRejected(text)`, and FB is **not** paused **(RF2)**.
- **Produces, `fbQueue.drain(deps)`, run by `fb-post-queue` every 5 minutes:**
  - Skips while FB is paused or `canAct('listing')` is false.
  - Otherwise takes the oldest `queued` FB listing whose item still isn't sold, flips it to `posting`, calls the worker, then marks it `live` with the URL, or `error`.
  - At most one listing per run.
  - `UnconfirmedPost` gives an `error` with "FB didn't confirm the listing. Check Your listings on Facebook before posting again." It's never re-queued automatically.
  - After an unconfirmed error, Mom's FB button returns only after the owner taps **Retry FB** in Discord (owner confirms the listing isn't on FB).
  - An item that sold elsewhere while queued gets `ended` without posting.
- **Produces, connector:** `createListing` isn't used for FB, because posting goes through the queue. `delist` comes in Task 7.

- [ ] **Step 1: Write failing tests.**
  - Queue, with a fake worker and a fixed clock:
    - With 3 queued on day 5, two runs 50 minutes apart post 2, and the third waits for tomorrow **(RF3)**.
    - A run at 22:30 posts nothing.
    - A paused FB posts nothing, and the listings stay `queued`.
    - `UnconfirmedPost` gives `error` with the text above, and the next run doesn't retry it **(RF1)**.
    - `ListingRejected` gives `error` with FB's text, and FB isn't paused **(RF2)**.
    - An item sold on eBay while queued becomes `ended` with no worker call.
  - Browser, against a local fake create-form page built from the fixture's structure: `post` fills every field in order and stops at the confirmation step. A selling-page fixture with the matching title returns its URL.
- [ ] **Step 2:** Run `pnpm test tests/listings && pnpm test:browser`. Expect FAIL.
- [ ] **Step 3:** Implement. Keep every selector and text pattern in `selectors.ts`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5: Live check.** Post one real test item through the queue, confirm it in the FB app, then delete it by hand.
- [ ] **Step 6:** Commit with `feat: post to Facebook Marketplace through a paced queue`.

### Task 7: FB sales (Sold button and shipping orders), delisting on FB

**Files:**
- Create: `src/orders/manualSale.ts`, `src/worker/sites/facebook/listing.ts`
- Modify: `src/platforms/facebook/connector.ts` (`delist`, `fetchOrder`), `src/telegram/momListings.ts`, `src/discord/newListing.ts`, `src/discord/bot.ts`, `src/discord/toShip.ts`, `src/db/repo.ts`
- Test: `tests/orders/manualSale.test.ts`, `tests/browser/facebook-listing.browser.test.ts`

**Interfaces:**
- **Produces, the Sold button:**
  - **💰 Sold on FB** appears on the Discord status message (owner only) and on Mom's Telegram message, whenever the item's FB listing is `live`.
  - Tapping it asks **Pickup** or **Shipping**:
    - **Pickup** calls `recordManualSale(itemId, {localPickup:true}, by)`.
    - **Shipping** says `Facebook will email the order with the address; it'll show up in #to-ship.` and records nothing yet.
- **Produces, `recordManualSale(itemId, opts, by, deps) → 'recorded'|'already'`:**
  - Inserts order `fb-manual-{itemId}` (platform `facebook`, buyer `FB buyer`, `localPickup:true`, `shipBy:null`) with `insertOrderIfNew`, so a double tap is `'already'` **(RF4)**.
  - Then runs the same `announceOrders` path as API sales, which covers `#to-ship`, `#sales`, Mom's Telegram and Part 2's `onSale`, which delists the other platforms.
  - Then calls worker `facebook/markSold {url}` on the FB listing.
- **Produces, FB shipping orders:**
  - An `order` mail event calls worker `facebook/readOrder {orderId}`, which returns a `PlatformOrder` with the address, ship-by date and listing URL. The item is found by `findItemByListing('facebook', …)`.
  - If the item already has a `fb-manual-…` order, its `ship_to`, `local_pickup` and `ship_by` are updated in place, and the `#to-ship` and Telegram messages are edited instead of new ones being sent **(RF4)**.
  - Otherwise the normal `announceOrders` runs.
  - Mom's 📦 Shipped marks FB orders shipped **internally only** (spec §6). Facebook's own shipping label flow is done in the FB app.
- **Produces, `delist` on FB:** `facebook/markSold {url}` opens the listing and uses **Mark as sold**. An already-sold or missing listing returns `'already-gone'`. It isn't paced, because it's urgent, but it shares the serial queue. While FB is paused, the delist is queued as a retry and reported, as in Part 2.

- [ ] **Step 1: Write failing tests.**
  - Manual sale: one tap gives 1 order, 1 `#to-ship` post, 1 Telegram message, the eBay and Etsy listings delisted, and FB marked sold. A second tap returns `'already'` with no new posts **(RF4)**.
  - A shipping-order email after a manual pickup sale updates that order, edits the two messages, and creates no second order **(RF4)**.
  - A shipping-order email with no manual order gives a normal announcement.
  - Sold-on-FB from a non-owner in Discord is ignored, and from a non-Mom chat on Telegram is ignored.
  - An eBay sale for an item live on FB calls `markSold` once.
  - Browser: `markSold` on a listing fixture clicks the right control, and a sold-listing fixture returns `'already-gone'`.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: Facebook sales via Sold button and order emails; mark sold on FB`.

### Task 8: README and smoke test

**Files:**
- Modify: `README.md`, `.env.example`

- [ ] **Step 1:** Update the README:
  - The intro: "Part 3 adds Facebook Marketplace."
  - A **Facebook setup** section: warm-up, two-factor, notification email, shipping, sign in through noVNC, the `.env` block.
  - A **Facebook risks** section: a short version of the ban-risk section above, the caps, ⏸ Pause FB, and what a `restricted` pause means.
  - Mom's buttons now include FB, and there's 💰 Sold on FB.
  - Troubleshooting: "FB: queued" for hours (the caps or active hours, which is expected), "FB didn't confirm the listing", "Facebook needs you: checkpoint", "reply limit reached".
- [ ] **Step 2:** Run `pnpm test && pnpm test:browser && pnpm build && docker compose build`. Expect success.
- [ ] **Step 3: Manual smoke test on the homelab** (during active hours):
  - Mom taps FB on a test item. Discord shows "queued", and it posts within 5 minutes (first listing of the day). Check it in the FB app.
  - From another account, message the listing. Within about 4 minutes, or by the next sweep, `buyer: … · FB` appears. Reply there, see ✅, and check the reply in the FB app.
  - Tap 💰 Sold on FB → Pickup. `#to-ship` and Mom's Telegram show it, the eBay and Etsy copies end, and FB shows the listing sold.
  - Tap ⏸ Pause FB, reply in a thread, see ❌ "Facebook is paused (manual)", then Resume.
- [ ] **Step 4:** Commit with `docs: Facebook setup, risks and troubleshooting in README`.
