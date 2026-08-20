import { isIP } from "node:net";

export function trustsRailwayProxy(environment = process.env) {
  return String(environment.TRUSTED_PROXY ?? "").trim().toLowerCase() === "railway";
}

export function requestHostnameHeader(headers, trustProxy = false) {
  return trustProxy
    ? headers.get("x-forwarded-host") ?? headers.get("host")
    : headers.get("host");
}

export function railwayClientAddress(headers, trustProxy = false) {
  if (!trustProxy) return null;
  const address = headers.get("x-real-ip")?.trim() ?? "";
  return isIP(address) ? address : null;
}
