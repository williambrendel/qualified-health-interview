"use strict";

/**
 * @file httpCache.js
 * @module server/core/httpCache
 * @description Shared HTTP response-caching helpers, extracted from the /model
 * endpoint so every GET that returns a deterministic payload revalidates the
 * same way (/model, /series, …).
 *
 * A weak content `ETag` (identical payload ⇒ identical ETag) plus a
 * `sendCacheable` that sets the ETag + `Cache-Control: private, no-cache` and
 * returns `304` (no body) when the client's `If-None-Match` already matches.
 * The payload is expected to be deterministic per some version/state, so the
 * client can cache and cheaply revalidate.
 */

const crypto = require("crypto");
const { statuses } = require("./httpCodes");
const { OK, NOT_MODIFIED } = statuses;

/** Weak content ETag — identical payload ⇒ identical ETag. */
const etagOf = (payload) =>
  'W/"' + crypto.createHash("sha1").update(JSON.stringify(payload)).digest("base64") + '"';

/**
 * Send a cacheable JSON result: sets ETag + Cache-Control, and returns 304 (no
 * body) when the client's If-None-Match already matches.
 */
const sendCacheable = (req, res, payload) => {
  const etag = etagOf(payload);
  res.set("ETag", etag);
  res.set("Cache-Control", "private, no-cache"); // deterministic; revalidate via ETag
  if (req.headers["if-none-match"] === etag) {
    res.status(NOT_MODIFIED).end();
    return;
  }
  res.status(OK).json(payload);
};

module.exports = Object.freeze({ etagOf, sendCacheable });
