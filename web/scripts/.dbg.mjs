import { chromium } from "playwright-core";
const proxyUrl = process.env.HTTPS_PROXY;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", proxy: { server: proxyUrl, bypass: "localhost,127.0.0.1" },
  args: (process.env.GLARGS||"--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist").split(" ") });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
const p = await ctx.newPage(); p.on("request", r => { if (!r.url().includes("_next")) console.log("[req]", r.url().replace(/key=[^&]+/,"key=***").slice(0,100)); }); p.on("requestfailed", r => console.log("[fail]", r.url().slice(0,80), r.failure()?.errorText));
p.on("console", (m) => console.log("[c]", m.type(), m.text().slice(0, 200)));
p.on("response", (r) => { console.log("[r]", r.status(), r.url().replace(/key=[^&]+/, "key=***").slice(0, 100)); });
await p.goto("http://localhost:3100/?mock=1&debug=1", { waitUntil: "networkidle" });
await p.waitForTimeout(15000);
console.log(await p.evaluate(() => { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); return gl ? gl.getParameter(gl.VERSION) : "no webgl"; }));
await b.close();
