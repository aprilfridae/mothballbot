import { EmbedBuilder } from 'discord.js';
import { AI_IMAGE_TYPES } from '../ai/draftListing.js';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { Item, ListingRow } from '../db/repo.js';
import { parseIntake } from '../intake/parseIntake.js';
import { mimeFromPath } from '../listings/pipeline.js';

export const MAX_PHOTOS = 24;

export interface ListingDeps {
  db: Db;
  ownerId: string;
  downloadPhoto: (url: string) => Promise<Buffer>;
  savePhoto: (folder: string, name: string, data: Buffer) => Promise<string>;
  /** The listing pipeline's createDraft, bound to its deps. */
  createDraft: (itemId: number, photos: { mime: string; data: Buffer }[], skipped: string[]) => Promise<Item>;
}

export interface IntakeMessage {
  id: string;
  authorId: string;
  content: string;
  attachments: { name: string; contentType: string | null; url: string }[];
  reply: (payload: any) => Promise<{ id: string }>;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function priceLine(item: Item): string {
  const r = item.research;
  const range = r?.lowCents != null && r?.highCents != null ? ` (${money(r.lowCents)}–${money(r.highCents)})` : '';
  if (item.priceCents === null) return "no comparables found, she'll set the price";
  if (r?.suggestedCents != null && r.suggestedCents === item.priceCents) return `suggested ${money(item.priceCents)}${range}`;
  return `your price ${money(item.priceCents)}${r?.suggestedCents != null ? ` · research says ${money(r.suggestedCents)}${range}` : ''}`;
}

function statusLine(item: Item, listings: ListingRow[], momLinked: boolean): string {
  const ebay = listings.find((l) => l.platform === 'ebay');
  switch (item.status) {
    case 'researching':
      return '🔎 Researching price…';
    case 'awaiting_mom':
      if (item.telegramMessageId !== null) return `📨 Sent to Mom · ${priceLine(item)}`;
      return momLinked ? `📨 Sending to Mom… · ${priceLine(item)}` : `⏳ Waiting for Mom to connect Telegram · ${priceLine(item)}`;
    case 'posting':
      return '⏫ Posting…';
    case 'live':
      return `✅ Posted by Mom · ${ebay?.url ?? 'link unavailable'}`;
    case 'rejected':
      return '🗑 Rejected by Mom';
    case 'error':
      if (ebay?.error) return `⚠️ Waiting on Mom: ${ebay.error}`;
      // No eBay error means the draft itself never reached Mom; only you can fix that.
      return `⚠️ ${item.research?.reasoning ?? 'Something went wrong.'}${
        item.research?.reasoning?.includes('post it again') || item.research?.reasoning?.includes('Post it again') ? '' : ' Post it again in #new-listing.'
      }`;
  }
}

/** Your read-only view of a listing in #new-listing. Mom makes every decision on Telegram. */
export function buildStatus(item: Item, listings: ListingRow[], momLinked: boolean) {
  const embed = new EmbedBuilder()
    .setTitle(item.title.slice(0, 256))
    .setDescription(statusLine(item, listings, momLinked).slice(0, 4096))
    .setFooter({ text: `Item #${item.id} · ${item.photos.length} photo${item.photos.length === 1 ? '' : 's'}` });
  return { content: '', embeds: [embed.toJSON()], components: [] };
}

function safeName(name: string, index: number): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  return `${String(index).padStart(2, '0')}-${clean}`;
}

export async function handleIntakeMessage(msg: IntakeMessage, deps: ListingDeps): Promise<void> {
  if (msg.authorId !== deps.ownerId) return;

  const parsed = parseIntake(msg.content);
  if (!parsed.ok) {
    await msg.reply({ content: parsed.hint });
    return;
  }

  const images = msg.attachments.filter((a) => a.contentType?.startsWith('image/'));
  const skipped = msg.attachments.filter((a) => !a.contentType?.startsWith('image/')).map((a) => a.name);
  if (!images.length) {
    await msg.reply({ content: 'Please attach at least one photo with your listing.' });
    return;
  }
  skipped.push(...images.slice(MAX_PHOTOS).map((a) => a.name));
  const kept = images.slice(0, MAX_PHOTOS);

  let photos: { path: string; mime: string; data: Buffer }[];
  try {
    photos = [];
    for (const [i, a] of kept.entries()) {
      const data = await deps.downloadPhoto(a.url);
      const path = await deps.savePhoto(msg.id, safeName(a.name, i), data);
      photos.push({ path, mime: a.contentType ?? mimeFromPath(a.name), data });
    }
  } catch (e) {
    await msg.reply({ content: `Couldn't save that listing: ${(e as Error).message}` });
    return;
  }

  if (!photos.some((p) => AI_IMAGE_TYPES.has(p.mime))) {
    skipped.push("(AI couldn't view HEIC photos, so double-check the details)");
  }

  const item = await repo.insertItem(deps.db, {
    title: parsed.title,
    details: parsed.details,
    priceCents: parsed.priceCents,
    photos: photos.map((p) => p.path),
  });
  const sent = await msg.reply(buildStatus(item, [], true));
  await repo.setItemDiscordMessage(deps.db, item.id, sent.id);
  await deps.createDraft(
    item.id,
    photos.map((p) => ({ mime: p.mime, data: p.data })),
    skipped,
  );
}
