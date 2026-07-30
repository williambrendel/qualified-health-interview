"use strict";

const dispatchError = require("./dispatchError");

/**
 * @class Middleware
 * @description Wraps an Express middleware function as a callable class instance.
 * The resulting object behaves exactly like the original middleware — it can be passed
 * directly to `app.use()` — while also being a proper `Middleware` instance with
 * `name`, `description`, and `process` properties.
 *
 * Supports two construction signatures:
 * - **Function signature:** `new Middleware(fn, options?)` — wraps `fn` directly.
 * - **Object signature:** `new Middleware({ process|middleware, name?, description?, onerror? })`
 *   — normalizes the descriptor object, then wraps the resolved function.
 *
 * If the resolved middleware is not a function, {@link dispatchError} is called with
 * the provided `onerror` callback and the instance falls back to {@link Middleware.noop}.
 *
 * Can also be called without `new` — delegates to `new Middleware(...)` automatically.
 *
 * @param {Function|object} middleware - The middleware function to wrap, or a descriptor
 *   object with a `process` or `middleware` key holding the function.
 * @param {object}   [options={}]            - Configuration options. Merged with any
 *   properties on the descriptor object when the object signature is used.
 * @param {string}   [options.name]          - Display name. Defaults to `middleware.name`.
 * @param {string}   [options.description]   - Human-readable description. Defaults to
 *   `"<name> middleware"`.
 * @param {Function|null} [options.onerror]  - Error callback forwarded to
 *   {@link dispatchError} when the resolved middleware is not a function.
 *
 * @example
 * // Function signature
 * const mw = new Middleware(cors(), { name: "cors" });
 * app.use(mw); // ✅ callable
 * mw instanceof Middleware; // ✅ true
 *
 * @example
 * // Object signature
 * const mw = Middleware({ process: cors(), name: "cors", description: "CORS handler" });
 *
 * @example
 * // Invalid input — falls back to noop, dispatches error
 * const mw = new Middleware(null, { onerror: err => logger.error(err) });
 *
 * @see Middleware.noop
 * @see dispatchError
 */
class Middleware {
  constructor(middleware, options) {
    if (!new.target) {
      return new Middleware(middleware, options);
    }

    // Normalize input.
    options || (options = {});
    middleware && typeof middleware === "object" && (
      Object.assign(options, middleware),
      middleware = middleware.process || middleware.middleware
    );
    let { name, description, onerror } = options;

    // Error if input is not a function.
    typeof middleware === "function"
      || (
        dispatchError(Error(`Invalid input middleware -- not a function: ${middleware}`), onerror),
        middleware = noop
      );

    name || (name = middleware.name || "");
    description || (description = `${name || "unnamed"} middleware`);

    const self = function(...args) {
      return middleware.apply(this, args);
    };

    Object.setPrototypeOf(self, new.target.prototype);

    Object.defineProperties(self, {
      /**
       * @member {string} name
       * @memberof Middleware
       * @instance
       * @description Display name of the middleware. Defaults to the wrapped
       *   function's `name` property, or `""` if unavailable.
       * @readonly
       */
      name: { get() { return name; }, enumerable: true, configurable: true },

      /**
       * @member {string} description
       * @memberof Middleware
       * @instance
       * @description Human-readable description of the middleware's purpose.
       *   Defaults to `"<name> middleware"`.
       * @readonly
       */
      description: { get() { return description; }, enumerable: true, configurable: true },

      /**
       * @member {Function} process
       * @memberof Middleware
       * @instance
       * @description The underlying Express middleware function. Invoked on every
       *   call to the `Middleware` instance.
       * @readonly
       */
      process: { get() { return middleware; }, enumerable: true, configurable: true },

      length: { value: middleware.length, configurable: true },
    });

    return self;
  }
}

/**
 * @function noop
 * @description No-op Express middleware. Calls `next()` immediately without
 * modifying the request or response. Used as the fallback process when an
 * invalid middleware is passed to the {@link Middleware} constructor.
 *
 * @param {import("express").Request}  _    - Unused request object.
 * @param {import("express").Response} __   - Unused response object.
 * @param {Function}                   next - Express next callback.
 *
 * @returns {void}
 *
 * @see Middleware
 */
const noop = (_, __, next) => next();
Object.defineProperty(noop, "name", { value: "No-op", configurable: true });

/**
 * @name Middleware.create
 * @description Alias for `new {@link Middleware}`. Create a new Middleware.
 */
Middleware.create = (...args) => new Middleware(...args);

/**
 * @ignore
 * Default export with freezing.
 */
Middleware.noop = noop;
module.exports = Object.freeze(Object.defineProperty(Middleware, "Middleware", {
  value: Middleware
}));