export type Category = "restaurant" | "bar" | "food_truck" | "music_venue" | "popup";
export type Kind = "happy_hour" | "special" | "live_music" | "event" | "truck_stop" | "popup";

/** One row returned by the `happenings_near` RPC. */
export interface Happening {
  id: string;
  venue_id: string | null;
  venue_name: string | null;
  category: Category;
  kind: Kind;
  title: string;
  description: string | null;
  price_text: string | null;
  lat: number;
  lng: number;
  distance_m: number;
  occ_start: string;
  occ_end: string;
  is_live: boolean;
  address: string | null;
  neighborhood: string | null;
  website: string | null;
  source_url: string | null;
  last_verified_at: string;
  confidence: number;
  location_name: string | null;
}

/** Happenings grouped at one venue/location (one marker). */
export interface VenueGroup {
  key: string;
  lat: number;
  lng: number;
  category: Category;
  live: boolean;
  primary: Happening;
  items: Happening[];
}
