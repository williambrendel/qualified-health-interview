"use strict";

const multer = require("multer");
const { createMiddleware } = require("../core");

/**
 * @module multipart
 * @description Multer middleware for `multipart/form-data` file uploads.
 * Pure transport: parses the multipart body into `req.file`. No format
 * gating — that's a separate concern, handled by `extensionFilter` mounted
 * per-route on endpoints that have specific format requirements.
 *
 * Memory storage is used (rather than disk) because the parser's
 * `parseBuffer(buffer, filename)` accepts a Buffer directly — no disk
 * round-trip, no tempfile lifecycle. Chemical test logs are small
 * (<100 KB typical), and the 10 MB cap gives ~150x headroom over realistic
 * worst cases.
 *
 * @see createMiddleware
 * @see registerMiddleware
 * @see extensionFilter — applied per-route when an endpoint wants to gate
 *   uploads to a specific set of file types.
 */

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * @function multipart
 * @description
 * Express middleware that accepts a single file upload under field name `file`
 * via `multer.memoryStorage()`. The parsed file lands at `req.file` with the
 * shape `{ buffer, originalname, size, mimetype, ... }`.
 *
 * @example
 * // Mounted globally via server/middlewares/index.js
 * // Per-route format-gating: add `extensionFilter(SUPPORTED_EXTENSIONS)`.
 * app.post("/parse", extensionFilter(SUPPORTED_EXTENSIONS), parse);
 *
 * @see createMiddleware
 */
const multipart = createMiddleware(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  }).single("file"),
  {
    name: "multipart",
    description: "Accepts a single multipart/form-data upload at req.file (memory storage, 10MB cap). Format gating is the responsibility of per-route filters, not this middleware.",
  },
);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperties(multipart, {
  multipart:             { value: multipart },
  MAX_FILE_SIZE_BYTES:   { value: MAX_FILE_SIZE_BYTES },
}));