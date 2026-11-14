import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { CONDITIONS, truncateTitle, type Condition, type DraftInput, type ListingDraft } from '../ai/draftListing.js';
import type { Db } from '../db/db.js';
import * as repo from '../db/repo.js';
import type { ListingRow } from '../db/repo.js';
import { parseIntake, parsePrice } from '../intake/parseIntake.js';
import { EbayError } from '../platforms/ebay/client.js';
import type { EbayListingInput } from '../platforms/ebay/listings.js';
import { PLATFORM_LABEL } from '../platforms/types.js';

export const MAX_PHOTOS = 24;

export interface ListingDeps {
  db: Db;
  ownerId: string;
  draft: (input: DraftInput) => Promise<ListingDraft>;
  downloadPhoto: (url: string) => Promise<Buffer>;
  savePhoto: (folder: string, name: string, data: Buffer) => Promise<string>;
  readPhoto: (path: string) => Promise<Buffer>;
  ebay: {
    uploadImage: (file: { mime: string; data: Buffer; name: string }) => Promise<string>;
    suggestCategory: (query: string) => Promise<{ categoryId: string; requiredAspects: string[] }>;
    createListing: (input: EbayListingInput) => Promise<{ listingId: string; url: string }>;
  };
  report: (text: string) => Promise<void>;
}

export interface IntakeMessage {
  id: string;
  authorId: string;
  content: string;
  attachments: { name: string; contentType: string | null; url: string }[];
  reply: (payload: any) => Promise<{ id: string }>;
}

export interface ButtonInteractionLike {
  customId: string;
  userId: string;
  deferUpdate: () => Promise<unknown>;
  editReply: (payload: any) => Promise<unknown>;
  showModal: (modal: any) => Promise<unknown>;
  update: (payload: any) => Promise<unknown>;
}

export interface ModalInteractionLike {
  customId: string;
  userId: string;
  field: (id: string) => string;
  update: (payload: any) => Promise<unknown>;
  reply: (payload: any) => Promise<unknown>;
}

const CONDITION_LABEL: Record<Condition, string> = {
  NEW: 'New',
  NEW_OTHER: 'New (other)',
  USED_EXCELLENT: 'Used – excellent',
  USED_GOOD: 'Used – good',
  USED_ACCEPTABLE: 'Used – acceptable',
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function mimeFromPath(path: string): string {
  return MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/jpeg';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function buildPreview(
  item: { id: number; priceCents: number },
  draft: ListingDraft,
  listings: ListingRow[],
  skipped: string[],
) {
  const embed = new EmbedBuilder()
    .setTitle(draft.title)
    .addFields(
      { name: 'Price', value: money(item.priceCents), inline: true },
      { name: 'Condition', value: CONDITION_LABEL[draft.condition], inline: true },
      { name: 'Description', value: clip(draft.description, 1024) },
    );

  const specifics = Object.entries(draft.aspects)
    .map(([k, v]) => `${k}: ${v.join(', ')}`)
    .join('\n');
  if (specifics) embed.addFields({ name: 'Item specifics', value: clip(specifics, 1024) });

  for (const l of listings) {
    const label = PLATFORM_LABEL[l.platform];
    const value = l.status === 'live' && l.url ? `✅ [Live on ${label}](${l.url})` : `⚠️ ${clip(l.error ?? 'Failed', 1000)}`;
    embed.addFields({ name: label, value });
  }

  embed.setFooter({ text: skipped.length ? `Item #${item.id} · skipped: ${skipped.join(', ')}` : `Item #${item.id}` });

  const live = (p: string) => listings.some((l) => l.platform === p && l.status === 'live');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`post:ebay:${item.id}`)
      .setLabel(live('ebay') ? 'On eBay' : 'Post to eBay')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(live('ebay')),
    new ButtonBuilder().setCustomId(`post:etsy:${item.id}`).setLabel('Etsy (soon)').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`post:facebook:${item.id}`).setLabel('FB (soon)').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`edit:${item.id}`).setLabel('Edit').setStyle(ButtonStyle.Secondary).setDisabled(false),
    new ButtonBuilder().setCustomId(`cancel:${item.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(false),
  );

  return { content: '', embeds: [embed.toJSON()], components: [row.toJSON()] };
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

  try {
    const photos: { path: string; mime: string; data: Buffer }[] = [];
    for (const [i, a] of kept.entries()) {
      const data = await deps.downloadPhoto(a.url);
      const path = await deps.savePhoto(msg.id, safeName(a.name, i), data);
      photos.push({ path, mime: a.contentType ?? mimeFromPath(a.name), data });
    }

    const draft = await deps.draft({
      title: parsed.title,
      priceCents: parsed.priceCents,
      photos: photos.map((p) => ({ mime: p.mime, data: p.data })),
    });

    const item = await repo.insertItem(deps.db, {
      title: parsed.title,
      priceCents: parsed.priceCents,
      photos: photos.map((p) => p.path),
    });
    await repo.updateItemDraft(deps.db, item.id, { ...draft, skipped });
    const sent = await msg.reply(buildPreview(item, draft, [], skipped));
    await repo.setItemDiscordMessage(deps.db, item.id, sent.id);
  } catch (e) {
    await msg.reply({ content: `Couldn't draft that listing: ${(e as Error).message}` });
  }
}

interface StoredDraft extends ListingDraft {
  skipped?: string[];
}

