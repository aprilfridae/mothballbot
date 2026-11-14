import { CONDITIONS } from '../ai/draftListing.js';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Item } from '../db/repo.js';
import {
  applyEdit,
  CONDITION_LABEL,
  EDITABLE_FIELDS,
  formatSpecifics,
  readDraft,
  type EditableField,
} from '../listings/edit.js';
import { postItem, rejectItem, type PipelineDeps } from '../listings/pipeline.js';
import { MOM_CHAT_KEY } from './momBot.js';

export const EDITING_KEY = 'telegram.editing';
const MAX_TEXT = 4096;
export const ALBUM_TYPES = /\.(jpe?g|png|webp)$/i;
export const MAX_ALBUM = 10;

export interface MomListingDeps {
  db: Db;
  pipeline: PipelineDeps;
}

/** What the bot should do in response; createMomBot carries it out. */
export interface MomAction {
  /** Short toast for a button tap, or a reply for typed text. */
  answer?: string;
  /** Re-render this item's draft message (text + draft buttons). */
  refresh?: number;
  /** Swap the buttons on this item's draft message. */
  keyboard?: 'draft' | 'fields' | 'conditions';
  itemId?: number;
  /** Send a new message asking Mom to type something. */
  prompt?: string;
}

export type KeyRows = { text: string; data: string }[][];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const FIELD_LABEL: Record<EditableField, string> = {
  title: 'Title',
  price: 'Price',
  condition: 'Condition',
  description: 'Description',
  specifics: 'Item specifics',
};

export function albumPhotos(item: Item): string[] {
  return item.photos.filter((p) => ALBUM_TYPES.test(p)).slice(0, MAX_ALBUM);
}

function statusFooter(item: Item, listingError: string | null, liveUrl: string | null): string {
  switch (item.status) {
    case 'posting':
      return '⏫ Posting to eBay…';
    case 'live':
      return `✅ Live on eBay${liveUrl ? `: ${liveUrl}` : ''}`;
    case 'rejected':
      return '🗑 Rejected';
    case 'error':
      return listingError
        ? `⚠️ eBay said: ${listingError} Tap Edit to fix, then Post again.`
        : `⚠️ ${item.research?.reasoning ?? 'Something went wrong.'}`;
    default:
      return '';
  }
}

/** Mom's view of a draft. Plain text (no Markdown) so titles and links can't break formatting. */
export function formatDraftForMom(item: Item, listingError: string | null, liveUrl: string | null = null): string {
  const stored = readDraft(item);
  const r = item.research;
  const title = stored?.draft.title ?? item.title;

  let priceLine: string;
  if (item.priceCents === null) priceLine = '💲 No price yet — tap Edit → Price';
  else {
    const range = r?.lowCents != null && r?.highCents != null ? `range ${money(r.lowCents)}–${money(r.highCents)}` : null;
    const fromSeller = r?.suggestedCents != null && r.suggestedCents !== item.priceCents;
    const extras = fromSeller
      ? [`seller's price · research suggests ${money(r!.suggestedCents!)}${range ? `, ${range}` : ''}`, `confidence ${r!.confidence}`]
      : [range, r?.suggestedCents != null ? `confidence ${r.confidence}` : null].filter(Boolean);
    priceLine = `💲 ${money(item.priceCents)}${extras.length ? ` (${extras.join(' · ')})` : ''}`;
  }

  const head = [`📝 ${title}`, '', priceLine];
  if (stored) head.push(`Condition: ${CONDITION_LABEL[stored.draft.condition]}`);

  const tail: string[] = [];
  const specifics = stored ? formatSpecifics(stored.draft.aspects) : '';
  if (specifics) tail.push('', 'Item specifics:', specifics);
  if (r?.comparables.length) {
    tail.push('', 'Comparables:');
    for (const c of r.comparables) {
      tail.push(`• ${money(c.priceCents)} ${c.sold ? 'sold' : 'asking'} · ${c.site} — ${c.title.slice(0, 120)} ${c.url}`);
    }
  }
  if (r?.reasoning) tail.push('', `Why: ${r.reasoning.slice(0, 500)}`);
  const hidden = item.photos.length - albumPhotos(item).length;
  if (hidden > 0) tail.push(`(+${hidden} photo${hidden === 1 ? '' : 's'} not shown)`);
  const footer = statusFooter(item, listingError, liveUrl);
  if (footer) tail.push('', footer);

  const fixed = head.join('\n').length + tail.join('\n').length + 4;
  let description = stored?.draft.description ?? '';
  const room = MAX_TEXT - fixed;
  if (description.length > room) description = room > 1 ? description.slice(0, room - 1) + '…' : '';

  return [...head, '', description, ...tail].join('\n').slice(0, MAX_TEXT);
}

export function draftKeyboard(item: Item): KeyRows {
  if (!['awaiting_mom', 'error'].includes(item.status)) return [];
  const row = [];
  if (item.priceCents !== null) row.push({ text: '✅ Post to eBay', data: `lpost:${item.id}` });
  row.push({ text: '✏️ Edit', data: `ledit:${item.id}` }, { text: '🗑 Reject', data: `lrej:${item.id}` });
  return [row];
}

export function fieldKeyboard(id: number): KeyRows {
  return [
    ...EDITABLE_FIELDS.map((f) => [{ text: FIELD_LABEL[f], data: `lfield:${id}:${f}` }]),
    [{ text: '↩ Back', data: `lback:${id}` }],
  ];
}

export function conditionKeyboard(id: number): KeyRows {
  return [...CONDITIONS.map((c) => [{ text: CONDITION_LABEL[c], data: `lcond:${id}:${c}` }]), [{ text: '↩ Back', data: `ledit:${id}` }]];
}

