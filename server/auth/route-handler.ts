import "server-only";

import {
  AUTH_SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  expireCookie,
  parseCookie,
  serializeCookie,
} from "./cookies.mjs";
import { getAuthSessionSecret, getDiscordOAuthConfig } from "./config";
import {
  createDiscordOAuthClient,
  DiscordOAuthError,
} from "./discord-oauth-client.mjs";
import { createAuthRepository } from "./repository";
import { resolveAuthRequestContext } from "./request-context";
import {
  AUTH_SESSION_LIFETIME_SECONDS,
  AuthenticationRejectedError,
  CommunitySelectionRejectedError,
  createAuthService,
  InvalidCsrfError,
  InvalidSessionError,
  OAUTH_STATE_LIFETIME_SECONDS,
} from "./service-core.mjs";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function configuredService(request: Request) {
  const context = resolveAuthRequestContext(request);
  if (!context) return null;
  const oauthConfig = getDiscordOAuthConfig(context.gameProfile);
  const repository = createAuthRepository(context.gameProfile);
  const sessionSecret = getAuthSessionSecret();
  if (!oauthConfig || !repository || !sessionSecret) return null;
  return {
    context,
    service: createAuthService({
      gameProfile: context.gameProfile,
      repository,
      discordClient: createDiscordOAuthClient(oauthConfig),
      sessionSecret,
    }),
  };
}

function cookieSecure() {
  return process.env.NODE_ENV === "production";
}

function requestOriginMatches(request: Request, hostname: string) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

async function readObjectBody(request: Request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function handleAuthLogin(request: Request): Promise<Response> {
  const configured = configuredService(request);
  if (!configured) return json({ error: "Authentication is unavailable." }, 503);
  try {
    const login = await configured.service.beginLogin();
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: login.authorizationUrl,
        "Set-Cookie": serializeCookie(OAUTH_STATE_COOKIE, login.state, {
          maxAge: OAUTH_STATE_LIFETIME_SECONDS,
          path: "/api/v1/auth/callback",
          secure: cookieSecure(),
        }),
      },
    });
  } catch {
    return json({ error: "Authentication is unavailable." }, 503);
  }
}

export async function handleAuthCallback(request: Request): Promise<Response> {
  const configured = configuredService(request);
  if (!configured) return json({ error: "Authentication is unavailable." }, 503);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = parseCookie(request, OAUTH_STATE_COOKIE);
  const clearState = expireCookie(OAUTH_STATE_COOKIE, {
    path: "/api/v1/auth/callback",
    secure: cookieSecure(),
  });

  try {
    const result = await configured.service.completeLogin({
      code,
      state,
      cookieState,
    });
    const headers = new Headers({
      "Cache-Control": "no-store",
      Location: "/booking",
    });
    headers.append("Set-Cookie", clearState);
    headers.append(
      "Set-Cookie",
      serializeCookie(AUTH_SESSION_COOKIE, result.sessionToken, {
        maxAge: AUTH_SESSION_LIFETIME_SECONDS,
        secure: cookieSecure(),
      }),
    );
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (error instanceof AuthenticationRejectedError) {
      return json(
        { error: "Authentication could not be completed." },
        400,
        { "Set-Cookie": clearState },
      );
    }
    if (error instanceof DiscordOAuthError) {
      return json(
        { error: "Discord authentication is temporarily unavailable." },
        502,
        { "Set-Cookie": clearState },
      );
    }
    return json(
      { error: "Authentication is unavailable." },
      503,
      { "Set-Cookie": clearState },
    );
  }
}

export async function handleAuthSession(request: Request): Promise<Response> {
  const configured = configuredService(request);
  if (!configured) return json({ error: "Authentication is unavailable." }, 503);
  try {
    return json(
      await configured.service.getSession(
        parseCookie(request, AUTH_SESSION_COOKIE),
      ),
    );
  } catch {
    return json({ error: "Authentication is unavailable." }, 503);
  }
}

export async function handleCommunitySelection(
  request: Request,
): Promise<Response> {
  const configured = configuredService(request);
  if (!configured) return json({ error: "Authentication is unavailable." }, 503);
  if (!requestOriginMatches(request, configured.context.hostname)) {
    return json({ error: "The request could not be verified." }, 403);
  }
  const body = await readObjectBody(request);
  if (!body) return json({ error: "A JSON object is required." }, 400);

  try {
    return json(
      await configured.service.selectCommunity({
        sessionToken: parseCookie(request, AUTH_SESSION_COOKIE),
        csrfToken: request.headers.get("x-csrf-token"),
        locationCode: body.locationCode,
      }),
    );
  } catch (error) {
    if (error instanceof InvalidSessionError) {
      return json({ error: error.message }, 401);
    }
    if (
      error instanceof InvalidCsrfError ||
      error instanceof CommunitySelectionRejectedError
    ) {
      return json({ error: error.message }, 403);
    }
    return json({ error: "Authentication is unavailable." }, 503);
  }
}

export async function handleAuthLogout(request: Request): Promise<Response> {
  const configured = configuredService(request);
  if (!configured) return json({ error: "Authentication is unavailable." }, 503);
  if (!requestOriginMatches(request, configured.context.hostname)) {
    return json({ error: "The request could not be verified." }, 403);
  }
  try {
    await configured.service.logout({
      sessionToken: parseCookie(request, AUTH_SESSION_COOKIE),
      csrfToken: request.headers.get("x-csrf-token"),
    });
    return json(
      { authenticated: false },
      200,
      {
        "Set-Cookie": expireCookie(AUTH_SESSION_COOKIE, {
          secure: cookieSecure(),
        }),
      },
    );
  } catch (error) {
    if (error instanceof InvalidSessionError) {
      return json({ error: error.message }, 401);
    }
    if (error instanceof InvalidCsrfError) {
      return json({ error: error.message }, 403);
    }
    return json({ error: "Authentication is unavailable." }, 503);
  }
}
