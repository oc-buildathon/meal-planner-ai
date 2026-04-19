import { createHmac } from "node:crypto";

/**
 * The identity Telegram embeds inside `Telegram.WebApp.initDataUnsafe.user`.
 * All fields other than `id` and `first_name` are optional.
 */
export interface TelegramWebAppUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
}

export type InitDataResult =
  | {
      ok: true;
      user: TelegramWebAppUser;
      authDate: Date;
      raw: Record<string, string>;
    }
  | { ok: false; reason: string };

/**
 * Validate the `initData` string Telegram Mini Apps hand the client so we
 * can trust `user.id` without the page being able to forge it.
 *
 * Algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
 *   check  = HMAC_SHA256(key=secret,       msg="\n".join(sorted("k=v" for k,v in data if k!="hash")))
 *   valid  = check == data["hash"]
 *
 * We additionally enforce `maxAgeSeconds` on `auth_date` to blunt replay.
 */
export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 60 * 60 * 24,
): InitDataResult {
  if (!initData) return { ok: false, reason: "empty initData" };
  if (!botToken) return { ok: false, reason: "bot token not configured" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  // Telegram spec: sorted "key=value" joined by newline — including "user"
  // as the raw URL-decoded JSON string, which URLSearchParams already gives us.
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  if (computed !== hash) {
    return { ok: false, reason: "hash mismatch" };
  }

  const authDateStr = params.get("auth_date");
  if (!authDateStr) return { ok: false, reason: "missing auth_date" };
  const authDate = new Date(parseInt(authDateStr, 10) * 1000);
  if (!isFinite(authDate.getTime())) {
    return { ok: false, reason: "invalid auth_date" };
  }
  const age = (Date.now() - authDate.getTime()) / 1000;
  if (age > maxAgeSeconds) {
    return { ok: false, reason: `stale initData (age=${age.toFixed(0)}s)` };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing user" };
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userRaw);
  } catch (e) {
    return { ok: false, reason: `user JSON parse: ${e}` };
  }
  if (typeof user?.id !== "number") {
    return { ok: false, reason: "user.id is not a number" };
  }

  const raw: Record<string, string> = {};
  for (const [k, v] of params.entries()) raw[k] = v;

  return { ok: true, user, authDate, raw };
}
