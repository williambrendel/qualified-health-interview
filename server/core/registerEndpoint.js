"use strict";

const getKey = require("./getKey");
const { getDefaultApp } = require("./constants");
const dispatchError = require("./dispatchError");

/**
 * @type {Map<object|null, Map<string, { attached: boolean, endpoint: object }>>}
 * @description Registry mapping app instances (or `null` for the default app) to their
 * associated endpoint maps, keyed by composite `"METHOD |> /route"` strings via {@link getKey}.
 */
const APPS = new Map();

/**
 * @function registerEndpoint
 * @description Validates and registers an endpoint definition under a given app instance
 * (or the default app bucket if `app` is not an object). The registry key is the
 * composite `"METHOD |> /route"` string from {@link getKey}. If a conflicting key already
 * exists, a console error is emitted and the entry is replaced.
 *
 * @param {object} endpoint - The endpoint descriptor to register.
 * @param {string}   endpoint.route       - The Express route path (e.g. `"/api/users"`).
 * @param {string}   endpoint.method      - HTTP method (e.g. `"GET"`, `"POST"`).
 * @param {string}   endpoint.name        - Human-readable name used in conflict warnings.
 * @param {Function[]} endpoint.middlewares - Middleware chain to apply before the handler.
 * @param {Function} endpoint.process     - The route handler function.
 * @param {object|null} [app]             - The Express app to associate this endpoint with.
 *   Non-object values are coerced to `null`, binding the endpoint to the default app bucket.
 * @param {Function} [onerror] - a callback function that is triggered when an error occurs.
 *   Non blocking console.error display by default
 *
 * @returns {object|null} The original `endpoint` argument, or `null` if `endpoint` is falsy.
 *
 * @example
 * registerEndpoint({
 *   route: "/health", method: "GET", name: "healthcheck",
 *   middlewares: [], process: (req, res) => res.sendStatus(200)
 * }, app);
 *
 * @see attachRegisteredEndpoints
 * @see isEndpointRegistered
 * @see getKey
 */
const registerEndpoint = (endpoint, app, onerror) => {
  typeof app === "object" || (app = null);

  if (!endpoint) {
    dispatchError(Error(`Invalid null endpoint`), onerror);
    return null;
  }

  if (!endpoint.route) {
    dispatchError(Error(`Endpoint ${endpoint.name} needs a route`), onerror);
    return endpoint;
  }

  // Get endpoints linked to app.
  let endpoints = APPS.get(app);
  endpoints || (
    APPS.set(app, endpoints = new Map())
  );

  // Check if the route already exists.
  const key = getKey(endpoint), e = endpoints.get(key);
  e && dispatchError(Error(`${key} already registered with ${e.endpoint.name}, replacing with this one: ${endpoint.name}`), onerror);
  endpoints.set(key, { attached: false, endpoint });
  return endpoint;
}

/**
 * @function isEndpointRegistered
 * @description Checks whether an endpoint is registered, either under a specific app
 * or under any app if `app` is omitted.
 *
 * @param {object} endpoint       - The endpoint descriptor to look up.
 * @param {string} endpoint.route - Route component of the {@link getKey} lookup.
 * @param {string} endpoint.method - Method component of the {@link getKey} lookup.
 * @param {object} [app]          - App instance to scope the check to. If omitted,
 *   returns `true` if the endpoint is attached to at least one app.
 *
 * @returns {boolean} `true` if the endpoint is found under the specified (or any) app.
 *
 * @example
 * // Scoped check
 * isEndpointRegistered(myEndpoint, app); // → true | false
 *
 * @example
 * // Global check
 * isEndpointRegistered(myEndpoint); // → true | false
 *
 * @see findConnectedApps
 * @see getKey
 */
const isEndpointRegistered = (endpoint, app) => {
  if (app === undefined) return findConnectedApps(endpoint).length > 0;
  const endpoints = APPS.get(app);
  return endpoints && endpoints.get(getKey(endpoint)) === endpoint || false;
}

