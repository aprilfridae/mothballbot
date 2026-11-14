import { CONDITIONS, truncateTitle, type Condition, type ListingDraft } from '../ai/draftListing.js';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Item } from '../db/repo.js';
import { parsePrice } from '../intake/parseIntake.js';

export type EditableField = 'title' | 'price' | 'condition' | 'description' | 'specifics';
export const EDITABLE_FIELDS: EditableField[] = ['title', 'price', 'condition', 'description', 'specifics'];

export const CONDITION_LABEL: Record<Condition, string> = {
  NEW: 'New',
  NEW_OTHER: 'New (other)',
  USED_EXCELLENT: 'Used – excellent',
  USED_GOOD: 'Used – good',
  USED_ACCEPTABLE: 'Used – acceptable',
};

/** The stored draft is the AI draft plus the intake's notes about skipped attachments. */
export interface StoredDraft extends ListingDraft {
  skipped?: string[];
}

export function readDraft(item: Item): { draft: ListingDraft; skipped: string[] } | null {
  if (!item.draft) return null;
  const { skipped = [], ...draft } = item.draft as StoredDraft;
  return { draft: draft as ListingDraft, skipped };
}

export function parseCondition(text: string): Condition | null {
  const norm = text.toUpperCase().replace(/\(|\)/g, '').replace(/[\s–-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (CONDITIONS as readonly string[]).includes(norm) ? (norm as Condition) : null;
}

export function parseSpecifics(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const values = line
      .slice(idx + 1)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (name && values.length) out[name] = values;
  }
  return out;
}

export function formatSpecifics(aspects: Record<string, string[]>): string {
  return Object.entries(aspects)
    .map(([k, v]) => `${k}: ${v.join(', ')}`)
    .join('\n');
}

const EDITABLE_STATUSES: repo.ItemStatus[] = ['awaiting_mom', 'error'];

export type EditResult = { ok: true; item: Item } | { ok: false; error: string };

/** Validates and applies one field edit. Only drafts waiting on Mom (or after an eBay error) can change. */
export async function applyEdit(db: Db, itemId: number, field: EditableField, value: string): Promise<EditResult> {
  const item = await repo.getItem(db, itemId);
  if (!item) return { ok: false, error: 'That listing no longer exists.' };
  if (!EDITABLE_STATUSES.includes(item.status)) return { ok: false, error: `This listing is already ${item.status}.` };
  const stored = readDraft(item);
  if (!stored) return { ok: false, error: "This listing doesn't have a draft yet." };
  const draft = { ...stored.draft };

  switch (field) {
    case 'price': {
      const cents = parsePrice(value);
      if (cents === null) return { ok: false, error: 'That price didn\'t work. Send a number like 45 or 45.50.' };
      await repo.updateItemPrice(db, itemId, cents);
      break;
    }
    case 'title': {
      const title = truncateTitle(value);
      if (!title) return { ok: false, error: "The title can't be empty." };
      draft.title = title;
      break;
    }
    case 'condition': {
      const condition = parseCondition(value);
      if (!condition) return { ok: false, error: 'Pick one of: new, new other, used excellent, used good, used acceptable.' };
      draft.condition = condition;
      break;
    }
    case 'description': {
      const description = value.trim();
      if (!description) return { ok: false, error: "The description can't be empty." };
      draft.description = description;
      break;
    }
    case 'specifics': {
      const aspects = parseSpecifics(value);
      if (!Object.keys(aspects).length) {
        return { ok: false, error: 'Send one per line as Name: value, like "Color: Blue" or "Pattern: Blue Italian".' };
      }
      draft.aspects = aspects;
      draft.brand = draft.aspects.Brand?.[0] ?? draft.brand;
      break;
    }
  }

  if (field !== 'price') await repo.updateItemDraft(db, itemId, { ...draft, skipped: stored.skipped });
  return { ok: true, item: (await repo.getItem(db, itemId))! };
}
