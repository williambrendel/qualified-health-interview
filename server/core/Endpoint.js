"use strict";

const { isEndpointRegistered, registerEndpoint } = require("./registerEndpoint");
const dispatchError = require("./dispatchError");

/**
 * @class Endpoint
 * @description Represents a single Express route endpoint. Encapsulates the HTTP method,
 * route path, middleware chain, handler function, and metadata (name, description).
 * Supports two construction styles: a flat positional signature and a rich options-object
 * signature. Automatically registers itself with {@link registerEndpoint} on construction
 * unless opted out via `registered: false`.
 *
 * @example
 * // Positional signature
 * new Endpoint("GET", "/api/ping", authMiddleware, handler, "ping", "Health check route");
 *
 * @example
 * // Options-object signature
 * new Endpoint({
 *   method: "GET",
 *   route: "/api/ping",
 *   name: "ping",
 *   description: "Health check route",
 *   middlewares: [authMiddleware],
 *   process: handler,
 *   registered: true
 * });
 *
 * @example
 * // Factory alias
 * const ep = Endpoint.create({ method: "POST", route: "/api/data", process: handler });
 *
 * @see registerEndpoint
 * @see Endpoint.create
 */
class Endpoint {
  /**
   * @constructor
   * @description Normalizes and validates construction arguments, defines all instance
   * properties as non-writable getters, and optionally auto-registers the endpoint.
   *
   * **Positional signature:** `(method, route, [...middlewares], handler [, name [, description]])`
   * - Trailing string arguments are consumed as `description` (if two strings present)
   *   then `name`, then remaining functions become middlewares with the last as `process`.
   *
   * **Options-object signature:** `({ method|type, route, name, description, process,
   * processes, middlewares, middleware, registered, toString })`
   * - `processes` (array or function) is treated as an ordered middleware + handler list;
   *   the last entry becomes `process`.
   * - A custom `toString` function is bound to the instance if provided.
   * - `registered: false` suppresses auto-registration.
   *
   * If no handler is resolved from either signature, a default HTML info page handler is
   * generated via {@link createDefaultProcess}.
   *
   * @param {string|object} type - HTTP method string (e.g. `"GET"`) for the positional
   *   signature, or an options object for the object signature.
   * @param {string} [route="/"] - Route path. Used only in the positional signature;
   *   ignored when `type` is an object.
   * @param {...Function|string} processes - For the positional signature: zero or more
   *   middleware functions followed by the route handler, optionally preceded by `name`
   *   and `description` strings at the tail.
   */
  constructor(
    type,
    route,
    ...processes
  ) {
    let _registered = true,
    _method = "get",
    _route = "/",
    _name,
    _description = "",
    _process = null,
    _middlewares = [],
    _onerror;

    // Normalize input.
    if (type && typeof type === "object") {
      let {
        type: _type,
        method = _type,
        route,
        name,
        description,
        processes,
        endpoint,
        process = endpoint,
        middlewares,
        middleware,
        register,
        registered = register,
        onerror,
        toString
      } = type;
      Array.isArray(processes) && (processes = processes.flat(Infinity))
        || (typeof processes === "function" && (processes = [processes]));
      Array.isArray(processes) || (processes = []);

      method && (_method = `${method}`);
      route && (_route = `${route}`);
      name && (_name = `${name}`);
      description && (_description = `${description}`);
      process && typeof process === "function" && (_process = process) || (
        processes && (_process = processes.pop())
      );
      middleware && _middlewares.push(middleware);
      middlewares && (_middlewares = Array.isArray(middlewares) && middlewares || [middlewares]);
      processes.length && _middlewares.push(...processes);
      _middlewares = _middlewares.flat(Infinity);
      toString && typeof toString === "function" && Object.defineProperty(this, "toString", {
        value: (...args) => toString.apply(this, args)
      });
      registered !== undefined && (_registered = registered);
      _onerror = onerror;
    } else {
      processes = processes.flat(Infinity);
      type && (_method = `${type}`);
      route && (_route = `${route}`);
      _description = typeof processes[processes.length - 1] === "string"
        && typeof processes[processes.length - 2] === "string" && processes.pop() || "",
      _name = typeof processes[processes.length - 1] === "string" && processes.pop();
      _process = processes.pop() || null;
      _middlewares = processes
    };
    _method = _method.toUpperCase();
    _route = ("/" + _route.toLowerCase()).replace(/^\/+/, "/");
    _middlewares = _middlewares.filter(isFunction);
    _process || (
      dispatchError(Error(`Invalid input endpoint -- not a function: ${_process}`), onerror),
      _process = createDefaultProcess(this)
    );
    _name || (_name = _route.slice(1) || "main");
    _description || (_name && (_description = `${_name} ${_method} endpoint`));

    this.toString || Object.defineProperty(this, "toString", {
      value: function() {
        return JSON.stringify(this, null, 2);
      }
    });

    /**
     * @member {string} method
     * @memberof Endpoint
     * @instance
     * @description The HTTP method for this endpoint, normalized to uppercase
     *   (e.g. `"GET"`, `"POST"`).
     * @readonly
     */
    Object.defineProperty(this, "method", {
      get() { return _method; },
      enumerable: true
    });

    /**
     * @member {string} route
     * @memberof Endpoint
     * @instance
     * @description The Express route path this endpoint is mounted at (e.g. `"/api/users"`).
     * @readonly
     */
    Object.defineProperty(this, "route", {
      get() { return _route; },
      enumerable: true
    });

    /**
     * @member {string} name
     * @memberof Endpoint
     * @instance
     * @description Human-readable identifier for this endpoint. Used in conflict warnings
     *   and the default HTML handler page. Defaults to `"main"`.
     * @readonly
     */
    Object.defineProperty(this, "name", {
      get() { return _name; },
      enumerable: true
    });

    /**
     * @member {string} description
     * @memberof Endpoint
     * @instance
     * @description Optional prose description of the endpoint's purpose. Rendered in the
     *   default HTML handler page when no custom `process` is provided.
     * @readonly
     */
    Object.defineProperty(this, "description", {
      get() { return _description; },
      enumerable: true
    });

    /**
     * @member {Function} process
     * @memberof Endpoint
     * @instance
     * @description The Express route handler `(req, res, next) => void`. Falls back to a
     *   generated HTML info page via {@link createDefaultProcess} if none was supplied.
     * @readonly
     */
    Object.defineProperty(this, "process", {
      get() { return _process; }
    });

    /**
     * @member {Function[]} middlewares
     * @memberof Endpoint
     * @instance
     * @description A shallow copy of the middleware chain that runs before {@link process}.
     *   Returns a new array on each access to prevent external mutation.
     * @readonly
     */
    Object.defineProperty(this, "middlewares", {
      get() { return Array.from(_middlewares); }
    });

    /**
     * @member {boolean} registered
     * @memberof Endpoint
     * @instance
     * @description Live check — `true` if this endpoint is currently registered under
     *   at least one app via {@link isEndpointRegistered}.
     * @readonly
     */
    Object.defineProperty(this, "registered", {
      get() { return isEndpointRegistered(this); },
      enumerable: true
    });

    /**
     * @method register
     * @memberof Endpoint
     * @instance
     * @description Manually registers this endpoint under the given app instance. Delegates
     *   to {@link registerEndpoint}. Useful when `registered: false` was passed at
     *   construction, or to register under an additional app after construction.
     *
     * @param {object} [app] - The Express app instance to register under. Omit to register
     *   under the default app bucket.
     *
     * @returns {object} The endpoint itself (as returned by {@link registerEndpoint}).
     *
     * @example
     * const ep = new Endpoint({ method: "GET", route: "/ping", process: handler, registered: false });
     * ep.register(app);
     */
    Object.defineProperty(this, "register", {
      value: function(app) {
        return registerEndpoint(this, app);
      }
    });

    _registered && registerEndpoint(this, _registered);
  }
}

