// Builds the sample documents in this folder: a fictional Agra leather-shoe exporter, the same example the home page
// uses. Each file tests a different way of reading (see README.md). Run: node samples/make-samples.mjs
// (the price list is made by make-price-list.py). Uses the Chromium that the screen tests use.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const OUT = path.dirname(new URL(import.meta.url).pathname);

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (!fs.existsSync(cache)) return undefined;
  const shell = fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const exe = shell && path.join(cache, shell, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  return exe && fs.existsSync(exe) ? exe : undefined;
}

const CO = {
  name: "YAMUNA LEATHERCRAFT PRIVATE LIMITED", trade: "Yamuna Leathercraft",
  gstin: "09AAGCY4821M1ZS", pan: "AAGCY4821M", iec: "AAGCY4821M",
  address: "Plot 14, Foundry Nagar Industrial Area, Agra, Uttar Pradesh 282006",
  email: "exports@yamunaleathercraft.example", phone: "+91 98370 41122",
};
const NOTE = "Sample document for testing Exportwalla. Fictional business.";
const PAGE = `<style>@page{size:A4;margin:0}body{margin:0;font:13px/1.45 Arial,Helvetica,sans-serif;color:#111}
.a4{width:794px;min-height:1123px;box-sizing:border-box;padding:56px 60px;background:#fff;position:relative}
h1{font-size:18px;margin:0 0 4px;text-align:center}h2{font-size:14px;margin:0 0 18px;text-align:center;font-weight:normal}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#eee}.r{text-align:right}.foot{position:absolute;left:60px;right:60px;bottom:36px;font-size:10px;color:#666;border-top:1px solid #ccc;padding-top:6px}</style>`;

const gst = `${PAGE}<div class="a4">
<h1>Government of India</h1><h2>Form GST REG-06<br>[See Rule 10(1)]<br><b>Registration Certificate</b></h2>
<table>
<tr><td style="width:44%">Registration Number</td><td><b>${CO.gstin}</b></td></tr>
<tr><td>1. Legal Name</td><td>${CO.name}</td></tr>
<tr><td>2. Trade Name, if any</td><td>${CO.trade.toUpperCase()}</td></tr>
<tr><td>3. Constitution of Business</td><td>Private Limited Company</td></tr>
<tr><td>4. Address of Principal Place of Business</td><td>${CO.address}</td></tr>
<tr><td>5. Date of Liability</td><td>01/07/2017</td></tr>
<tr><td>6. Date of Validity</td><td>From 01/07/2017 To Not Applicable</td></tr>
<tr><td>7. Type of Registration</td><td>Regular</td></tr>
<tr><td>8. Particulars of Approving Authority</td><td>Centre: Range-II, Division Agra</td></tr>
</table>
<p style="margin-top:22px">Annexure B: Details of Managing / Authorized Partners</p>
<table><tr><th>Name</th><th>Designation</th><th>Resident of State</th></tr>
<tr><td>Rakesh Kumar Saxena</td><td>Director</td><td>Uttar Pradesh</td></tr>
<tr><td>Meera Saxena</td><td>Director</td><td>Uttar Pradesh</td></tr></table>
<p style="margin-top:22px">Date of issue of Certificate: 14/07/2017</p>
<div class="foot">${NOTE} Digitally signed layout imitated; not a real certificate.</div></div>`;

const iec = `${PAGE}<div class="a4" style="font-family:'Times New Roman',serif;font-size:15px">
<h1 style="font-size:20px">GOVERNMENT OF INDIA<br>MINISTRY OF COMMERCE AND INDUSTRY</h1>
<h2>Directorate General of Foreign Trade</h2>
<h1 style="margin:20px 0">IMPORTER-EXPORTER CODE (IEC)</h1>
<table style="font-size:15px">
<tr><td style="width:40%">IEC Number</td><td><b>${CO.iec}</b></td></tr>
<tr><td>PAN</td><td>${CO.pan}</td></tr>
<tr><td>Firm Name</td><td>${CO.name}</td></tr>
<tr><td>Address</td><td>${CO.address}</td></tr>
<tr><td>Nature of Concern</td><td>Private Limited Company</td></tr>
<tr><td>Category of Exporter</td><td>Manufacturer Exporter</td></tr>
<tr><td>Date of Issue</td><td>22/09/2018</td></tr>
<tr><td>Email</td><td>${CO.email}</td></tr>
<tr><td>Mobile</td><td>${CO.phone}</td></tr>
</table>
<p style="margin-top:28px">This IEC is valid until it is cancelled. Update it every year between April and June.</p>
<div class="foot">${NOTE}</div></div>`;

