import "server-only";

import { getAuthSessionSecret } from "./config";
import { AUTH_SESSION_COOKIE, parseCookie } from "./cookies.mjs";
import { hashOpaqueToken, safelyEqual, verifyCsrfToken } from "./crypto.mjs";
interface TrustedMutationSessionContext {
  readonly hostname: string;
  readonly gameProfile: "wos" | "kingshot";
  readonly session: { readonly tokenHash: string };
}

export function verifyAuthenticatedMutationCsrf(
  request: Request,
  context: TrustedMutationSessionContext,
): boolean {
  const sessionToken = parseCookie(request, AUTH_SESSION_COOKIE);
  const secret = getAuthSessionSecret();
  const csrfToken = request.headers.get("x-csrf-token");
  if (!sessionToken || !secret) return false;
  if (!safelyEqual(hashOpaqueToken(sessionToken), context.session.tokenHash)) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).hostname.toLowerCase() !== context.hostname) return false;
    } catch {
      return false;
    }
  }

  return verifyCsrfToken(
    csrfToken,
    sessionToken,
    context.gameProfile,
    secret,
  );
}
