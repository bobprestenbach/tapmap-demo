import { describe, expect, it } from "vitest";
import {
  bboxContains,
  cityAt,
  cityCardView,
  citiesToGeoJSON,
  padBBox,
  phaseIndex,
  phaseLabel,
  pointInGeometry,
  requestReasonMessage,
  toleranceForZoom,
  tooltipText,
  type CityRow,
} from "@/lib/cities";

const square = (w: number, s: number, e: number, n: number): GeoJSON.MultiPolygon => ({
  type: "MultiPolygon",
  coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]],
});

const city = (over: Partial<CityRow>): CityRow => ({
  id: "1",
  name: "Test",
  kind: "city",
  status: "none",
  phase: null,
  allowed: true,
  hot: false,
  venue_count: 0,
  happening_count: 0,
  lat: 0.5,
  lng: 0.5,
  area_km2: 10,
  geojson: square(0, 0, 1, 1),
  ...over,
});

describe("toleranceForZoom", () => {
  it("gets finer as you zoom in", () => {
    expect(toleranceForZoom(7)).toBe(0.006);
    expect(toleranceForZoom(9)).toBe(0.003);
    expect(toleranceForZoom(11)).toBe(0.001);
    expect(toleranceForZoom(13.5)).toBe(0.0003);
    for (let z = 6; z < 16; z += 0.5) expect(toleranceForZoom(z + 0.5)).toBeLessThanOrEqual(toleranceForZoom(z));
  });
});

describe("bbox helpers", () => {
  it("pads and contains", () => {
    const b = padBBox([-91, 29, -90, 30], 0.25);
    expect(b).toEqual([-91.25, 28.75, -89.75, 30.25]);
    expect(bboxContains(b, [-91.1, 28.9, -89.9, 30.1])).toBe(true);
    expect(bboxContains(b, [-91.3, 28.9, -89.9, 30.1])).toBe(false);
  });
});

describe("cityCardView", () => {
  it("maps status + allowed to the card body", () => {
    expect(cityCardView({ status: "ready", allowed: true })).toBe("ready");
    expect(cityCardView({ status: "none", allowed: true })).toBe("load");
    expect(cityCardView({ status: "queued", allowed: true })).toBe("progress");
    expect(cityCardView({ status: "syncing", allowed: true })).toBe("progress");
    expect(cityCardView({ status: "error", allowed: true })).toBe("error");
    expect(cityCardView({ status: "none", allowed: false })).toBe("outside");
    expect(cityCardView({ status: "error", allowed: false })).toBe("outside");
  });
});

describe("phases", () => {
  it("labels each phase", () => {
    expect(phaseIndex("osm")).toBe(0);
    expect(phaseIndex("enrich")).toBe(1);
    expect(phaseIndex("events")).toBe(2);
    expect(phaseIndex("done")).toBe(3);
    expect(phaseIndex(null)).toBe(0);
    expect(phaseLabel("syncing", "osm")).toBe("Finding bars & restaurants");
    expect(phaseLabel("syncing", "enrich")).toBe("Filling in details");
    expect(phaseLabel("syncing", "events")).toBe("Pulling events");
    expect(phaseLabel("queued", "osm")).toBe("Getting started");
  });
});

describe("messages", () => {
  it("has friendly request reasons", () => {
    expect(requestReasonMessage("busy")).toMatch(/try again/i);
    expect(requestReasonMessage("budget")).toMatch(/month/i);
    expect(requestReasonMessage("retry_later")).toMatch(/few minutes/i);
    expect(requestReasonMessage("outside_area")).toMatch(/south of Monroe/);
    expect(requestReasonMessage(undefined)).toMatch(/try again/i);
  });
  it("builds hover tooltips", () => {
    expect(tooltipText({ name: "Lafayette", status: "ready", allowed: 1, venue_count: 412 })).toBe("Lafayette · Ready · 412 spots");
    expect(tooltipText({ name: "Lafayette", status: "ready", allowed: 1, venue_count: 0 })).toBe("Lafayette · Ready");
    expect(tooltipText({ name: "Hammond", status: "none", allowed: 1, venue_count: 0 })).toBe("Hammond · Tap to load");
    expect(tooltipText({ name: "Hammond", status: "syncing", allowed: true, venue_count: 3 })).toBe("Hammond · Loading…");
    expect(tooltipText({ name: "Monroe", status: "none", allowed: 0, venue_count: 0 })).toBe("Monroe · Outside coverage");
  });
});

describe("geometry", () => {
  it("point in polygon respects holes and multipolygons", () => {
    const g: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        [
          [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
          [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
        ],
        [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
      ],
    };
    expect(pointInGeometry(3, 3, g)).toBe(true);
    expect(pointInGeometry(1.5, 1.5, g)).toBe(false); // in the hole
    expect(pointInGeometry(10.5, 10.5, g)).toBe(true);
    expect(pointInGeometry(5, 5, g)).toBe(false);
  });
  it("cityAt picks the smallest containing city", () => {
    const big = city({ id: "big", area_km2: 100, geojson: square(0, 0, 10, 10) });
    const small = city({ id: "small", area_km2: 5, geojson: square(2, 2, 3, 3) });
    expect(cityAt([big, small], 2.5, 2.5)?.id).toBe("small");
    expect(cityAt([big, small], 8, 8)?.id).toBe("big");
    expect(cityAt([big, small], 20, 20)).toBeNull();
  });
  it("citiesToGeoJSON keeps ids in properties for promoteId", () => {
    const fc = citiesToGeoJSON([city({ id: "2232755", allowed: false })]);
    expect(fc.features[0].properties).toMatchObject({ id: "2232755", allowed: 0, status: "none" });
  });
});