const lines = [
  ["1", "64039190", "Men's leather Chelsea boots, full-grain leather upper, rubber outer sole, covering the ankle", "1,200 PRS", "24.50", "29,400.00"],
  ["2", "64039990", "Men's leather Oxford shoes, leather upper, rubber outer sole, not covering the ankle", "800 PRS", "21.00", "16,800.00"],
  ["3", "42033000", "Leather belts, buffalo leather, 35 mm, brass buckle", "1,500 PCS", "6.80", "10,200.00"],
];
const invoice = `${PAGE}<div class="a4" style="padding:44px 50px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px">
<div><b style="font-size:17px">${CO.name}</b><br>${CO.address}<br>GSTIN: ${CO.gstin} &nbsp; IEC: ${CO.iec}<br>${CO.email} &nbsp; ${CO.phone}</div>
<div style="text-align:right"><b style="font-size:20px">COMMERCIAL INVOICE</b><br>Invoice No: YLC/EXP/2026/031<br>Date: 18-09-2026</div></div>
<table style="margin-top:12px">
<tr><td style="width:50%"><b>Consignee</b><br>Northgate Footwear Ltd<br>Unit 7, Abbey Park Road, Leicester LE4 5AQ<br>United Kingdom</td>
<td><b>Shipment</b><br>Port of Loading: ICD Agra / Nhava Sheva<br>Port of Discharge: Felixstowe, UK<br>Country of final destination: United Kingdom<br>Terms: FOB Nhava Sheva &nbsp; Currency: USD</td></tr></table>
<table style="margin-top:12px"><tr><th>Sr</th><th>HSN</th><th>Description of goods</th><th>Qty</th><th class="r">Rate USD</th><th class="r">Amount USD</th></tr>
${lines.map((l) => `<tr>${l.map((c, i) => `<td${i >= 4 ? ' class="r"' : ""}>${c}</td>`).join("")}</tr>`).join("")}
<tr><td colspan="5" class="r"><b>Total FOB</b></td><td class="r"><b>56,400.00</b></td></tr></table>
<p>Amount in words: US Dollars Fifty Six Thousand Four Hundred only.<br>Payment: 30% advance, 70% against documents (DP).<br>
Supply meant for export under LUT without payment of IGST. ARN: AD090626001234X</p>
<p style="margin-top:40px;text-align:right">For ${CO.name}<br><br><br>Authorised Signatory</p>
<div class="foot">${NOTE}</div></div>`;

async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });

  // 1. GST certificate: a PDF with a text layer, read directly
  await page.setContent(gst);
  await page.pdf({ path: path.join(OUT, "01_gst_certificate.pdf"), format: "A4", printBackground: true });

  // 2. IEC certificate, scanned: an image-only PDF (grey, slightly skewed, specks), so it needs OCR
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.setContent(iec);
  const scan = await page.screenshot({ type: "png", fullPage: true, scale: "device" });
  const specks = Array.from({ length: 260 }, (_, i) => `<i style="left:${(i * 73) % 794}px;top:${(i * 131) % 1123}px;opacity:${0.15 + (i % 5) * 0.08}"></i>`).join("");
  await page.setContent(`<style>@page{size:A4;margin:0}body{margin:0}.s{width:794px;height:1123px;overflow:hidden;position:relative;background:#f2f0ea}
    .s img{width:794px;transform:rotate(-0.8deg) translate(6px,4px);filter:grayscale(1) contrast(1.15) brightness(.97)}
    i{position:absolute;width:2px;height:2px;background:#555;border-radius:50%}</style>
    <div class="s"><img src="data:image/png;base64,${scan.toString("base64")}">${specks}</div>`);
  await page.pdf({ path: path.join(OUT, "02_iec_certificate_scanned.pdf"), format: "A4", printBackground: true });

  // 3. Invoice, phone photo: a large JPEG of the page on a desk, tilted, uneven light (over 1 MB, so the workspace shrinks it)
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.setContent(invoice);
  const inv = await page.screenshot({ type: "png", fullPage: true });
  const photo = await browser.newPage({ viewport: { width: 1000, height: 1333 }, deviceScaleFactor: 3 });
  await photo.setContent(`<style>body{margin:0;width:1000px;height:1333px;overflow:hidden;
    background:radial-gradient(900px 700px at 30% 20%,#b08a62,#6e4f33 70%,#4a3422)}
    .p{position:absolute;left:95px;top:80px;width:794px;transform:perspective(1600px) rotateX(4deg) rotate(1.8deg);
    box-shadow:0 30px 60px rgba(0,0,0,.45);filter:brightness(1.02) contrast(1.05) saturate(.9)}
    .l{position:absolute;inset:0;background:radial-gradient(700px 500px at 75% 15%,rgba(255,255,240,.28),transparent 60%),
    linear-gradient(160deg,transparent 55%,rgba(0,0,0,.18))}
    .g{position:absolute;inset:0;opacity:.4;mix-blend-mode:multiply}</style>
    <img class="p" src="data:image/png;base64,${inv.toString("base64")}"><div class="l"></div>
    <svg class="g" width="1000" height="1333"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="7"/></filter>
    <rect width="100%" height="100%" filter="url(#n)"/></svg>`);
  await photo.screenshot({ path: path.join(OUT, "03_invoice_phone_photo.jpg"), type: "jpeg", quality: 88 });

  // 4. Packing list as CSV, and 5. a WhatsApp-style note in Hinglish, as plain text
  fs.writeFileSync(path.join(OUT, "05_packing_list.csv"), [
    "Carton No,HS Code,Item,Qty,Unit,Net Wt (kg),Gross Wt (kg),Dimensions (cm)",
    "1-60,64039190,Men's leather Chelsea boots,1200,PRS,1080,1260,60x40x35",
    "61-100,64039990,Men's leather Oxford shoes,800,PRS,640,740,60x40x30",
    "101-115,42033000,Leather belts with brass buckle,1500,PCS,375,420,50x35x30",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "06_whatsapp_note.txt"),
    "Namaste, hum Agra se leather ke joote banate hain - Chelsea boots aur Oxford shoes, aur leather belts bhi.\n" +
    "Har mahine lagbhag 3000 pair. Boots ka rate Rs 2,050 per pair hai (factory se).\n" +
    "UK aur Europe mein bechna hai. GSTIN 09AAGCY4821M1ZS, IEC AAGCY4821M. Pehli baar export kar rahe hain.\n");
  await browser.close();
  for (const f of fs.readdirSync(OUT).filter((f) => /^\d\d_/.test(f)).sort()) {
    console.log(`${f.padEnd(32)} ${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2)} MB`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
