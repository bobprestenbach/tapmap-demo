import type { Category, Kind } from "./types";

export interface CategoryMeta {
  id: Category;
  label: string;
  emoji: string;
  color: string;
}

export const CATEGORIES: Record<Category, CategoryMeta> = {
  restaurant: { id: "restaurant", label: "Restaurants", emoji: "🍽️", color: "#E040FB" },
  food_truck: { id: "food_truck", label: "Food Trucks", emoji: "🚚", color: "#F59E0B" },
  bar: { id: "bar", label: "Bars", emoji: "🍸", color: "#22D3EE" },
  music_venue: { id: "music_venue", label: "Live Music", emoji: "🎷", color: "#8B5CF6" },
  popup: { id: "popup", label: "Pop-Ups", emoji: "✨", color: "#4ADE80" },
};

/** Chip order as in the design reference. */
export const CHIP_ORDER: Category[] = ["restaurant", "food_truck", "bar", "music_venue", "popup"];

export const LIVE_COLOR = "#4ADE80";

const ALL = new Set<string>(Object.keys(CATEGORIES));

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && ALL.has(v);
}

/** Mirrors SQL public.happening_category(kind, venue_category). */
export function categoryFor(kind: Kind | string, venueCategory: string | null | undefined): Category {
  if (kind === "live_music") return "music_venue";
  if (kind === "truck_stop") return "food_truck";
  if (kind === "popup") return "popup";
  const vc = isCategory(venueCategory) ? venueCategory : null;
  if (kind === "event") return vc ?? "popup";
  return vc ?? "restaurant";
}

export function metaFor(category: string): CategoryMeta {
  return isCategory(category) ? CATEGORIES[category] : CATEGORIES.popup;
}

export const KIND_LABEL: Record<Kind, string> = {
  happy_hour: "Happy hour",
  special: "Special",
  live_music: "Live music",
  event: "Event",
  truck_stop: "Truck stop",
  popup: "Pop-up",
};

/** Toggle a category in a selection list (returns a new array in chip order). */
export function toggleCategory(selected: Category[], c: Category): Category[] {
  const set = new Set(selected);
  if (set.has(c)) set.delete(c);
  else set.add(c);
  return CHIP_ORDER.filter((x) => set.has(x));
}
