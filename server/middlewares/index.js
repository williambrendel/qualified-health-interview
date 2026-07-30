"use strict";

const registerMiddleware = require("../core/registerMiddleware");

// Register middlewares.
const cors = registerMiddleware(require("./cors"));
const json = registerMiddleware(require("./json"));
const multipart = registerMiddleware(require("./multipart"));

/**
 * @ignore
 * Export.
 */
module.exports = {
  cors, // Enable CORS for all routes.
  json, // Parse JSON request bodies, except for multipart form data.
  multipart // Parse multipart inputs
}