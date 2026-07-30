"use strict"

/**
 * @function getKey
 * @description Derives a normalized, lowercase composite lookup key from a route path
 * and HTTP method. Accepts either two discrete strings or a single endpoint-like object
 * with `route` and `method` properties.
 *
 * Key format: `"<method> |> <route>"` — e.g. `"get |> /api/users"`.
 * The route is always normalized to a single leading slash.
 *
 * @param {string|object} route  - Route path string, or an endpoint object with `.route`
 *   and `.method` properties. When an object is passed, `method` is ignored.
 * @param {string} [method="get"] - HTTP method string. Ignored when `route` is an object.
 *
 * @returns {string} Lowercase composite key, e.g. `"get |> /healthcheck"`.
 *
 * @example
 * getKey("/api/users", "GET");     // → "get |> /api/users"
 * getKey(myEndpoint);              // → "post |> /api/data"
 * getKey("users", "post");         // → "post |> /users"
 *
 * @see registerEndpoint
 * @see isEndpointRegistered
 * @see findConnectedApps
 */
const getKey = (route, method) => (
  typeof route === "object" && (
    method = route.method,
    route = route.route
  ),
  method || (method = "get"),
  route = ("/" + (route || "")).replace(/^\/+/, "/"),
  `${method} |> ${route}`
).toLowerCase();

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(getKey, "getKey", {
  value: getKey
}));