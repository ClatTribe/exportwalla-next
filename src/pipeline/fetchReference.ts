// Before a build: make sure data/reference.db exists. Deploys upload data/reference.db.gz (26 MB) instead of the
// 119 MB database, which keeps the upload under the Hobby plan's CLI limit; this unpacks it. Failing that, it
// downloads REFERENCE_DB_URL (the .gz hosted anywhere). Does nothing when the database is already there.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dest = path.resolve(process.env.EXPORTWALLA_DATA ?? "data", "reference.db");
const packed = dest + ".gz";
const url = process.env.REFERENCE_DB_URL ?? "";

async function main() {
  if (fs.existsSync(dest)) return;
  let body: Buffer;
  if (fs.existsSync(packed)) {
    console.log("reference.db: unpacking reference.db.gz");
    body = zlib.gunzipSync(fs.readFileSync(packed));
  } else if (url) {
    console.log(`reference.db missing: downloading ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    body = url.endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
  } else {
    throw new Error("data/reference.db is missing: run `npm run data -- build-reference`, or set REFERENCE_DB_URL");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest + ".part", body);
  fs.renameSync(dest + ".part", dest);
  console.log(`reference.db: ${Math.round(fs.statSync(dest).size / 1e6)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
