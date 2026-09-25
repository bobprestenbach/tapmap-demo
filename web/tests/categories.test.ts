import { describe, expect, it } from "vitest";
import { CATEGORIES, CHIP_ORDER, categoryFor, metaFor, toggleCategory } from "@/lib/categories";
import { findNeighborhood, groupByVenue, matchesQuery } from "@/lib/group";
import type { Happening } from "@/lib/types";

describe("categoryFor (mirrors SQL happening_category)", () => {
  it("maps kinds with fixed categories", () => {
    expect(categoryFor("live_music", "restaurant")).toBe("music_venue");
    expect(categoryFor("truck_stop", null)).toBe("food_truck");
    expect(categoryFor("popup", "bar")).toBe("popup");
  });
  it("events inherit venue category, else popup", () => {
    expect(categoryFor("event", "bar")).toBe("bar");
    expect(categoryFor("event", null)).toBe("popup");
  });
  it("happy hours / specials inherit venue category, else restaurant", () => {
    expect(categoryFor("happy_hour", "bar")).toBe("bar");
    expect(categoryFor("special", undefined)).toBe("restaurant");
    expect(categoryFor("special", "nonsense")).toBe("restaurant");
  });
});

describe("category metadata", () => {
  it("has the design colors and emoji", () => {
    expect(CATEGORIES.restaurant.color).toBe("#E040FB");
    expect(CATEGORIES.bar.color).toBe("#22D3EE");
    expect(CATEGORIES.food_truck.color).toBe("#F59E0B");
    expect(CATEGORIES.music_venue.color).toBe("#8B5CF6");
    expect(CATEGORIES.popup.color).toBe("#4ADE80");
    expect(CHIP_ORDER.map((c) => CATEGORIES[c].label)).toEqual(["Restaurants", "Food Trucks", "Bars", "Live Music", "Pop-Ups"]);
    expect(metaFor("unknown").id).toBe("popup");
  });
  it("toggles chips in display order", () => {
    expect(toggleCategory([], "bar")).toEqual(["bar"]);
    expect(toggleCategory(["bar"], "restaurant")).toEqual(["restaurant", "bar"]);
    expect(toggleCategory(["restaurant", "bar"], "bar")).toEqual(["restaurant"]);
  });
});

const base: Happening = {
  id: "1", venue_id: "v1", venue_name: "Carousel Bar", category: "bar", kind: "happy_hour", title: "Happy hour",
  description: "Half off", price_text: "$6", lat: 29.95, lng: -90.07, distance_m: 100,
  occ_start: "2026-09-25T21:00:00Z", occ_end: "2026-09-25T23:00:00Z", is_live: false, address: "214 Royal St",
  neighborhood: "French Quarter", website: null, source_url: null, last_verified_at: "2026-09-25T00:00:00Z",
  confidence: 0.8, location_name: null,
};

describe("grouping + search", () => {
  it("collapses a venue into one marker, live first", () => {
    const g = groupByVenue([base, { ...base, id: "2", is_live: true, title: "Trivia" }, { ...base, id: "3", venue_id: "v2" }]);
    expect(g).toHaveLength(2);
    const v1 = g.find((x) => x.key === "v1")!;
    expect(v1.items).toHaveLength(2);
    expect(v1.primary.id).toBe("2");
    expect(v1.live).toBe(true);
  });
  it("matches venue, title and neighborhood text", () => {
    expect(matchesQuery(base, "carousel")).toBe(true);
    expect(matchesQuery(base, "french quarter")).toBe(true);
    expect(matchesQuery(base, "royal half")).toBe(true);
    expect(matchesQuery(base, "bywater")).toBe(false);
  });
  it("finds neighborhoods by name/alias", () => {
    expect(findNeighborhood("marigny")?.name).toBe("Faubourg Marigny");
    expect(findNeighborhood("Bywater")?.name).toBe("Bywater");
    expect(findNeighborhood("zz")).toBeNull();
  });
});