async function loadItem(deps: ListingDeps, id: number) {
  const item = await repo.getItem(deps.db, id);
  if (!item || !item.draft) return null;
  const stored = item.draft as StoredDraft;
  const { skipped = [], ...draft } = stored;
  return { item, draft: draft as ListingDraft, skipped };
}

function missingAspects(draft: ListingDraft, required: string[]): string[] {
  const have = new Set(Object.keys(draft.aspects).map((k) => k.toLowerCase()));
  if (draft.brand) have.add('brand');
  return required.filter((r) => !have.has(r.toLowerCase()));
}

async function postToEbay(deps: ListingDeps, item: repo.Item, draft: ListingDraft): Promise<void> {
  try {
    const { categoryId, requiredAspects } = await deps.ebay.suggestCategory(draft.categoryQuery);
    const missing = missingAspects(draft, requiredAspects);
    if (missing.length) {
      throw new EbayError(
        400,
        `eBay needs these item specifics: ${missing.join(', ')}. Tap Edit and add them under Item specifics.`,
        false,
      );
    }
    const imageUrls: string[] = [];
    for (const path of item.photos) {
      const data = await deps.readPhoto(path);
      imageUrls.push(await deps.ebay.uploadImage({ mime: mimeFromPath(path), data, name: path.split('/').pop()! }));
    }
    const res = await deps.ebay.createListing({
      sku: `item-${item.id}`,
      priceCents: item.priceCents,
      draft: { ...draft, title: truncateTitle(draft.title) },
      imageUrls,
      categoryId,
    });
    await repo.upsertListing(deps.db, item.id, 'ebay', { externalId: res.listingId, url: res.url, status: 'live', error: null });
  } catch (e) {
    const message = (e as Error).message;
    await repo.upsertListing(deps.db, item.id, 'ebay', { externalId: null, url: null, status: 'error', error: message });
    if (e instanceof EbayError && e.isAuth) {
      await deps.report(`eBay rejected the login while posting item #${item.id}: ${message}`);
    }
  }
}

function editModal(itemId: number, priceCents: number, draft: ListingDraft) {
  const input = (id: string, label: string, value: string, style: TextInputStyle, max: number, required = true) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setValue(clip(value, max))
        .setMaxLength(max)
        .setRequired(required),
    );
  const specifics = Object.entries(draft.aspects)
    .map(([k, v]) => `${k}: ${v.join(', ')}`)
    .join('\n');
  return new ModalBuilder()
    .setCustomId(`editmodal:${itemId}`)
    .setTitle('Edit listing')
    .addComponents(
      input('title', 'Title (max 80)', draft.title, TextInputStyle.Short, 80),
      input('price', 'Price', (priceCents / 100).toFixed(2), TextInputStyle.Short, 12),
      input('condition', 'Condition (e.g. new, used good)', CONDITION_LABEL[draft.condition], TextInputStyle.Short, 40),
      input('description', 'Description', draft.description, TextInputStyle.Paragraph, 4000),
      input('specifics', 'Item specifics (Name: value per line)', specifics, TextInputStyle.Paragraph, 1000, false),
    )
    .toJSON();
}

export async function handleButton(i: ButtonInteractionLike, deps: ListingDeps): Promise<void> {
  if (i.userId !== deps.ownerId) return;
  const [action, a, b] = i.customId.split(':');
  const id = Number(action === 'post' ? b : a);
  const loaded = await loadItem(deps, id);
  if (!loaded) return;
  const { item, draft, skipped } = loaded;

  if (action === 'post' && a === 'ebay') {
    await i.deferUpdate();
    await postToEbay(deps, item, draft);
    await i.editReply(buildPreview(item, draft, await repo.getListings(deps.db, id), skipped));
  } else if (action === 'edit') {
    await i.showModal(editModal(id, item.priceCents, draft));
  } else if (action === 'cancel') {
    await i.update({ content: `Listing #${id} cancelled.`, embeds: [], components: [] });
  }
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

export async function handleEditModal(i: ModalInteractionLike, deps: ListingDeps): Promise<void> {
  if (i.userId !== deps.ownerId) return;
  const id = Number(i.customId.split(':')[1]);
  const loaded = await loadItem(deps, id);
  if (!loaded) return;

  const priceCents = parsePrice(i.field('price'));
  const condition = parseCondition(i.field('condition'));
  const title = truncateTitle(i.field('title'));
  const description = i.field('description').trim();
  const problems = [
    priceCents === null && 'price (use a number like 35 or 35.50)',
    condition === null && 'condition (new, new other, used excellent, used good or used acceptable)',
    !title && 'title',
    !description && 'description',
  ].filter(Boolean);
  if (problems.length) {
    await i.reply({ content: `Nothing saved. Please fix the ${problems.join(' and ')}.`, ephemeral: true });
    return;
  }

  const aspects = parseSpecifics(i.field('specifics'));
  const brand = aspects.Brand?.[0] ?? loaded.draft.brand;
  const draft: ListingDraft = { ...loaded.draft, title, description, condition: condition!, aspects, brand };
  await repo.updateItemDraft(deps.db, id, { ...draft, skipped: loaded.skipped });
  await repo.updateItemPrice(deps.db, id, priceCents!);
  await i.update(
    buildPreview({ id, priceCents: priceCents! }, draft, await repo.getListings(deps.db, id), loaded.skipped),
  );
}
