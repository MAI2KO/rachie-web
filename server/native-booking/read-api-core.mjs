import {
  NativeBookingCommunityNotFoundError,
  NativeBookingServiceNotFoundError,
} from "./read-service-core.mjs";
import { isKnownMinisterServiceCode } from "./service-codes.mjs";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });

function errorResponse(status, error) {
  return Response.json({ ok: false, error }, { status, headers: NO_STORE_HEADERS });
}

function publicBrand(brand) {
  return {
    displayName: brand.displayName,
    shortName: brand.shortName,
    description: brand.description,
    gameName: brand.game.name,
    gameProfile: brand.game.profile,
    theme: {
      id: brand.theme.id,
      accent: brand.theme.colors.accent,
    },
  };
}

function createServiceForRequest(request, dependencies) {
  const context = dependencies.resolveRequestContext(request);
  if (!context) {
    return {
      error: errorResponse(404, "Native booking context not found."),
    };
  }
  if (!context.communityLocationCode) {
    return {
      error: errorResponse(
        404,
        "Native booking community is not configured for this host.",
      ),
    };
  }

  const repository = dependencies.createRepository(context.gameProfile);
  if (!repository) {
    return {
      error: errorResponse(503, "Native booking data is unavailable."),
    };
  }

  return {
    context,
    service: dependencies.createReadService(
      context.gameProfile,
      context.communityLocationCode,
      repository,
    ),
  };
}

function controlledReadError(error) {
  if (error instanceof NativeBookingCommunityNotFoundError) {
    return errorResponse(404, "Native booking community not found.");
  }
  if (error instanceof NativeBookingServiceNotFoundError) {
    return errorResponse(404, "Native booking service not found.");
  }
  return errorResponse(503, "Native booking data is unavailable.");
}

export function createNativeBookingReadApi(dependencies) {
  return Object.freeze({
    async context(request) {
      let resolved;
      try {
        resolved = createServiceForRequest(request, dependencies);
      } catch {
        return errorResponse(503, "Native booking data is unavailable.");
      }
      if (resolved.error) return resolved.error;

      try {
        const bookingContext = await resolved.service.getContext();

        return Response.json(
          {
            brand: publicBrand(resolved.context.brand),
            ...bookingContext,
          },
          { headers: NO_STORE_HEADERS },
        );
      } catch (error) {
        return controlledReadError(error);
      }
    },

    async availability(request) {
      const serviceCode = new URL(request.url).searchParams.get("service");
      if (!isKnownMinisterServiceCode(serviceCode)) {
        return errorResponse(400, "Invalid minister service code.");
      }

      let resolved;
      try {
        resolved = createServiceForRequest(request, dependencies);
      } catch {
        return errorResponse(503, "Native booking data is unavailable.");
      }
      if (resolved.error) return resolved.error;

      try {
        const availability = await resolved.service.getAvailability(serviceCode);
        return Response.json(availability, {
          headers: NO_STORE_HEADERS,
        });
      } catch (error) {
        return controlledReadError(error);
      }
    },
  });
}
