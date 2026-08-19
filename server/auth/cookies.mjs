export const AUTH_SESSION_COOKIE = "rachie_peggie_session";
export const OAUTH_STATE_COOKIE = "rachie_peggie_oauth_state";

export function parseCookie(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, path?: string, secure?: boolean }} [options]
 */
export function serializeCookie(name, value, options = {}) {
  const { maxAge, path = "/", secure = false } = options;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (Number.isInteger(maxAge)) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function expireCookie(name, options = {}) {
  return serializeCookie(name, "", { ...options, maxAge: 0 });
}
