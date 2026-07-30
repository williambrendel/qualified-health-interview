"use strict";

const Endpoint = require("./Endpoint");
const { getEndpoints } = require("./registerEndpoint");
const getKey = require("./getKey");

/**
 * @type {string}
 * @description Static HTML response body returned by the GET healthcheck endpoint.
 */
const GET_CONTENT = `<!DOCTYPE html>
<html lang="en-us">
  <head>
  </head>
  <body>
    <h1>Health Check</h1>
    Success!
  </body>
</html>`;

/**
 * @type {{ msg: string }}
 * @description Static JSON response body returned by the POST healthcheck endpoint.
 */
const POST_CONTENT = {
  msg: "Healthcheck succeeded"
};

/**
 * @function addHealthCheckEndpoint
 * @description Registers GET and POST healthcheck {@link Endpoint}s under `app` at the
 * given route, skipping any method whose key is already present in the registry. The GET
 * handler responds with a static HTML success page; the POST handler responds with a JSON
 * `{ msg }` object.
 *
 * @param {object} app - The Express app instance to attach the endpoints to.
 * @param {string} [route="/healthcheck"] - Route path for both healthcheck endpoints.
 *
 * @returns {object} The `app` argument, unchanged.
 *
 * @example
 * addHealthCheckEndpoint(app);              // → GET/POST /healthcheck
 * addHealthCheckEndpoint(app, "/api/ping"); // → GET/POST /api/ping
 *
 * @see GET_CONTENT
 * @see POST_CONTENT
 * @see getKey
 */
const addHealthCheckEndpoint = (app, route) => {
  route || (route = "/healthcheck");
  const keyg = getKey(route, "get"),
    keyp = getKey(route, "post");
  let addg = true, addp = true;
  const registered = getEndpoints(app);
  registered && registered.forEach(([k, _]) => (
    k === keyg && (addg = false),
    k === keyp && (addp = false)
  ));

  addg && new Endpoint({
    method: "get",
    route,
    process: (_, res) => res.status(200).send(GET_CONTENT),
    registered: app
  });

  addp && new Endpoint({
    method: "post",
    route,
    process: (_, res) => res.status(200).json(POST_CONTENT),
    registered: app
  });

  return app;
}

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(addHealthCheckEndpoint, "addHealthCheckEndpoint", {
  value: addHealthCheckEndpoint
}));