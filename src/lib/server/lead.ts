// Someone asks the desk for help. Delivered by email (SMTP_*) and/or LEAD_WEBHOOK_URL (Google Sheet, Slack, CRM);
// kept in the local development database when neither is set. Port of /api/lead in export-desk/app/main.py.
import nodemailer from "nodemailer";
import { contactEmail, deskPhone, readonly } from "../config";
import { S, cpSlice, pyStrip } from "../py";
import { field, HttpError, nowIso, objectBody, pyLen } from "./http";
import { localDb } from "./local";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EMAIL_RE = new RegExp(`^[^@${S}]+@[^@${S}]+\\.[a-z]{2,}$`, "iu");
const STR_FIELDS = ["name", "phone", "email", "city", "product", "country", "message", "step", "page"];

/** Python's str() of a value, as it appears in the plain-text email ("True", not "true"). */
const pyStr = (v: unknown) => (typeof v === "boolean" ? (v ? "True" : "False") : String(v));

export async function lead(body: unknown): Promise<Json> {
  const b = objectBody(body);
  const req: Json = {};
  for (const k of STR_FIELDS) req[k] = field<string>(b, k, "str", k === "name" ? {} : { default: "" });
  req.whatsapp_ok = field<boolean>(b, "whatsapp_ok", "bool", { default: true });
  req.source = field<string>(b, "source", "str", { default: "" });
  const website = field<string>(b, "website", "str", { default: "" }); // honeypot: hidden from people, filled in by bots
  const done = (saved: boolean) => ({ ok: true, saved, desk_phone: deskPhone(), contact_email: contactEmail() });
  if (pyStrip(website)) return done(true);

  const digits = req.phone.replace(/\P{Nd}/gu, "");
  const email = pyStrip(req.email);
  if (pyLen(pyStrip(req.name)) < 2 || !(pyLen(digits) >= 10 || EMAIL_RE.test(email))) {
    throw new HttpError(400, "Please add your name and a 10-digit mobile number or an email address.");
  }
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, "That email address does not look right.");

  const payload: Json = { ...req, phone: cpSlice(pyStrip(req.phone), 0, 20), email: cpSlice(email, 0, 120), received_at: nowIso() };
  for (const [k, v] of Object.entries(payload)) if (typeof v === "string") payload[k] = cpSlice(v, 0, 1000);
  const subject = `Exportwalla lead: ${payload.name}` + (payload.product ? `, ${payload.product}` : "") +
    (payload.country ? ` → ${payload.country}` : "");
  const lines = Object.entries(payload).filter(([, v]) => v !== "" && v !== null).map(([k, v]) => `${k}: ${pyStr(v)}`);

  let sent = await forward("LEAD_WEBHOOK_URL", payload, `${subject} (${payload.phone || payload.email})`);
  sent = (await sendEmail(subject, lines.join("\n"), email || null)) || sent;
  if (!sent && !readonly()) {
    localDb().prepare("INSERT INTO lead (created_at, data) VALUES (?, ?)").run(nowIso(), JSON.stringify(payload));
    sent = true;
  }
  if (!sent) console.log("LEAD NOT DELIVERED (set SMTP_* or LEAD_WEBHOOK_URL):", JSON.stringify(payload));
  return done(sent);
}

/** The email for a lead, or null when SMTP is not configured. Separate from sending so tests can check it. */
export function leadMail(subject: string, text: string, replyTo: string | null) {
  const env = process.env;
  const host = env.SMTP_HOST ?? "", user = env.SMTP_USER ?? "", pass = env.SMTP_PASSWORD ?? "";
  const to = env.LEAD_EMAIL_TO || contactEmail();
  if (!(host && user && pass && to)) return null;
  const port = Number(env.SMTP_PORT || "587");
  return {
    transport: { host, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 },
    message: { subject: cpSlice(subject, 0, 150), from: env.SMTP_FROM || user, to, text, ...(replyTo ? { replyTo } : {}) },
  };
}

/** Plain-text email through any SMTP mailbox (Gmail or Workspace with an app password, Zoho, Outlook, a relay). Port
 * 465 is TLS from the start; any other port must offer STARTTLS. Goes to LEAD_EMAIL_TO, else CONTACT_EMAIL. */
export async function sendEmail(subject: string, text: string, replyTo: string | null): Promise<boolean> {
  const mail = leadMail(subject, text, replyTo);
  if (!mail) return false;
  try {
    await nodemailer.createTransport(mail.transport).sendMail(mail.message);
    return true;
  } catch (e) {
    console.log(`lead email failed: ${e}`);
    return false;
  }
}

/** POSTs JSON to a webhook named by an env var. Slack-style hooks also get a `text` field. */
export async function forward(env: string, payload: Json, text: string): Promise<boolean> {
  const url = process.env[env] ?? "";
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...payload }), signal: AbortSignal.timeout(8000) });
    return r.status < 300;
  } catch (e) {
    console.log(`${env} failed: ${e}`);
    return false;
  }
}
