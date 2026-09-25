// City-outline screenshots (mobile 390x844 + desktop 1280x800). Usage:
//   node scripts/screenshot-cities.mjs [baseUrl] [outDir] [--mock]
// Shots: NOLA default, zoomed-out Louisiana, desktop hover tooltip, mobile city card (tap, no "Load" click).
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [base = "http://localhost:3100/", outDir = "../docs/design"] = args.filter((a) => !a.startsWith("--"));
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");

function findChromium() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const dir = "/opt/pw-browsers";
  for (const d of readdirSync(dir).filter((d) => /^chromium-\d+/.test(d))) {
    const p = `${dir}/${d}/chrome-linux/chrome`;
    if (existsSync(p)) return p;
  }
  throw new Error("Chromium not found");
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: findChromium(),
  ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: "localhost,127.0.0.1" } } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

const MOBILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
};
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };

async function open(device) {
  const ctx = await browser.newContext({
    ...device,
    serviceWorkers: "block",
    ignoreHTTPSErrors: Boolean(proxyUrl),
    geolocation: { latitude: 29.9512, longitude: -90.0668 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const url = `${base}${base.includes("?") ? "&" : "?"}debug=1${flags.has("--mock") ? "&mock=1" : ""}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(url, { waitUntil: "load", timeout: 60000 }).catch((e) => console.log("goto:", e.message));
    const ok = await page
      .waitForFunction(() => window.__tmMap?.loaded() && window.__tmMap.getSource("tm-cities"), null, { timeout: 45000, polling: 500 })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    console.log(`attempt ${attempt}: map not ready`);
  }
  return { ctx, page };
}

async function settle(page, { cities = true } = {}) {
  await page
    .waitForFunction(
      (cities) => {
        const m = window.__tmMap;
        if (!m || !m.loaded() || !m.areTilesLoaded()) return false;
        return !cities || m.querySourceFeatures("tm-cities").length > 0;
      },
      cities,
      { timeout: 45000, polling: 500 },
    )
    .catch(() => console.log("settle: timeout"));
  await page.waitForTimeout(2000);
}

async function jump(page, lat, lng, zoom) {
  await page.evaluate(([lat, lng, zoom]) => window.__tmMap.jumpTo({ center: [lng, lat], zoom }), [lat, lng, zoom]);
  await page.waitForTimeout(900); // debounce + fetch
  await settle(page);
}

async function project(page, lat, lng) {
  return page.evaluate(([lat, lng]) => window.__tmMap.project([lng, lat]), [lat, lng]);
}

const shots = {
  async nola() {
    const { ctx, page } = await open(MOBILE);
    await page
      .waitForFunction(() => document.querySelectorAll(".tm-marker,.tm-cluster").length > 0, null, { timeout: 30000 })
      .catch(() => console.log("no markers"));
    await settle(page, { cities: false });
    await page.screenshot({ path: `${outDir}/cities-nola-390.png` });
    await ctx.close();
  },
  async louisiana() {
    const { ctx, page } = await open(MOBILE);
    await jump(page, 30.55, -91.6, 7);
    console.log("features:", await page.evaluate(() => window.__tmMap.querySourceFeatures("tm-cities").length));
    await page.screenshot({ path: `${outDir}/cities-louisiana-390.png` });
    await ctx.close();
    const d = await open(DESKTOP);
    await jump(d.page, 30.75, -91.5, 7.4);
    await d.page.screenshot({ path: `${outDir}/cities-louisiana-1280.png` });
    await d.ctx.close();
  },
  async hover() {
    const { ctx, page } = await open(DESKTOP);
    await jump(page, 30.25, -91.6, 9);
    const p = await project(page, 30.2, -92.03); // Lafayette
    await page.mouse.move(p.x - 30, p.y - 30);
    await page.mouse.move(p.x, p.y, { steps: 5 });
    await page.waitForTimeout(600);
    console.log("tooltip:", await page.evaluate(() => document.querySelector(".tm-city-tip")?.textContent));
    await page.screenshot({ path: `${outDir}/cities-hover-1280.png` });
    await ctx.close();
  },
  async card() {
    const { ctx, page } = await open(MOBILE);
    await jump(page, 30.12, -92.03, 10);
    const p = await project(page, 30.2, -92.03);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForSelector(".tm-city", { timeout: 10000 }).catch(() => console.log("no city card"));
    await page.waitForTimeout(1500);
    console.log("card:", await page.evaluate(() => document.querySelector(".tm-city")?.innerText.replace(/\n+/g, " | ")));
    await page.screenshot({ path: `${outDir}/cities-card-390.png` });
    await ctx.close();
  },
};

for (const [name, fn] of Object.entries(shots)) {
  if (only && !only.includes(name)) continue;
  console.log("==", name);
  await fn().catch((e) => console.log(name, "failed:", e.message));
}
await browser.close();
