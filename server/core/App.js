"use strict";

const express = require("express");
const { attachRegisteredMiddlewares } = require("./registerMiddleware");
const Endpoint = require("./Endpoint");
const {
  attachRegisteredEndpoints,
} = require("./registerEndpoint");
const addHealthCheckEndpoint = require("./addHealthCheckEndpoint");
const addHelpEndpoint = require("./addHelpEndpoint");
const { setDefaultApp, DEFAULT_PORT } = require("./constants");
const dispatchError = require("./dispatchError");

/**
 * @class App
 * @description Top-level Express application wrapper. Orchestrates middleware registration,
 * endpoint mounting, and server lifecycle. On construction, this instance is set as the
 * module-level default app via {@link setDefaultApp}, so any {@link Endpoint} instances
 * created without an explicit app target are automatically attached here.
 *
 * The underlying `express()` instance is accessible via the `._` getter and is used
 * internally by {@link listen} and {@link use}.
 *
 * @example
 * // Minimal setup
 * const app = new App();
 * app.listen(3000);
 *
 * @example
 * // With options
 * const app = new App({
 *   middlewares: [cors(), helmet()],
 *   endpoints: [
 *     new Endpoint({ method: "GET", route: "/health", process: handler }),
 *     { method: "POST", route: "/api/data", process: dataHandler }
 *   ]
 * });
 * app.listen({ port: 8080, hostname: "0.0.0.0" });
 *
 * @see Endpoint
 * @see App.create
 */
class App {
  /**
   * @member {import("http").Server|null} #server
   * @memberof App
   * @private
   * @description The active Node.js HTTP server instance, populated after {@link listen}
   * is called. `null` before the app begins listening.
   */
  #server = null;

  /**
   * @member {object} #serverOptions
   * @memberof App
   * @private
   * @description Residual options from the constructor that are not consumed by middleware
   * or endpoint registration. Merged into the options object on each {@link listen} call,
   * allowing persistent server-level config (e.g. custom timeouts) to be set once.
   */
  #serverOptions = {};

  /**
   * @constructor
   * @description Initializes the Express app, registers global middlewares, mounts
   * endpoints, and attaches all registered endpoints to the underlying router.
   *
   * **Middleware resolution order:**
   * 1. `middleware` / `middlewares` from `options` are applied directly via `app.use()`.
   * 2. Any middlewares previously registered via {@link registerMiddleware} are attached
   *    via {@link attachRegisteredMiddlewares}.
   *
   * **Endpoint resolution:** Each entry in `endpoints` (or the singular `endpoint`) is
   * normalized to an {@link Endpoint} instance using one of three strategies:
   * - A function is wrapped in a new `Endpoint` with `process` set to that function.
   * - An existing `Endpoint` instance is registered directly via `endpoint.register(this)`.
   * - A plain object is spread into `new Endpoint({ ...obj, registered: this })`.
   *
   * Invalid entries (non-function, non-Endpoint, non-object) are dispatched to `onerror`
   * via {@link dispatchError}. When `onerror` is omitted, errors are printed to
   * `console.error` by default.
   *
   * @param {object} [options={}] - Configuration options.
   * @param {Function|Function[]} [options.middleware]  - A single middleware or array of
   *   middlewares to mount globally before any route handling.
   * @param {Function|Function[]} [options.middlewares] - Alias for `middleware`. Merged
   *   with `middleware` into a unified list.
   * @param {Endpoint|object|Function|Array<Endpoint|object|Function>} [options.endpoint]
   *   - A single endpoint to register. Merged with `endpoints`.
   * @param {Array<Endpoint|object|Function>|Set<Endpoint|object|Function>} [options.endpoints]
   *   - Collection of endpoints to register. Accepts an `Array` or `Set`; each entry is
   *   normalized as described above.
   * @param {boolean} [options.isDefaultApp=true] - If `true`, registers this instance as
   *   the module-level default app via {@link setDefaultApp}. Set to `false` to construct
   *   a secondary app without overriding the existing default.
   * @param {Function|null} [options.onerror] - Error callback forwarded to
   *   {@link dispatchError} for invalid middleware and endpoint entries. Defaults to
   *   `console.error` when omitted. Pass `null` to suppress error output entirely.
   * @param {Function} [options.log] - Optional logging function forwarded to
   *   {@link attachRegisteredMiddlewares} and {@link attachRegisteredEndpoints} for
   *   attachment-time diagnostics.
   * @param {...*} [options] - Any remaining keys are stored as `#serverOptions` and
   *   forwarded to the underlying `http.Server` on {@link listen}.
   */
  constructor(options) {
    let {
      endpoint,
      endpoints,
      middleware,
      middlewares,
      isDefaultApp = true,
      onerror,
      log,
      ...serverOptions
    } = options || {};

    // Try to add the app as the first default app.
    isDefaultApp && setDefaultApp(this);

    // Create the Express app and record the server options.
    const app = express();
    this.#serverOptions = serverOptions;

    /**
     * @member {import("express").Application} _
     * @memberof App
     * @instance
     * @description The underlying Express application instance. Used internally by
     *   {@link listen} and {@link use}. Can be passed directly to libraries that
     *   expect a raw Express app (e.g. `http.createServer(app._)`).
     * @readonly
     */
    Object.defineProperty(this, "_", {
      get() { return app; }
    });

    // Register global middlewares.
    Array.isArray(middlewares)
      || (middlewares && (middlewares = [middlewares]))
      || (middlewares = []);
    middleware && middlewares.push(middleware);
    for (let i = 0, l = middlewares.length; i !== l; ++i) {
      const middleware = middlewares[i];
      typeof middleware === "function" ? app.use(middleware)
      : dispatchError(Error(`Middleware: ${middleware} is not a valid middleware.`), onerror);
    }
    attachRegisteredMiddlewares(this, log);

    // Register endpoints.
    Array.isArray(endpoints)
      || (endpoints instanceof Set && (endpoints = Array.from(endpoints)))
      || (endpoints && (endpoints = [endpoints]))
      || (endpoints = []);
    endpoint && endpoints.push(endpoint);
    for (let i = 0, l = endpoints.length; i !== l; ++i) {
      const endpoint = endpoints[i];
      typeof endpoint === "function" && (new Endpoint({ process: endpoint, registered: this, onerror }))
      || (endpoint instanceof Endpoint && endpoint.register(this))
      || (endpoint && typeof endpoint === "object" && (new Endpoint({ ...endpoint, registered: this, onerror })))
      || dispatchError(Error(`Endpoint: ${endpoint} is not a valid endpoint.`), onerror);
    }

    // Add healthcheck endpoint.
    addHealthCheckEndpoint(this);

    // Add Help endpoint.
    addHelpEndpoint(this);

    // Attach endpoints to app.
    attachRegisteredEndpoints(this, log);
  }

