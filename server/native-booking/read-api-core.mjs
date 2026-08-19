import {
  AuthenticatedBookingHostNotFoundError,
  BookingAuthenticationRequiredError,
  BookingCommunitySelectionRequiredError,
  BookingMembershipRefreshRequiredError,
} from "../auth/authenticated-booking-context-core.mjs";
import {
  NativeBookingCommunityNotFoundError,
  NativeBookingParticipantAmbiguousError,
  NativeBookingServiceNotFoundError,
} from "./read-service-core.mjs";
import { isKnownMinisterServiceCode } from "./service-codes.mjs";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });

function errorResponse(status, error, code, headers = {}) {
  return Response.json(
    { ok: false, error, code },
    { status, headers: { ...NO_STORE_HEADERS, ...headers } },
  );
}

function publicBrand(brand) {
  return {
    displayName: brand.displayName,
    shortName: brand.shortName,
    description: brand.description,
    gameName: brand.game.name,
    gameProfile: brand.game.profile,
    theme: { id: brand.theme.id, accent: brand.theme.colors.accent },
  };
}

function contextResolutionError(error) {
  if (error instanceof AuthenticatedBookingHostNotFoundError) {
    return errorResponse(404, "Native booking context not found.", "not_found");
  }
  if (error instanceof BookingAuthenticationRequiredError) {
    return errorResponse(401, "Authentication is required.", "authentication_required");
  }
  if (error instanceof BookingMembershipRefreshRequiredError) {
    return errorResponse(
      401,
      "Discord membership must be refreshed by signing in again.",
      "membership_refresh_required",
    );
  }
  if (error instanceof BookingCommunitySelectionRequiredError) {
    return errorResponse(
      409,
      "A verified booking community must be selected.",
      "community_selection_required",
    );
  }
  return errorResponse(503, "Native booking data is unavailable.", "unavailable");
}

async function createServiceForRequest(request, dependencies) {
  let context;
  try {
    context = await dependencies.resolveAuthenticatedContext(request);
  } catch (error) {
    return { error: contextResolutionError(error) };
  }

  try {
    const limit = await dependencies.consumeReadRateLimit(
      context.gameProfile,
      context.session.tokenHash,
    );
    if (!limit.allowed) {
      return {
        error: errorResponse(
          429,
          "Too many requests.",
          "rate_limited",
          { "Retry-After": String(limit.retryAfterSeconds) },
        ),
      };
    }
  } catch {
    return {
      error: errorResponse(503, "Native booking data is unavailable.", "unavailable"),
    };
  }

  const repository = dependencies.createRepository(context.gameProfile);
  if (!repository) {
    return {
      error: errorResponse(503, "Native booking data is unavailable.", "unavailable"),
    };
  }
  try {
    return {
      context,
      service: dependencies.createReadService(context, repository),
    };
  } catch {
    return {
      error: errorResponse(503, "Native booking data is unavailable.", "unavailable"),
    };
  }
}

function controlledReadError(error) {
  if (error instanceof NativeBookingCommunityNotFoundError) {
    return errorResponse(404, "Native booking community not found.", "community_not_found");
  }
  if (error instanceof NativeBookingServiceNotFoundError) {
    return errorResponse(404, "Native booking service not found.", "service_not_found");
  }
  if (error instanceof NativeBookingParticipantAmbiguousError) {
    return errorResponse(
      409,
      "Participant registration could not be resolved safely.",
      "participant_ambiguous",
    );
  }
  return errorResponse(503, "Native booking data is unavailable.", "unavailable");
}

export function createNativeBookingReadApi(dependencies) {
  return Object.freeze({
    async context(request) {
      const resolved = await createServiceForRequest(request, dependencies);
      if (resolved.error) return resolved.error;
      try {
        const bookingContext = await resolved.service.getContext();
        return Response.json(
          { brand: publicBrand(resolved.context.brand), ...bookingContext },
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return controlledReadError(error);
      }
    },

    async availability(request) {
      const resolved = await createServiceForRequest(request, dependencies);
      if (resolved.error) return resolved.error;
      const serviceCode = new URL(request.url).searchParams.get("service");
      if (!isKnownMinisterServiceCode(serviceCode)) {
        return errorResponse(400, "Invalid minister service code.", "invalid_service");
      }
      try {
        return Response.json(
          await resolved.service.getAvailability(serviceCode),
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return controlledReadError(error);
      }
    },

    async me(request) {
      const resolved = await createServiceForRequest(request, dependencies);
      if (resolved.error) return resolved.error;
      try {
        const summary =
          await resolved.service.getParticipantBookingsForDiscordUser(
            resolved.context.discordUser.id,
          );
        return Response.json(
          {
            community: {
              locationCode: resolved.context.community.locationCode,
              displayName: resolved.context.community.displayName,
            },
            ...summary,
          },
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return controlledReadError(error);
      }
    },
  });
}
