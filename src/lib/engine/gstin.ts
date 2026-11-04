// GSTIN format and check-digit validation (port of check_gstin in export-desk/app/intake.py).

export const STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir", "03": "Punjab", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "19": "West Bengal", "23": "Madhya Pradesh",
  "24": "Gujarat", "27": "Maharashtra", "29": "Karnataka", "32": "Kerala", "33": "Tamil Nadu",
  "36": "Telangana", "37": "Andhra Pradesh",
};
const GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** [ok, message, state] */
export function checkGstin(gstin: string | null | undefined): [boolean, string, string | null] {
  const g = (gstin || "").trim().toUpperCase();
  if (!g) return [false, "missing", null];
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return [false, "should be 15 characters, like 09ABCDE1234F1Z5", null];
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const prod = GST_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    total += Math.floor(prod / 36) + (prod % 36);
  }
  const check = GST_CHARS[(36 - (total % 36)) % 36];
  const state = STATE_CODES[g.slice(0, 2)] ?? `state code ${g.slice(0, 2)}`;
  if (check !== g[14]) return [false, "doesn't pass the official check: please re-check the 15 characters", state];
  return [true, "valid", state];
}
