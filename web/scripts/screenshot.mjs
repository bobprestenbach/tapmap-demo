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

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({
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
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const target = flags.has("--mock") ? `${url}${url.includes("?") ? "&" : "?"}mock=1` : url;
await page.goto(target, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("goto:", e.message));
await page.waitForTimeout(6000);
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
