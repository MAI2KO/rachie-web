export function requestNetworkSubject(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const firstAddress = forwarded?.split(",", 1)[0]?.trim();
  return firstAddress || "unknown-network";
}