  /**
   * @method listen
   * @memberof App
   * @instance
   * @description Starts the HTTP server, binding to the specified port and optional
   * hostname. Merges `#serverOptions` with the provided arguments, then delegates to
   * `express.Application.listen()`. Falls back to {@link DEFAULT_PORT} when no port
   * is resolvable. Any extra keys beyond the known listen params are assigned directly
   * onto the resulting `http.Server` instance.
   *
   * The `listeningListener` callback may also be supplied via the aliases `onstart`,
   * `onrun`, or `onlisten` (resolved in that priority order) when passing an options
   * object.
   *
   * @param {number|object} [port] - Port number to bind, or an options object that
   *   overrides all positional parameters (merged on top of `#serverOptions`). When
   *   omitted or not a number, falls back to {@link DEFAULT_PORT}.
   * @param {string}   [hostname]          - Network interface to bind to.
   * @param {number}   [backlog]           - Maximum length of the pending connections queue.
   * @param {Function} [listeningListener] - Callback invoked once the server is listening.
   *   Aliases `onstart`, `onrun`, and `onlisten` are also accepted when using the
   *   options-object form.
   *
   * @returns {import("http").Server} The Node.js HTTP server instance. Also stored
   *   internally and accessible via {@link server}.
   *
   * @example
   * // Numeric port
   * app.listen(3000, () => console.log("Listening"));
   *
   * @example
   * // Options object with onstart alias
   * app.listen({ port: 8080, hostname: "0.0.0.0", onstart: () => console.log("Ready") });
   *
   * @see server
   * @see run
   * @see DEFAULT_PORT
   */
  listen(port, hostname, backlog, listeningListener) {
    const options = port && typeof port === "object" && {
      ...this.#serverOptions, hostname, backlog, listeningListener, ...port,
    }
    || !isNaN(port) && { ...this.#serverOptions, port: parseInt(port), hostname, backlog, listeningListener }
    || { ...this.#serverOptions, hostname, backlog, listeningListener };
    const {
      port: _port,
      hostname: _hostname,
      backlog: _backlog,
      onstart = () => console.log(`✅ [App.listen] Listening on PORT ${_port || DEFAULT_PORT}`),
      onrun = onstart,
      onlisten = onrun,
      listeningListener: _listeningListener = onlisten,
      ...other
    } = options;
    const server = this.#server = this._.listen(_port || DEFAULT_PORT, _hostname, _backlog, _listeningListener);
    for (const k in other) server[k] = other[k];
    return server;
  }

  /**
   * @method run
   * @memberof App
   * @instance
   * @description Convenience wrapper around {@link listen} that returns the `App`
   * instance instead of the `http.Server`, enabling a fluent construction pattern.
   * Accepts the same arguments as {@link listen}.
   *
   * @param {...*} args - Forwarded verbatim to {@link listen}.
   *
   * @returns {App} This `App` instance, for chaining.
   *
   * @example
   * const app = new App({ middlewares: [cors()] }).run(3000);
   *
   * @see listen
   */
  run(...args) {
    this.listen(...args);
    return this;
  }

  /**
   * @method server
   * @memberof App
   * @instance
   * @description Returns the active HTTP server instance created by the last call to
   * {@link listen}, or `null` if {@link listen} has not yet been called.
   *
   * @returns {import("http").Server|null} The underlying server, or `null`.
   *
   * @example
   * app.listen(3000);
   * const srv = app.server(); // → http.Server
   *
   * @see listen
   */
  server() {
    return this.#server;
  }

  /**
   * @method use
   * @memberof App
   * @instance
   * @description Proxies `app.use()` on the underlying Express instance. Mounts
   * middleware or a sub-application at an optional path. Equivalent to calling
   * `app._.use(...args)` directly.
   *
   * @param {...*} args - Arguments forwarded verbatim to `express.Application.use()`.
   *   Typically `[path?, middleware | router | app]`.
   *
   * @returns {import("express").Application} The Express app instance (enables chaining).
   *
   * @example
   * app.use(express.json());
   * app.use("/api", apiRouter);
   */
  use(...args) {
    return this._.use(...args);
  }
}

/**
 * @name App.create
 * @description Alias for `new {@link App}`. Creates and returns a new App instance.
 *
 * @param {...*} args - Forwarded to the {@link App} constructor.
 * @returns {App}
 */
App.create = (...args) => new App(...args);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(App, "App", {
  value: App
}));