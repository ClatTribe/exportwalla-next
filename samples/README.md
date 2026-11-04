# Sample documents

A fictional Agra leather-shoe exporter, Yamuna Leathercraft Pvt Ltd (the home page's example product). Upload them
at http://localhost:3000/app (all six at once is about 2.2 MB, under the 4 MB limit). Nothing here is a real business;
the GSTIN passes the official check digit, so the app treats it as well-formed.

| File | Tests | What comes out without AI |
|---|---|---|
| `01_gst_certificate.pdf` | PDF with a text layer; form labels without colons | Name, GSTIN 09AAGCY4821M1ZS, address, Agra, Uttar Pradesh |
| `02_iec_certificate_scanned.pdf` | Scanned PDF, no text layer: needs OCR | Name, IEC AAGCY4821M, phone, email |
| `03_invoice_phone_photo.jpg` | Phone photo (1.8 MB, tilted, grain): OCR, the browser shrinking photos over 1 MB, HS codes on their own lines | GSTIN, IEC, buyer country UK, three products with 8-digit HS codes |
| `04_price_list.xlsx` | Spreadsheet with a title row above the header, an "Item code" column beside "Product" | Five products with HS code, rupee price, monthly capacity, MOQ |
| `05_packing_list.csv` | CSV, marked as a packing list | Three products with HS codes |
| `06_whatsapp_note.txt` | Hinglish note | GSTIN, IEC, "Boots" at Rs 2,050 a pair, 3,000 a month |

The same product from two files ("Men's leather Chelsea boots" on the invoice, "Men's Chelsea boots" in the price list)
shows up twice; products are merged only when the names match exactly.

OCR runs only on a Mac (macOS Vision, `tools/ocr`). On Vercel, photos and scanned PDFs are read only when an AI key
(`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`) is set; text PDFs, spreadsheets, CSV and text work either way.

Rebuild: `node samples/make-samples.mjs` and `../export-desk/.venv/bin/python samples/make-price-list.py`.