async function isMom(db: Db, chatId: number): Promise<boolean> {
  return (await repo.getSetting(db, MOM_CHAT_KEY)) === String(chatId);
}

const EDITABLE: repo.ItemStatus[] = ['awaiting_mom', 'error'];
const already = (item: Item) => `This listing is already ${item.status}.`;

function promptFor(item: Item, field: EditableField): string {
  const stored = readDraft(item);
  switch (field) {
    case 'price':
      return `Send the new price${item.priceCents !== null ? ` (now ${money(item.priceCents)})` : ''}, like 45 or 45.50. Or type cancel.`;
    case 'title':
      return `Send the new title (max 80 characters). Now:\n${stored?.draft.title ?? item.title}\n\nOr type cancel.`;
    case 'description':
      return 'Send the new description. Or type cancel.';
    case 'specifics':
      return `Send item specifics, one per line like "Color: Blue". This replaces the current list:\n${
        (stored && formatSpecifics(stored.draft.aspects)) || '(none yet)'
      }\n\nOr type cancel.`;
    default:
      return 'Send the new value. Or type cancel.';
  }
}

export async function handleListingCallback(chatId: number, data: string, deps: MomListingDeps): Promise<MomAction | null> {
  const m = data.match(/^(lpost|ledit|lrej|lback|lfield|lcond):(\d+)(?::([A-Za-z_]+))?$/);
  if (!m) return null;
  if (!(await isMom(deps.db, chatId))) return null;
  const [, action, idText, arg] = m;
  const itemId = Number(idText);
  const item = await repo.getItem(deps.db, itemId);
  if (!item) return { answer: 'That listing no longer exists.' };

  switch (action) {
    case 'lpost': {
      const result = await postItem(itemId, deps.pipeline);
      if (result === 'blocked') return { answer: 'Set a price first: tap Edit → Price' };
      if (result === 'busy') {
        const now = (await repo.getItem(deps.db, itemId))!;
        return { answer: now.status === 'posting' ? 'Already posting…' : already(now) };
      }
      return { answer: result === 'live' ? '✅ Live on eBay' : "⚠️ eBay didn't accept it. See the message.", refresh: itemId };
    }
    case 'lrej':
      return (await rejectItem(itemId, deps.pipeline)) ? { answer: '🗑 Rejected', refresh: itemId } : { answer: already(item) };
    case 'ledit':
      if (!EDITABLE.includes(item.status)) return { answer: already(item) };
      return { keyboard: 'fields', itemId };
    case 'lback':
      await repo.deleteSetting(deps.db, EDITING_KEY);
      return { keyboard: 'draft', itemId };
    case 'lfield': {
      if (!EDITABLE.includes(item.status)) return { answer: already(item) };
      const field = arg as EditableField;
      if (!EDITABLE_FIELDS.includes(field)) return null;
      if (field === 'condition') return { keyboard: 'conditions', itemId };
      await repo.setSetting(deps.db, EDITING_KEY, JSON.stringify({ itemId, field }));
      return { prompt: promptFor(item, field), itemId };
    }
    case 'lcond': {
      const r = await applyEdit(deps.db, itemId, 'condition', arg ?? '');
      return r.ok ? { answer: 'Condition updated ✅', refresh: itemId, keyboard: 'draft', itemId } : { answer: r.error };
    }
  }
  return null;
}

interface EditState {
  itemId: number;
  field: EditableField;
  /** The bot's question; only replies to it count, so a stray message (e.g. a tracking number) can't become a field. */
  promptMessageId?: number;
}

/** Records which message asked Mom for the value. */
export async function setEditPrompt(db: Db, promptMessageId: number): Promise<void> {
  const raw = await repo.getSetting(db, EDITING_KEY);
  if (!raw) return;
  await repo.setSetting(db, EDITING_KEY, JSON.stringify({ ...(JSON.parse(raw) as EditState), promptMessageId }));
}

/** Typed text while Mom is editing a field. Returns null when no edit is active (so other handlers can run). */
export async function handleListingText(
  chatId: number,
  replyToId: number | null,
  text: string,
  deps: MomListingDeps,
): Promise<MomAction | null> {
  if (!(await isMom(deps.db, chatId))) return null;
  const raw = await repo.getSetting(deps.db, EDITING_KEY);
  if (!raw) return null;
  const { itemId, field, promptMessageId } = JSON.parse(raw) as EditState;

  if (/^\s*cancel\s*$/i.test(text)) {
    await repo.deleteSetting(deps.db, EDITING_KEY);
    return { answer: 'OK, no changes.', keyboard: 'draft', itemId };
  }
  if (promptMessageId !== undefined && replyToId !== promptMessageId) {
    return {
      answer: `To change the ${FIELD_LABEL[field].toLowerCase()}, reply to my question above (swipe left on it). Or type cancel.`,
    };
  }
  const r = await applyEdit(deps.db, itemId, field, text);
  if (!r.ok) {
    // A finished listing can't be edited any more, so stop asking.
    if (r.error.startsWith('This listing is already')) await repo.deleteSetting(deps.db, EDITING_KEY);
    return { answer: r.error };
  }
  await repo.deleteSetting(deps.db, EDITING_KEY);
  return { answer: `${FIELD_LABEL[field]} updated ✅`, refresh: itemId, keyboard: 'draft', itemId };
}

/** Toast to show immediately for slow actions; the real outcome then shows on the draft (or as a message). */
export function earlyAnswer(data: string): string | null {
  return /^lpost:\d+$/.test(data) ? 'Posting to eBay…' : null;
}
