import { APIError } from "better-auth";
import type { Env } from "./env.ts";

/** On only when the value is exactly "on", the same strictness as ACCOUNTS. */
function localEmailLog(value: string | undefined): boolean {
  return value === "on";
}

/** The one sentence a refused sign-in or invitation answers with. */
export const EMAIL_NOT_SET_UP = "Email is not set up on this server.";

/**
 * Sends a plain-text email through Resend. With no key or sender it writes the
 * message to the log only when LOCAL_EMAIL_LOG is exactly "on". Without that
 * flag the deployment is production, so the send fails instead of reporting a
 * sign-in or invitation that never reaches the user and instead of leaving the
 * link in the Worker log.
 *
 * The Worker refuses a request that needs an email before Better Auth runs, so
 * this failure is the backstop. Better Auth's magic-link route awaits the send
 * and answers the thrown APIError with the sentence above as a plain 503. Its
 * invitation route runs the send in a background helper that catches the
 * rejection, logs it, and answers 200 with a pending invitation, so a plain
 * Error and an APIError both disappear there.
 */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    if (!localEmailLog(env.LOCAL_EMAIL_LOG)) throw new APIError("SERVICE_UNAVAILABLE", { message: EMAIL_NOT_SET_UP });
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

/** Whether this deployment can put an email in front of someone, by Resend or by logging it locally. */
export function canSendEmail(env: Env): boolean {
  return (Boolean(env.RESEND_API_KEY) && Boolean(env.EMAIL_FROM)) || localEmailLog(env.LOCAL_EMAIL_LOG);
}
