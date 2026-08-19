export const LEGACY_BOOKING_TIMEOUT_MS = 10_000;

export class LegacyBookingTimeoutError extends Error {
  constructor() {
    super("Legacy booking request timed out");
    this.name = "LegacyBookingTimeoutError";
  }
}

export class LegacyBookingTransportError extends Error {
  constructor() {
    super("Legacy booking request failed");
    this.name = "LegacyBookingTransportError";
  }
}

export function createLegacyBookingTransport({
  fetchImpl = fetch,
  timeoutMs = LEGACY_BOOKING_TIMEOUT_MS,
} = {}) {
  return Object.freeze({
    async forward(backendUrl, requestBody) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(backendUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          cache: "no-store",
          signal: controller.signal,
        });
        const responseBody = await response.text();

        try {
          JSON.parse(responseBody);
        } catch {
          throw new LegacyBookingTransportError();
        }

        return {
          body: responseBody,
          status: response.status,
        };
      } catch (error) {
        if (error instanceof LegacyBookingTransportError) throw error;
        if (controller.signal.aborted) throw new LegacyBookingTimeoutError();
        throw new LegacyBookingTransportError();
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
