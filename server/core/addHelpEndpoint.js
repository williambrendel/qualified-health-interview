"use strict";

const Endpoint = require("./Endpoint");
const { getEndpoints } = require("./registerEndpoint");
const getKey = require("./getKey");

/**
 * @function addHelpEndpoint
 * @description Registers a GET `"help"` {@link Endpoint} under `app` at the given route.
 * The handler responds with a dynamically generated HTML page listing all endpoints
 * currently registered under `app` at the time of the call, including their method,
 * route (linked for GET routes), and description. If a GET endpoint already exists at
 * the target route, the function is a no-op.
 *
 * The endpoint list snapshot is captured at registration time — endpoints added after
 * this call will not appear in the help page.
 *
 * @param {object} app        - The Express app instance to attach the help endpoint to.
 * @param {string} [route="/help"] - Route path for the help endpoint.
 *
 * @returns {object} The `app` argument, unchanged.
 *
 * @example
 * addHelpEndpoint(app);           // → GET /help
 * addHelpEndpoint(app, "/api");   // → GET /api
 *
 * @see getKey
 */
const addHelpEndpoint = (app, route) => {
  route || (route = "/help");
  const method = "GET",
    key = getKey(route, method);
  let add = false, e = [];
  const registered = getEndpoints(app);
  registered && (
    add = true,
    registered.forEach(([k, endpoint]) => (
      k === key && (add = false),
      add && e.push(endpoint)
    ))
  );

  if (add) {
    const name = "help", description = "List of all endpoints";
    let html = `<!DOCTYPE html>
      <html lang="en-us">
        <head>
        </head>
        <body>
          <h1>Help</h1>
          ${description}
          <br/>
          <br/>
      `;
    for (let i = 0, l = e.length; i !== l; ++i) {
      const { name, method = "GET", route, description } = e[i];
      html += `
        <hr/>
        <h2>${name}</h2>
        <ul style="line-height: 150%">
          <li><b>Method:</b> ${method.toUpperCase()}</li>
          <li>
            <b>Route:</b> ${method.toLowerCase() === "get"
              && `<a href="${route}" target="_blank" title="Route for ${name}">${route}</a>`
              || route}
          </li>
          <li><b>Description:</b> ${description || "none"}</li>
        </ul>
        <br/>
        <br/>
      `;
    }
    html += "  </body>\n</html>";

    new Endpoint({
      method,
      route,
      name,
      description,
      process: (_, res) => res.send(html),
      registered: app
    });
  }
  return app;
}

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(addHelpEndpoint, "addHelpEndpoint", {
  value: addHelpEndpoint
}));