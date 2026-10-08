export type CalendarColorProvider = "google" | "microsoft";

type CalendarColorItem = { id: string; color?: string };
type CalendarColorAccount<Item extends CalendarColorItem = CalendarColorItem> = {
  provider: CalendarColorProvider;
  accountId: string;
  colorKey?: string;
  items: Item[];
};

function normalizedHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : undefined;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function hslToHex(hue: number, saturation = 68, lightness = 44): string {
  const s = saturation / 100, l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs(section % 2 - 1));
  const [r1, g1, b1] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
    : section < 3 ? [0, chroma, x]
    : section < 4 ? [0, x, chroma]
    : section < 5 ? [x, 0, chroma]
    : [chroma, 0, x];
  const match = l - chroma / 2;
  return `#${[r1, g1, b1].map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function identity(account: CalendarColorAccount, item: CalendarColorItem): string {
  return `${account.provider}:${account.accountId}:${item.id}`;
}

/**
 * Keeps a provider color when it is unique. Missing or duplicated colors are
 * replaced with a deterministic color derived from the full account/calendar
 * identity, so two accounts with the same provider defaults remain distinct.
 */
export function resolveCalendarAccountColors<
  Item extends CalendarColorItem,
  Account extends CalendarColorAccount<Item>,
>(accounts: readonly Account[]): Account[] {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    for (const item of account.items) {
      const color = normalizedHex(item.color);
      if (color) counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }

  const reserved = new Set([...counts].filter(([, count]) => count === 1).map(([color]) => color));
  const derived = new Map<string, string>();
  const unresolved = accounts.flatMap(account => account.items
    .filter(item => {
      const color = normalizedHex(item.color);
      return !color || counts.get(color)! > 1;
    })
    .map(item => ({ account, item, key: identity(account, item) })))
    .sort((left, right) => left.key.localeCompare(right.key));

  for (const entry of unresolved) {
    let attempt = 0, color = "";
    do {
      const hue = (hash(`${entry.key}:${attempt}`) + attempt * 47) % 360;
      color = hslToHex(hue);
      attempt += 1;
    } while (reserved.has(color));
    reserved.add(color);
    derived.set(entry.key, color);
  }

  return accounts.map(account => ({
    ...account,
    items: account.items.map(item => {
      const providerColor = normalizedHex(item.color);
      const color = providerColor && counts.get(providerColor) === 1
        ? providerColor
        : derived.get(identity(account, item));
      return { ...item, ...(color ? { color } : {}) };
    }),
  })) as Account[];
}

export function calendarColorStyle(color: unknown) {
  const accent = normalizedHex(color);
  return accent ? {
    borderLeftColor: accent,
    backgroundColor: `color-mix(in srgb, ${accent} 24%, var(--surface))`,
    color: "var(--ink)",
  } : undefined;
}
