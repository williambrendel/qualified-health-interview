"use strict";

const { createMiddleware } = require("../core");

/**
 * @module cors
 * @description Instantiates the `cors` Express middleware with default options and
 * wraps it as a {@link Middleware} instance via {@link createMiddleware}.
 * Enables cross-origin resource sharing (CORS) for all routes.
 *
 * @see createMiddleware
 * @see registerMiddleware
 */
const cors = createMiddleware(require("cors")(), {
  name: "cors",
  description: "Enables cross-origin resource sharing (CORS) for all routes."
});

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(cors, "cors", {
  value: cors
}));