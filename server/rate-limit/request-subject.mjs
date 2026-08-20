import { railwayClientAddress, trustsRailwayProxy } from "../request-proxy.mjs";

export function requestNetworkSubject(request, environment = process.env) {
  return (
    railwayClientAddress(request.headers, trustsRailwayProxy(environment)) ??
    "unknown-network"
  );
}
