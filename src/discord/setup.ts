import { ChannelType, type Client, type Guild } from 'discord.js';
import type { Config } from '../config.js';

type ChannelKey = keyof Config['channels'];

export const CHANNEL_SPECS: { key: ChannelKey; name: string; forum: boolean; topic: string }[] = [
  { key: 'newListing', name: 'new-listing', forum: false, topic: 'Post photos + what the item is. The bot researches the price and sends it to Mom.' },
  { key: 'buyers', name: 'buyers', forum: true, topic: 'One thread per buyer. Type in a thread to reply to them.' },
  { key: 'sales', name: 'sales', forum: false, topic: 'Every sale.' },
  { key: 'toShip', name: 'to-ship', forum: false, topic: 'What to pack and where it goes. React 📦 when shipped.' },
  { key: 'botStatus', name: 'bot-status', forum: false, topic: 'Warnings when the bot needs you.' },
];

/** Decides which channels to reuse (matched by name) and which to create. */
export function planChannels(existing: { id: string; name: string; isForum: boolean }[]) {
  const found: Partial<Record<ChannelKey, string>> = {};
  const create: { key: ChannelKey; name: string; forum: boolean }[] = [];
  for (const spec of CHANNEL_SPECS) {
    const match = existing.find((c) => c.name === spec.name && c.isForum === spec.forum);
    if (match) {
      found[spec.key] = match.id;
      continue;
    }
    // A text channel already called "buyers" can't hold buyer threads; make the forum under another name.
    const clash = existing.some((c) => c.name === spec.name);
    create.push({ key: spec.key, name: clash && spec.forum ? 'buyer-threads' : spec.name, forum: spec.forum });
  }
  return { found, create };
}

/** View Channels, Send Messages, Send in Threads, Create Public Threads, Manage Threads, Manage Channels,
 *  Read Message History, Embed Links, Attach Files, Add Reactions. Never Administrator. */
const PERMISSIONS = [4n, 6n, 10n, 11n, 14n, 15n, 16n, 34n, 35n, 38n].reduce((acc, bit) => acc | (1n << bit), 0n);

export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: applicationId,
    scope: 'bot',
    permissions: PERMISSIONS.toString(),
  })}`;
}

/**
 * Fills in any channel or owner IDs left empty in .env: uses the bot's (single) Discord server, its owner as
 * the person the bot listens to, and finds or creates the five channels.
 */
export async function ensureDiscordSetup(client: Client<true>, cfg: Config): Promise<{ guild: Guild; created: string[] }> {
  const guild = client.guilds.cache.first();
  if (!guild) {
    throw new Error(`The bot isn't in a Discord server yet. Invite it with: ${inviteUrl(client.application.id)}`);
  }
  if (!cfg.ownerDiscordId) cfg.ownerDiscordId = guild.ownerId;

  const missingKeys = CHANNEL_SPECS.filter((s) => !cfg.channels[s.key]);
  const created: string[] = [];
  if (!missingKeys.length) return { guild, created };

  const channels = await guild.channels.fetch();
  const existing = [...channels.values()]
    .filter((c) => c !== null)
    .map((c) => ({ id: c!.id, name: c!.name, isForum: c!.type === ChannelType.GuildForum }));
  const plan = planChannels(existing);
  for (const spec of missingKeys) {
    const id = plan.found[spec.key];
    if (id) {
      cfg.channels[spec.key] = id;
      continue;
    }
    const toCreate = plan.create.find((c) => c.key === spec.key)!;
    const channel = await guild.channels.create({
      name: toCreate.name,
      type: toCreate.forum ? ChannelType.GuildForum : ChannelType.GuildText,
      topic: spec.topic,
    });
    cfg.channels[spec.key] = channel.id;
    created.push(`#${toCreate.name}`);
  }
  return { guild, created };
}
