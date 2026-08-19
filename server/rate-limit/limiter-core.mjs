import { createHmac } from "node:crypto";

function hashSubject(gameProfile, policyCode, subject, secret) {
  return createHmac("sha256", secret)
    .update(`${gameProfile}\0${policyCode}\0${subject}`, "utf8")
    .digest("hex");
}

export function createRateLimiter({
  gameProfile,
  repository,
  secret,
  now = () => new Date(),
}) {
  return Object.freeze({
    async consume(policy, subject) {
      if (!policy || typeof subject !== "string" || !subject) {
        throw new TypeError("A rate-limit policy and subject are required.");
      }
      const nowDate = now();
      const windowMilliseconds = policy.windowSeconds * 1000;
      const windowStartedAt = new Date(
        Math.floor(nowDate.getTime() / windowMilliseconds) * windowMilliseconds,
      );
      const expiresAt = new Date(
        windowStartedAt.getTime() + windowMilliseconds * 2,
      );
      const requestCount = await repository.consume({
        policyCode: policy.code,
        subjectHash: hashSubject(gameProfile, policy.code, subject, secret),
        windowStartedAt,
        expiresAt,
        cleanupBefore: nowDate,
        limit: policy.limit,
      });
      const resetAt = new Date(windowStartedAt.getTime() + windowMilliseconds);
      return {
        allowed: requestCount !== null,
        limit: policy.limit,
        remaining:
          requestCount === null ? 0 : Math.max(0, policy.limit - requestCount),
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((resetAt.getTime() - nowDate.getTime()) / 1000),
        ),
      };
    },
  });
}
