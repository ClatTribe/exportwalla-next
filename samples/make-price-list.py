"""Builds samples/04_price_list.xlsx: the fictional Agra leather-shoe exporter's price list, laid out the way small
factories keep one (a title row, then a header row, prices in rupees, HS codes in a column). Needs openpyxl:
../export-desk/.venv/bin/python samples/make-price-list.py"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "Price list 2026"
ws.append(["Yamuna Leathercraft Pvt Ltd, Agra: export price list, September 2026 (sample, fictional business)"])
ws["A1"].font = Font(bold=True)
ws.append([])
ws.append(["Item code", "Product", "HS code", "Material", "Ex-factory price (Rs)", "Unit", "Monthly capacity", "MOQ"])
for c in ws[3]:
    c.font = Font(bold=True)
rows = [
    ("YL-CB-01", "Men's Chelsea boots", "640391", "Full-grain cow leather, rubber sole", 2050, "pair", 1800, 300),
    ("YL-OX-02", "Men's Oxford shoes", "640399", "Leather upper, rubber sole", 1750, "pair", 1200, 300),
    ("YL-SD-03", "Women's leather sandals", "640359", "Leather upper and leather sole", 980, "pair", 900, 500),
    ("YL-BT-04", "Leather belts, 35 mm", "420330", "Buffalo leather, brass buckle", 560, "piece", 2500, 500),
    ("YL-WL-05", "Bifold leather wallets", "420232", "Goat leather", 640, "piece", 1500, 500),
]
for r in rows:
    ws.append(list(r))
for col, w in zip("ABCDEFGH", (11, 26, 10, 36, 20, 8, 17, 7)):
    ws.column_dimensions[col].width = w
out = Path(__file__).with_name("04_price_list.xlsx")
wb.save(out)
print(out.name, f"{out.stat().st_size / 1e6:.2f} MB")
