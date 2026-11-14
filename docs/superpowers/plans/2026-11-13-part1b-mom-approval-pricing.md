# Part 1b: Mom Approves Listings on Telegram, with AI Price Research — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You post photos and details in Discord. The bot drafts the listing, researches sold prices on the web, and sends the draft to Mom on Telegram. She posts it to eBay, edits it or rejects it, and Discord shows the status.

**Architecture:**
- The listing logic moves out of `discord/newListing.ts` into a platform-neutral `listings/` module with three entry points: `createDraft`, `postItem` and `applyEdit`. Discord (intake and status) and Telegram (Mom's controls) both call it.
- Mom's Telegram handlers stay pure functions that return what to show. The grammY code in `createMomBot` only carries out those results.
- Price research is a single Claude call with the server-side web search tool.

**Tech Stack:** unchanged from Part 1 (TypeScript, discord.js, grammY, pg, `@anthropic-ai/sdk` with model `claude-haiku-5-5`, sharp).

**Spec:** `docs/superpowers/specs/2026-11-13-selling-bot-design.md` §11 (this plan). Part 1's plan is `docs/superpowers/plans/2026-11-13-part1-ebay-foundation.md`.

## Global Constraints

- **Approval:** only Mom (`telegram.momChatId`) can post, edit or reject a listing. Discord intake still only accepts `OWNER_DISCORD_ID`. Discord shows status only, with no listing buttons.
- **Research limits:** the web search tool runs at most **5 searches** per item, the model is `claude-haiku-5-5`, and research only aims for sold prices and comparable listings.
- **Comparables:** 3–5 shown, each with title, price, sold or asking, site and link.
- **Missing price:** if there's no suggested price and no owner price, **Post stays disabled** until Mom sets one.
- **Statuses:** an item is always in exactly one of `researching`, `awaiting_mom`, `posting`, `live`, `rejected`, `error`. Discord and Telegram show the item's current status.
- **Telegram limits:** messages are at most 4096 characters, an album holds at most 10 photos, and only JPEG, PNG and WebP go in the album.
- **Unchanged from Part 1:** never fail silently (`#bot-status`), never post twice, and never downgrade a live listing.

## Review Focus

1. **Research comes back unusable** (no JSON, zero comparables, the tool errors). Mom still gets the draft marked "Couldn't find comparables, please set a price", and Post stays disabled. → Task 2, Task 4
2. **Mom's text while editing collides with sale replies.** A reply to a *sale* message is always sale/tracking handling. Any other text while an edit is active updates the field. Text with no active edit gets a short hint. → Task 5
3. **Stale buttons.** Tapping Post, Edit or Reject on an item that is already live, rejected or posting answers with the current status and changes nothing. → Task 4, Task 5
4. **Long descriptions and many photos.** The draft text fits in 4096 characters, the album is capped at 10 photos, and HEIC is left out of the album with a count noted. → Task 5
5. **Mom not linked yet.** Drafts wait at `awaiting_mom` with no Telegram message and are sent when she links or on the next poll. Discord says "Waiting for Mom to connect Telegram". → Task 6

---

## File Structure

```
src/db/schema.sql            + items.details, status, research, telegram_message_id; price_cents nullable
src/db/repo.ts               + item status/research/telegram helpers
src/intake/parseIntake.ts    price optional → {details, priceCents|null}
src/ai/researchPrice.ts      NEW: web-search price research → PriceResearch
src/listings/edit.ts         NEW: applyEdit + parseCondition/parseSpecifics (moved from discord/newListing.ts)
src/listings/pipeline.ts     NEW: createDraft, postItem (posting logic moved from discord/newListing.ts)
src/discord/newListing.ts    intake → pipeline; buildStatus(item) status embed; buttons/modal removed
src/telegram/momListings.ts  NEW: formatDraftForMom, keyboards, pure handlers for Mom's listing actions
src/telegram/momBot.ts       route callbacks/text to momListings; send album + draft
src/main.ts                  wiring, pending-draft sweep
README.md                    new flow
```

---

### Task 1: Data model and optional-price intake

**Files:**
- Modify: `src/db/schema.sql`, `src/db/repo.ts`, `src/intake/parseIntake.ts`
- Test: `tests/db/repo.test.ts`, `tests/intake/parseIntake.test.ts`

**Interfaces:**
- **Produces, schema.** Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so existing databases migrate.
  - `items.details TEXT NOT NULL DEFAULT ''`
  - `items.status TEXT NOT NULL DEFAULT 'researching'`
  - `items.research JSONB`
  - `items.telegram_message_id BIGINT`
  - `items.price_cents` becomes nullable
- **Produces, repo.**
  - `ItemStatus = 'researching'|'awaiting_mom'|'posting'|'live'|'rejected'|'error'`.
  - `Item` gains `details`, `status`, `research: PriceResearch|null` and `telegramMessageId`. `priceCents` becomes `number|null`.
  - `insertItem(db, {title, details, priceCents: number|null, photos})`
  - `setItemStatus(db, id, status)`
  - `transitionItemStatus(db, id, from: ItemStatus[], to) → boolean`, an atomic `UPDATE … WHERE status = ANY($from)`.
  - `setItemResearch(db, id, research)`
  - `setItemTelegramMessage(db, id, messageId)`
  - `findItemByTelegramMessage(db, messageId)`
  - `itemsAwaitingMomWithoutTelegram(db) → Item[]`
- **Produces, intake.** `parseIntake(text) → {ok:true, details:string, title:string, priceCents:number|null} | {ok:false, hint}`.
  - `title` is the first line with the price removed.
  - `details` is the full text with the price removed.
  - It fails only when no text remains.

- [ ] **Step 1: Write failing tests.**
  - `parseIntake('Royal Doulton Bunnykins plate\n1936 backstamp, small chip')` returns `ok`, `priceCents: null`, `title: 'Royal Doulton Bunnykins plate'`, and `details` containing `small chip`.
  - `parseIntake('Spode Blue Italian platter $85')` returns `priceCents: 8500`.
  - `parseIntake('$40')` returns `ok:false`.
  - Repo: `transitionItemStatus(id, ['awaiting_mom'], 'posting')` returns true once and false the second time. Migration still runs twice without error.
  - `itemsAwaitingMomWithoutTelegram` returns only `awaiting_mom` items with no Telegram message.
  - Update the existing parseIntake tests to the new shape. Keep the price cases.
- [ ] **Step 2:** Run `pnpm test tests/intake tests/db`. Expect FAIL.
- [ ] **Step 3:** Implement. Keep the existing price-parsing helpers.
- [ ] **Step 4:** Run `pnpm test tests/intake tests/db`. Expect PASS. Other suites may fail until Task 3 updates their callers. Note that in the ledger.
- [ ] **Step 5:** Commit with `feat: item status/research columns and optional-price intake`.

### Task 2: AI price research

**Files:**
- Create: `src/ai/researchPrice.ts`
- Test: `tests/ai/researchPrice.test.ts`

**Interfaces:**
- **Produces.**
  - `PriceResearch = {suggestedCents:number|null, lowCents:number|null, highCents:number|null, confidence:'low'|'medium'|'high', comparables: {title:string, priceCents:number, sold:boolean, site:string, url:string}[], reasoning:string}`
  - `researchPrice(input:{details:string, draft:ListingDraft}, client: AnthropicLike) → Promise<PriceResearch>`. It **never throws**. Any failure returns `{suggestedCents:null, lowCents:null, highCents:null, confidence:'low', comparables:[], reasoning:'Couldn't find comparables: <reason>'}`.
- **Call details:**
  - `model: MODEL`
  - `tools: [{ type: <web search tool type string>, name: 'web_search', max_uses: 5 }]` — check the current type string in the Claude docs and pin it as `WEB_SEARCH_TOOL` in this file.
  - The system prompt asks for sold prices first, names the sites, and asks for JSON only.
  - Parse the **last** text block. Validate with zod. Keep at most 5 comparables, and drop any whose URL isn't `https://`.

- [ ] **Step 1: Write failing tests** with a fake client.
  - A valid JSON reply maps to cents. A `"$45.00"` string or the number `45` both become 4500.
  - The request has `tools[0].max_uses === 5` and `tools[0].name === 'web_search'`.
  - A reply of 7 comparables keeps the first 5. A `javascript:` URL is dropped.
  - No JSON, a client that throws, or a reply with zero comparables all give `suggestedCents: null`, with reasoning that starts `Couldn't find comparables` **(RF1)**.
  - When the reply has mixed content blocks (`server_tool_use`, `web_search_tool_result`, `text`), only the final text block is parsed.
- [ ] **Step 2:** Run `pnpm test tests/ai/researchPrice.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same tests. Expect PASS.
- [ ] **Step 5:** Commit with `feat: AI sold-price research with web search`.

### Task 3: Listing pipeline and edits (platform-neutral)

**Files:**
- Create: `src/listings/edit.ts`, `src/listings/pipeline.ts`
- Modify: `src/discord/newListing.ts`. Move `parseCondition`, `parseSpecifics` and the posting logic out, and delete `buildPreview`, `handleButton`, `handleEditModal` and the modal code.
- Test: `tests/listings/edit.test.ts`, `tests/listings/pipeline.test.ts`. Delete the button and modal tests in `tests/discord/newListing.test.ts`, and port their eBay-error, required-aspects and double-tap assertions to `pipeline.test.ts`.

**Interfaces:**
- **Produces, edit.ts.**
  - `EditableField = 'title'|'price'|'condition'|'description'|'specifics'`
  - `applyEdit(db, itemId, field, value) → {ok:true, item} | {ok:false, error:string}`
  - Each field is validated the way the old modal did it: `parsePrice`, `parseCondition`, `truncateTitle`, non-empty description, and `parseSpecifics`, which also updates `brand` from `Brand:`.
  - Edits are refused unless status is `awaiting_mom` or `error`. The error is `This listing is already <status>.`
- **Produces, pipeline.ts.**
  - `PipelineDeps = {db, draft, research:(input)=>Promise<PriceResearch>, readPhoto, ebay:{uploadImage, suggestCategory, createListing}, report, onChange:(item:Item)=>Promise<void>}`
  - `createDraft(itemId, photos:{mime,data}[], deps) → Promise<Item>`:
    1. Draft.
    2. Research.
    3. Set the price to the owner's price if there is one, otherwise `research.suggestedCents`.
    4. Set status to `awaiting_mom`.
    5. Call `onChange`.
    - If drafting fails, the status becomes `error`, the reason is stored as `research.reasoning`, and `onChange` is still called.
  - `postItem(itemId, deps) → Promise<'live'|'error'|'busy'|'blocked'>`:
    - `blocked` when the price is null.
    - `busy` when `transitionItemStatus(['awaiting_mom','error'] → 'posting')` returns false.
    - Otherwise it runs the existing required-aspects check, image upload and createListing. It sets `live` or `error`, saves the error in the eBay listing row, reports auth errors, and calls `onChange`.
  - `rejectItem(itemId, deps) → boolean`, which moves `awaiting_mom|error → rejected` and calls `onChange`.

- [ ] **Step 1: Write failing tests.**
  - `createDraft` with no owner price uses `research.suggestedCents` and ends at `awaiting_mom`.
  - With an owner price of 8500 and research suggesting 6000, the owner price is kept and the research is stored.
  - When the draft throws, the status is `error`, the reasoning holds the message, and `onChange` was called.
  - `postItem` with a null price returns `blocked` with no eBay calls **(RF1)**.
  - Two concurrent `postItem` calls give one `live` and one `busy`, with one `createListing` **(RF3)**.
  - An eBay 400 error gives `error` with the message stored, and Post is allowed again afterwards.
  - Missing required aspects give `error` without calling `createListing`.
  - An auth error is reported.
  - `rejectItem` on a live item returns false **(RF3)**.
  - `applyEdit` handles price `"$40"` → 4000 and `"cheap"` → error. Condition `"used excellent"` → `USED_EXCELLENT`. Specifics update `aspects` and `brand`. An edit on a live item is refused **(RF3)**.
- [ ] **Step 2:** Run `pnpm test tests/listings`. Expect FAIL.
- [ ] **Step 3:** Implement. Move the code rather than rewriting it, and keep the `item-{id}` SKU and the photo upload.
- [ ] **Step 4:** Run `pnpm test`. Expect all PASS, once callers are updated in this task or stubbed for Task 4.
- [ ] **Step 5:** Commit with `refactor: platform-neutral listing pipeline with research and edits`.

### Task 4: Discord intake and status view

**Files:**
- Modify: `src/discord/newListing.ts`, `src/discord/bot.ts` (remove the button and modal routing)
- Test: `tests/discord/newListing.test.ts`

**Interfaces:**
- **Consumes:** `parseIntake`, `insertItem`, `createDraft`.
- **Produces.**
  - `handleIntakeMessage(msg, deps)`:
    - Parses the text and saves the photos as before.
    - Inserts the item with status `researching` and replies with `buildStatus(item)`.
    - Stores the reply ID via `setItemDiscordMessage`.
    - Then awaits `createDraft`.
  - `buildStatus(item, momLinked:boolean) → {content:'', embeds:[…], components:[]}`. The embed has the title, a photo count and these status lines:
    - `researching` → `🔎 Researching price…`
    - `awaiting_mom` → `📨 Sent to Mom · suggested $45.00 ($30.00–$60.00)`. When there's no price: `📨 Sent to Mom · no comparables found, she'll set the price`. When she's not linked: `⏳ Waiting for Mom to connect Telegram`.
    - `posting` → `⏫ Posting…`
    - `live` → `✅ Posted by Mom · <url>`
    - `rejected` → `🗑 Rejected by Mom`
    - `error` → `⚠️ Waiting on Mom: <error>`
  - `ListingDeps` now holds `{db, ownerId, downloadPhoto, savePhoto, pipeline: PipelineDeps}`.

- [ ] **Step 1: Write failing tests.**
  - An owner post with photos plus `Spode Blue Italian platter` replies with a `🔎 Researching price…` status embed with no components, then calls `createDraft` once.
  - `buildStatus` covers each status line above, including the no-price wording and the not-linked wording.
  - Keep and adapt the existing intake tests: non-owner ignored, no photo → hint, the 24-photo cap, skipped PDF, the HEIC note, and a draft failure → the reply mentions it.
- [ ] **Step 2:** Run `pnpm test tests/discord/newListing.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expect all PASS.
- [ ] **Step 5:** Commit with `feat: Discord intake hands listings to Mom; status-only view`.

### Task 5: Mom's listing controls on Telegram

**Files:**
- Create: `src/telegram/momListings.ts`
- Modify: `src/telegram/momBot.ts`
- Test: `tests/telegram/momListings.test.ts`, `tests/telegram/momBot.test.ts`

**Interfaces:**
- **Produces, momListings.ts.**
  - `formatDraftForMom(item) → string`, at most 4096 characters **(RF4)**. In order:
    1. Title.
    2. `💲 $45.00 (range $30.00–$60.00 · confidence medium)`, or `💲 No price yet — tap Edit → Price`.
    3. Condition.
    4. Description, cut so the whole message fits.
    5. Item specifics.
    6. `Comparables:`, one line each: `• $42.00 sold · eBay — <title> <url>`.
    7. Reasoning.
    8. A status footer when the item isn't `awaiting_mom`. For `error`, it's `⚠️ eBay said: <listing error>. Tap Edit to fix, then Post again.` (`formatDraftForMom` takes `(item, listingError: string|null)`.)
  - `draftKeyboard(item)` buttons by status:
    - `awaiting_mom` or `error`: `✅ Post to eBay` (`lpost:{id}`, left out when the price is null), `✏️ Edit` (`ledit:{id}`), `🗑 Reject` (`lrej:{id}`).
    - Any other status: no buttons.
  - `fieldKeyboard(id)` has Title, Price, Condition, Description, Item specifics (`lfield:{id}:{field}`) and `↩ Back` (`lback:{id}`).
  - `conditionKeyboard(id)` has one button per condition (`lcond:{id}:{CONDITION}`).
  - `MomListingDeps = {db, pipeline: PipelineDeps}`
  - `MomAction = {answer?:string, editDraft?:{itemId:number}, keyboard?:'draft'|'fields'|'conditions', prompt?:string}`
  - `handleListingCallback(chatId, data, deps) → Promise<MomAction|null>`:
    - Returns null for any chat other than Mom's.
    - Unknown `data` returns null, so sale callbacks fall through to the existing handler.
    - `lpost`: calls `postItem`. `busy` answers `Already posting`, `blocked` answers `Set a price first`, and live or error answers the result. Afterwards `editDraft` re-renders the draft.
    - `ledit` and `lback` swap the keyboard.
    - `lfield` with `condition` shows the condition keyboard.
    - `lfield` with any other field saves `telegram.editing = {itemId, field}` and returns `prompt: 'Send the new <field>'`, plus the current value for title and price.
    - `lcond` calls `applyEdit`.
    - `lrej` calls `rejectItem`.
    - Stale items answer `This listing is already <status>` **(RF3)**.
  - `handleListingText(chatId, text, deps) → Promise<MomAction|null>`:
    - Applies to the active `telegram.editing` edit and clears it on success.
    - On failure it returns the validation error and keeps the edit active.
    - The text `cancel` clears the edit.
    - With no active edit it returns null.
  - `sendDraftToMom(item) → telegramMessageId|null`. This is a new `MomBot` method. It sends an album of up to 10 JPEG/PNG/WebP photos, then the draft with `draftKeyboard`. It returns null if she isn't linked.
  - `refreshDraft(item)`, also a new `MomBot` method, edits the draft text and keyboard.
- **Text routing in `createMomBot`:**
  1. A reply to a **sale** message (`findOrderByTelegramMessage` hit) goes to `handleMomReply`, unchanged.
  2. Otherwise, `handleListingText`.
  3. Otherwise, the existing "reply to the sale message" hint **(RF2)**.

- [ ] **Step 1: Write failing tests.**
  - `formatDraftForMom` with a 10,000-character description stays ≤ 4096 and still shows the comparables **(RF4)**.
  - A null price shows `No price yet` and `draftKeyboard` has no `lpost` **(RF1)**.
  - `lpost` from a stranger returns null.
  - `lpost` twice gives `Already posting` or the live status, with one `createListing` **(RF3)**.
  - `lfield:price` followed by text `$40` updates the price to 4000 and clears the editing state. Text `cheap` returns an error and keeps the state. `cancel` clears it.
  - `lcond:{id}:USED_GOOD` sets the condition.
  - `lrej` then `lpost` answers `This listing is already rejected`.
  - Text with no active edit returns null.
  - A reply to a sale message while an edit is active still marks the order shipped and leaves the edit untouched **(RF2)**.
- [ ] **Step 2:** Run `pnpm test tests/telegram`. Expect FAIL.
- [ ] **Step 3:** Implement. Album photos are read through `pipeline.readPhoto`, and HEIC is skipped with `(+N photos not shown)` added to the draft text **(RF4)**.
- [ ] **Step 4:** Run `pnpm test`. Expect all PASS.
- [ ] **Step 5:** Commit with `feat: Mom approves, edits or rejects listings on Telegram`.

### Task 6: Wiring, pending drafts and README

**Files:**
- Modify: `src/main.ts`, `src/discord/toShip.ts` (or a new `src/listings/pending.ts`), `README.md`
- Test: `tests/listings/pending.test.ts`

**Interfaces:**
- **Produces.**
  - `sendPendingDrafts({db, sendDraftToMom, report}) → Promise<void>`. For each item from `itemsAwaitingMomWithoutTelegram`, it sends the draft and stores the message ID. While she isn't linked it warns once to `#bot-status` (setting `telegram.draftsWarned`), and clears that flag after a successful send **(RF5)**.
  - **main.ts:**
    - `pipeline.onChange` (a) edits the Discord status message via `buildStatus` and (b) when `telegramMessageId` is set, calls `momBot.refreshDraft`. When the status first becomes `awaiting_mom` with no Telegram message, it calls `sendDraftToMom` and stores the ID.
    - `sendPendingDrafts` runs in `onLinked` and at the end of every orders poll.
    - The research client is the same Anthropic client.
  - **README:** rewrite the `#new-listing` row and add a "How listings work" section: post photos and details, AI research costs about 2–5¢ per item, Mom gets the draft on Telegram, and Discord shows the status. Update the AI cost line.

- [ ] **Step 1: Write failing tests.**
  - `sendPendingDrafts` with Mom unlinked warns once over two runs.
  - Once linked, every pending draft gets a message ID.
  - Rejected and live items are never sent.
- [ ] **Step 2:** Run `pnpm test tests/listings/pending.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement and wire it up. Then run `npx tsc --noEmit -p .` and `pnpm build`. Expect both clean.
- [ ] **Step 4:** Run `pnpm test`. Expect all PASS. Smoke-run `node dist/main.js` with fake env and expect it to reach the Discord login error, as in Part 1.
- [ ] **Step 5:** Commit with `feat: wire Mom approval flow, pending drafts, README`.
