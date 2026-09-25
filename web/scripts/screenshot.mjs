// Screenshot the running app at 390x844. Usage:
//   node scripts/screenshot.mjs [url] [out.png] [--mock] [--click-first]
// Uses the preinstalled Chromium (PW_CHROMIUM or /opt/pw-browsers/chromium-*/chrome-linux/chrome).
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [url = "http://localhost:3100/", out = "screenshot-390.png"] = args.filter((a) => !a.startsWith("--"));

function findChromium() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = "/opt/pw-browsers";
  for (const d of readdirSync(base).filter((d) => /^chromium-\d+/.test(d))) {
    const p = `${base}/${d}/chrome-linux/chrome`;
    if (existsSync(p)) return p;
  }
  throw new Error("Chromium not found");
}

// In sandboxed CI the outbound proxy comes from HTTPS_PROXY; localhost bypasses it.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: findChromium(),
  ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: "localhost,127.0.0.1" } } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({
  serviceWorkers: process.env.SW === "1" ? "allow" : "block",
  ignoreHTTPSErrors: Boolean(proxyUrl), // proxy re-signs TLS with its own CA (screenshots only)
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 29.9512, longitude: -90.0668 },
  permissions: ["geolocation"],
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
});
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
page.on("requestfailed", (r) => console.log("[failed]", r.url().replace(/key=[^&]+/, "key=***").slice(0, 120), r.failure()?.errorText));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const target = `${url}${url.includes("?") ? "&" : "?"}debug=1${flags.has("--mock") ? "&mock=1" : ""}`;
await page.goto(target, { waitUntil: "load", timeout: 60000 }).catch((e) => console.log("goto:", e.message));
// Tiles come through a slow proxy in CI: wait for the map to go idle (max 60s).
await page
  .waitForFunction(() => { const m = window.__tmMap; return m && m.loaded() && m.areTilesLoaded(); }, null, { timeout: 60000, polling: 500 })
  .catch(() => console.log("map did not report idle in time"));
await page.waitForTimeout(2500);
if (flags.has("--click-first")) {
  await page.locator(".tm-marker").first().click({ force: true }).catch((e) => console.log("click:", e.message));
  await page.waitForTimeout(1500);
}
if (flags.has("--expand")) {
  await page.locator(".tm-sheet-grab").click().catch((e) => console.log("expand:", e.message));
  await page.waitForTimeout(1200);
}
const info = await page.evaluate(() => ({
  markers: document.querySelectorAll(".tm-marker").length,
  clusters: document.querySelectorAll(".tm-cluster").length,
  live: document.querySelector(".tm-live-pill")?.textContent,
  scrollW: document.documentElement.scrollWidth,
  canvas: !!document.querySelector("canvas.maplibregl-canvas"),
}));
console.log(JSON.stringify(info));
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
