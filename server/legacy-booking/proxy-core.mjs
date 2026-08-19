import { isLegacyBookingAction } from "./actions.mjs";
import {
  LegacyBookingTimeoutError,
  LegacyBookingTransportError,
} from "./transport.mjs";

const JSON_RESPONSE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
});

function errorResponse(status, error) {
  return Response.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleLegacyBookingProxyRequest({
  request,
  expectedProfile,
  requestProfile,
  backendUrl,
  transport,
}) {
  if (!requestProfile || requestProfile !== expectedProfile) {
    return errorResponse(404, "Booking compatibility route not found.");
  }

  let requestBody;
  let payload;

  try {
    requestBody = await request.text();
    payload = JSON.parse(requestBody);
  } catch {
    return errorResponse(400, "Invalid JSON request body.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "JSON request body must be an object.");
  }

  if (!isLegacyBookingAction(payload.action)) {
    return errorResponse(400, "Unsupported booking compatibility action.");
  }

  if (!backendUrl) {
    return errorResponse(
      503,
      "Legacy booking backend is not configured for this profile.",
    );
  }

  try {
    const legacyResponse = await transport.forward(backendUrl, requestBody);

    return new Response(legacyResponse.body, {
      status: legacyResponse.status,
      headers: JSON_RESPONSE_HEADERS,
    });
  } catch (error) {
    if (error instanceof LegacyBookingTimeoutError) {
      return errorResponse(504, "Legacy booking backend timed out.");
    }

    if (error instanceof LegacyBookingTransportError) {
      return errorResponse(502, "Legacy booking backend is unavailable.");
    }

    return errorResponse(502, "Legacy booking backend is unavailable.");
  }
}
