CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  photos JSONB NOT NULL DEFAULT '[]',
  draft JSONB,
  discord_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listings (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  status TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (item_id, platform)
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  buyer_username TEXT NOT NULL,
  discord_thread_id TEXT,
  UNIQUE (platform, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE,
  from_buyer BOOLEAN NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  item_title TEXT NOT NULL,
  buyer TEXT NOT NULL,
  ship_to JSONB,
  local_pickup BOOLEAN NOT NULL DEFAULT false,
  ship_by TIMESTAMPTZ,
  line_item_ids JSONB NOT NULL DEFAULT '[]',
  discord_message_id TEXT,
  telegram_message_id BIGINT,
  shipped_at TIMESTAMPTZ,
  shipped_by TEXT,
  tracking TEXT,
  UNIQUE (platform, external_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Part 1b: Mom approves listings on Telegram, with AI price research
ALTER TABLE items ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'researching';
ALTER TABLE items ADD COLUMN IF NOT EXISTS research JSONB;
ALTER TABLE items ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
ALTER TABLE items ALTER COLUMN price_cents DROP NOT NULL;
-- Items posted under Part 1 have no status yet; anything already live on eBay is live.
UPDATE items SET status = 'live'
  WHERE status = 'researching' AND id IN (SELECT item_id FROM listings WHERE status = 'live');

-- Follow-ups: sale photo for Mom, retrying a failed tracking upload
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfill_error TEXT;
