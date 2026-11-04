// The lead email, built offline with nodemailer's stream transport: who it goes to, the reply-to, the subject cut at
// 150 characters, and the TLS mode per port (465 is TLS from the start, anything else must offer STARTTLS).
import nodemailer from "nodemailer";
import { afterEach, describe, expect, test } from "vitest";
import { leadMail, sendEmail } from "../src/lib/server/lead";

const KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PORT", "SMTP_FROM", "LEAD_EMAIL_TO", "CONTACT_EMAIL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

function configure(extra: Record<string, string> = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { SMTP_HOST: "smtp.example.com", SMTP_USER: "desk@example.com", SMTP_PASSWORD: "app-password",
    CONTACT_EMAIL: "hello@example.com" }, extra);
}

async function raw(mail: NonNullable<ReturnType<typeof leadMail>>): Promise<string> {
  const info = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail.message);
  return (info.message as Buffer).toString();
}

describe("lead email", () => {
  test("off unless host, user, password and a recipient are all set", async () => {
    for (const k of KEYS) delete process.env[k];
    expect(leadMail("s", "b", null)).toBeNull();
    expect(await sendEmail("s", "b", null)).toBe(false);
    configure({ CONTACT_EMAIL: "" });
    expect(leadMail("s", "b", null)).toBeNull();
  });

  test("goes to CONTACT_EMAIL from the SMTP user, replies go to the customer", async () => {
    configure();
    const mail = leadMail("Exportwalla lead: Asha, cumin → ARE", "name: Asha\nwhatsapp_ok: True", "asha@example.in")!;
    expect(mail.transport).toMatchObject({ host: "smtp.example.com", port: 587, secure: false, requireTLS: true });
    const msg = await raw(mail);
    expect(msg).toMatch(/^To: hello@example\.com$/m);
    expect(msg).toMatch(/^From: desk@example\.com$/m);
    expect(msg).toMatch(/^Reply-To: asha@example\.in$/m);
    expect(msg).toMatch(/^Subject: =\?UTF-8\?/m); // the arrow needs encoding
    expect(msg).toContain("whatsapp_ok: True");
  });

  test("LEAD_EMAIL_TO and SMTP_FROM win; port 465 is TLS from the start; long subjects are cut", async () => {
    configure({ LEAD_EMAIL_TO: "sales@example.com", SMTP_FROM: "Exportwalla <noreply@example.com>", SMTP_PORT: "465" });
    const mail = leadMail("x".repeat(200), "body", null)!;
    expect(mail.transport).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(mail.message.subject).toHaveLength(150);
    const msg = await raw(mail);
    expect(msg).toMatch(/^To: sales@example\.com$/m);
    expect(msg).toMatch(/^From: Exportwalla <noreply@example\.com>$/m);
    expect(msg).not.toMatch(/^Reply-To:/m);
  });
});