/**
 * @function findConnectedApps
 * @description Returns all app instances (including `null` for the default bucket)
 * that have this exact endpoint object registered under its composite key.
 *
 * @param {object} endpoint        - The endpoint descriptor to search for.
 * @param {string} endpoint.route  - Route component of the {@link getKey} lookup.
 * @param {string} endpoint.method - Method component of the {@link getKey} lookup.
 *
 * @returns {Array<object|null>} App instances under which the endpoint is registered.
 *   Empty array if not registered anywhere.
 *
 * @example
 * findConnectedApps(myEndpoint); // → [appA, null]
 *
 * @see isEndpointRegistered
 * @see getKey
 */
const findConnectedApps = endpoint => {
  const apps = [], key = getKey(endpoint);
  APPS.forEach((endpoints, app) => {
    const e = endpoints.get(key);
    e === endpoint && apps.push(app)
  });
  return apps;
}

/**
 * @function attachRegisteredEndpoints
 * @description Mounts all unattached endpoints registered under `app` (or the default
 * app if `app` is omitted) onto the Express router at `app._`. Each endpoint is mounted
 * exactly once; subsequent calls skip already-attached entries. If `app` equals the
 * current default app, also recursively attaches endpoints in the default (`null`) bucket.
 *
 * @param {object} [app] - The Express app instance whose registered endpoints should be
 *   mounted. Defaults to the instance returned by {@link getDefaultApp} when omitted.
 * @param {Function} [log=console.log] - a callback function to log when endpoints are attached.
 *
 * @returns {object} The `app` argument, unchanged.
 *
 * @example
 * attachRegisteredEndpoints(app);  // attach endpoints registered under app
 * attachRegisteredEndpoints();     // attach endpoints in the default bucket
 *
 * @see registerEndpoint
 * @see getDefaultApp
 */
const attachRegisteredEndpoints = (app, log = console.log) => {
  // Attach default app endpoints.
  app && app === getDefaultApp() && attachRegisteredEndpoints();

  // Attach endpoints.
  const endpoints = APPS.get(app || null);
  const a = app || getDefaultApp();
  a && endpoints && endpoints.forEach((e, _) => {
    const { attached, endpoint } = e;
    attached || (
      a._[endpoint.method.toLowerCase()](endpoint.route, ...endpoint.middlewares, endpoint.process),
      e.attached = true,
      typeof log === "function" && log(`🖥️  [attachRegisteredEndpoints] Attaching endpoint: ${endpoint.method.toUpperCase()} ${endpoint.route}`)
    );
  });

  return app;
}

/**
 * @function getEndpoints
 * @description Returns a flat array of all endpoint descriptors registered under the
 * given app. If `app` is the current default app, also includes endpoints registered
 * under the `null` (default) bucket.
 *
 * @param {object|null} [app] - The app instance to look up. Non-object values are
 *   coerced to `null`, querying the default app bucket.
 *
* @returns {Array<[string, { attached: boolean, endpoint: object }]>} Array of
 *   `[key, endpoint]` tuples where `key` is the composite `"METHOD |> /route"` string,
 *   or an empty array if nothing has been registered under `app` yet.
 *
 * @example
 * const endpoints = getEndpoints(app);  // → endpoint descriptors for app
 * const defaults  = getEndpoints();     // → endpoint descriptors for default bucket
 *
 * @see registerEndpoint
 * @see getKey
 */
const getEndpoints = app => {
  const endpoints = app && app === getDefaultApp()
    && Array.from(APPS.get(null) || []).map(([key, { endpoint }]) => [key, endpoint])
    || [];
  endpoints.push(...Array.from(APPS.get(typeof app === "object" && app || null) || []).map(([key, { endpoint }]) => [key, endpoint]))
  return endpoints;
}

/**
 * @ignore
 * Default export with freezing.
 */
registerEndpoint.getEndpoints = getEndpoints;
registerEndpoint.findConnectedApps = findConnectedApps;
registerEndpoint.isEndpointRegistered = isEndpointRegistered;
registerEndpoint.attachRegisteredEndpoints = attachRegisteredEndpoints;
module.exports = Object.freeze(Object.defineProperty(registerEndpoint, "registerEndpoint", {
  value: registerEndpoint
}));