/**
 * @function createDefaultProcess
 * @description Generates a fallback Express handler that responds with a minimal HTML page
 * displaying the endpoint's name, method, route, and description. Bound at construction
 * time when no explicit `process` function is supplied.
 *
 * @param {Endpoint} endpoint - The endpoint instance whose metadata populates the page.
 *
 * @returns {Function} An Express handler `(req, res) => void` that calls `res.send(html)`.
 *
 * @see Endpoint
 */
const createDefaultProcess = endpoint => (_, res) => res.send(`<!DOCTYPE html>
<html lang="en-us">
  <head>
  </head>
  <body>
    <h1>${endpoint.name}</h1>
    ${endpoint.description || ""}
    <br/>
    <ul style="line-height: 150%">
    <li>
        <b>Method:</b> ${endpoint.method.toUpperCase()}
      </li>
      <li>
        <b>Route:</b> ${endpoint.route}
      </li>
      <li>
        <b>Description:</b> ${endpoint.description || "none"}
      </li>
    </ul>
  </body>
</html>`);

/**
 * @function isFunction
 * @description Predicate returning `true` if the given value is a function. Used to
 * filter middleware arrays during construction.
 *
 * @param {*} f - Value to test.
 * @returns {boolean}
 */
const isFunction = f => typeof f === "function";

/**
 * @name Endpoint.create
 * @description Alias for `new {@link Endpoint}`. Create a new Endpoint.
 */
Endpoint.create = (...args) => new Endpoint(...args);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(Endpoint, "Endpoint", {
  value: Endpoint
}));