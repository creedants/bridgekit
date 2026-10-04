import type { Env } from "./env.ts";

/** Sends a plain-text email through Resend, or logs it when no key is set (local development). */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.log(`[email] to ${to}: ${subject}\n${text}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  if (!response.ok) throw new Error(`Email was not sent (${response.status}).`);
}
