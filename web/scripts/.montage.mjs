import sharp from "sharp";
const [out, ...files] = process.argv.slice(2);
const w = 390, h = 844;
const bufs = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
await sharp({ create: { width: (w + 10) * files.length, height: h, channels: 3, background: "#fff" } })
  .composite(bufs.map((b, i) => ({ input: b, left: i * (w + 10), top: 0 })))
  .png().toFile(out);
