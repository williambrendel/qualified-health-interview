"use strict";

const express = require("express");
const { createMiddleware } = require("../core");

/**
 * @module json
 * @description Selective JSON body-parsing middleware. Passes multipart requests
 * through unchanged and applies `express.json()` to all other content types.
 *
 * @see createMiddleware
 * @see registerMiddleware
 */

/**
 * @function json
 * @description
 * Express middleware that selectively applies JSON body parsing based on the
 * request's `Content-Type` header.
 *
 * Multipart form-data requests (e.g. file uploads) are passed through
 * unchanged, allowing downstream middleware such as `multer` to handle them.
 * All other requests are processed by `express.json()`, which parses the
 * request body as JSON and populates `req.body`.
 *
 * This prevents `body-parser` from attempting to parse multipart boundaries
 * as JSON, which would otherwise produce a `SyntaxError` and a `400 Bad
 * Request` response before the route handler is reached.
 *
 * @param {object}   req                           - Express request object.
 * @param {object}   req.headers                   - Incoming request headers.
 * @param {string}   [req.headers["content-type"]] - Content-Type header value.
 * @param {object}   res                           - Express response object.
 * @param {Function} next                          - Express next middleware function.
 *
 * @returns {void} Calls `next()` directly for multipart requests, or delegates
 *   to `express.json()` for all other content types.
 *
 * @example
 * // Register globally before route handlers
 * app.use(json);
 *
 * @see createMiddleware
 */
const json = createMiddleware((req, res, next) => {
  if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
    return next();
  }
  express.json()(req, res, next);
}, {
  name: "json",
  description: "Selectively applies JSON body parsing, passing multipart requests through unchanged."
});

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(json, "json", {
  value: json
}));