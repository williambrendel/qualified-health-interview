"use strict";

const { getDefaultApp } = require("./constants");
const dispatchError = require("./dispatchError");
const Middleware = require("./Middleware");

/**
 * @type {Map<object|null, Function[]>}
 * @description Registry mapping app instances (or `null` for the default bucket) to their
 * ordered list of registered middleware functions.
 */
const APPS = new Map();

/**
 * @function registerMiddleware
 * @description Validates and registers a single Express middleware function into the
 * module-level registry under the given app instance (or the default app bucket if `app`
 * is not an object). Non-function values are rejected with a console error.
 *
 * @param {Function} middleware - The middleware function to register.
 * @param {object|null} [app]   - The Express app to associate this middleware with.
 *   Non-object values are coerced to `null`, binding the middleware to the default app bucket.
 * @param {Function} [onerror] - a callback function that is triggered when an error occurs.
 *   Non blocking console.error display by default
 *
 * @returns {Function|null} The registered middleware, or `null` if the argument was not
 *   a function.
 *
 * @example
 * // Register under a specific app
 * registerMiddleware(cors(), app);
 *
 * @example
 * // Register under the default app bucket
 * registerMiddleware(morgan("dev"));
 *
 * @see attachRegisteredMiddlewares
 */
const registerMiddleware = (middleware, app, onerror) => {

  typeof app === "object" || (app = null);

  if (typeof middleware !== "function" && !(middleware instanceof Middleware)) {
    dispatchError(Error(`Invalid middleware ${middleware}: should be a function or an instance of Middleware`), onerror);
    return null;
  }

  // Get middlewares linked to app.
  let middlewares = APPS.get(app);
  middlewares || (
    APPS.set(app, middlewares = [])
  );

  middlewares.push(middleware);

  return middleware;
}

/**
 * @function attachRegisteredMiddlewares
 * @description Mounts all previously registered middlewares for `app` onto the Express
 * instance via `app.use()`, in registration order. If `app` is the current default app,
 * also recursively flushes middlewares registered under the `null` (default) bucket.
 * Intended to be called once during app initialization.
 *
 * @param {import("express").Application} [app] - The Express application instance to
 *   attach middlewares to. When omitted, flushes the default (`null`) bucket onto the
 *   default app returned by {@link getDefaultApp}.
 * @param {Function} [log=console.log] - a callback function to log when middlewares are attached.
 *
 * @returns {import("express").Application} The same `app` instance, with all registered
 *   middlewares attached. Enables chaining.
 *
 * @example
 * registerMiddleware(cors(), app);
 * attachRegisteredMiddlewares(app);
 *
 * @example
 * // Chainable
 * const app = attachRegisteredMiddlewares(express());
 *
 * @see registerMiddleware
 * @see getDefaultApp
 */
const attachRegisteredMiddlewares = (app, log=console.log) => {
  const middlewares = APPS.get(app || null) || [], a = getDefaultApp();
  app && app === a && attachRegisteredMiddlewares();
  app || (app = a);
  for (let i = 0, l = middlewares.length; i !== l; ++i) {
    const middleware = middlewares[i];
    app.use(middleware);
    typeof log === "function" && log(`🔧 [attachRegisteredMiddlewares] Attaching middleware: ${middleware.name || "unnamed"}`)
  }
  return app;
}

/**
 * @ignore
 * Default export with freezing.
 */
registerMiddleware.attachRegisteredMiddlewares = attachRegisteredMiddlewares;
module.exports = Object.freeze(Object.defineProperty(registerMiddleware, "registerMiddleware", {
  value: registerMiddleware
}));