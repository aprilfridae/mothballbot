import type { Condition } from '../../ai/draftListing.js';

export interface CategoryCondition {
  conditionId: string;
  conditionDescription: string;
}

/** eBay condition IDs → Inventory API condition enums. */
const ENUM_BY_ID: Record<string, string> = {
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2750': 'LIKE_NEW',
  '2990': 'PRE_OWNED_EXCELLENT',
  '3000': 'USED_EXCELLENT',
  '3010': 'PRE_OWNED_FAIR',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
};

/**
 * Each category words its conditions differently (clothing: "Pre-owned - Good"; china: just "Used"), so match on
 * the category's own descriptions, best fit first.
 */
const PREFERENCES: Record<Condition, RegExp[]> = {
  NEW: [/^new( with (tags|box))?$/i, /^brand new$/i, /^new\b(?!.*(other|without|open|defect))/i],
  NEW_OTHER: [/new.*(other|without|open)/i, /^new\b/i],
  USED_EXCELLENT: [/excellent|like new/i, /very good/i, /(?<!very )good/i, /^(used|pre-?owned)$/i],
  USED_GOOD: [/(?<!very )\bgood\b/i, /very good/i, /^(used|pre-?owned)$/i, /excellent/i],
  USED_ACCEPTABLE: [/acceptable|fair/i, /(?<!very )\bgood\b/i, /^(used|pre-?owned)$/i],
};

export function chooseCondition(ours: Condition, allowed: CategoryCondition[] | null): string {
  const usable = (allowed ?? []).filter((c) => ENUM_BY_ID[c.conditionId] && !/parts|not working|refurb/i.test(c.conditionDescription));
  if (!usable.length) return ours;
  for (const pattern of PREFERENCES[ours]) {
    const hit = usable.find((c) => pattern.test(c.conditionDescription.trim()));
    if (hit) return ENUM_BY_ID[hit.conditionId];
  }
  const fallback = ours.startsWith('USED')
    ? usable.find((c) => /used|pre-?owned/i.test(c.conditionDescription))
    : usable.find((c) => /new/i.test(c.conditionDescription));
  return fallback ? ENUM_BY_ID[fallback.conditionId] : ours;
}
