"use strict";

const { extname } = require("node:path");

/**
 * @module extensionFilter
 * @description Per-route middleware factory that rejects uploads whose
 * file extension isn't in the allowed set.
 *
 * ## Why a factory, not a registered middleware
 *
 * `extensionFilter` is fundamentally different from the auto-registered
 * middlewares in `middlewares/index.js` (cors, json, multipart):
 *
 *   - It's PARAMETERIZED — needs a Set of allowed extensions per use.
 *   - It's PER-ROUTE — not every endpoint wants this gate; one
 *     accepting images would parameterize with `{".png", ".jpg"}`.
 *   - There's no canonical singleton to register.
 *
 * So instead of `registerMiddleware(require("./extensionFilter"))`, the
 * factory is imported by endpoints that want it and applied per-route:
 *
 *   const extensionFilter = require("../../middlewares/extensionFilter");
 *   const { SUPPORTED_EXTENSIONS } = require("../../../core/constants");
 *   // ... then in the endpoint definition:
 *   //   createEndpoint("post", "/parse", extensionFilter(SUPPORTED_EXTENSIONS), parse)
 *
 * ## Why not gate inside multer's fileFilter?
 *
 * Multer's `fileFilter` is the obvious place. The reason we don't use
 * it: multer's filter conflates "couldn't accept the file" with
 * "couldn't read the request," and it short-circuits with non-uniform
 * error shapes (sometimes 500-class, sometimes silent drop with
 * `req.file === undefined`). A dedicated middleware after multer has
 * already populated `req.file` lets us return a clean, intentional 400
 * with a list of acceptable extensions — better UX, easier to test.
 *
 * ## Behaviour
 *
 *   - No `req.file`? → next() (delegate the "no file" case to the route
 *     handler, which usually has its own 400 path). This middleware's
 *     concern is type, not presence.
 *   - Extension in set? → next().
 *   - Extension NOT in set? → 400 with `{ error: "...", allowed: [...] }`.
 *
 * Comparison is lowercased; the set itself should already be lowercase.
 */

const extensionFilter = (allowedExtensions) => {
  if (!(allowedExtensions instanceof Set) || allowedExtensions.size === 0) {
    throw new Error("extensionFilter: allowedExtensions (non-empty Set) is required");
  }
  return (req, res, next) => {
    if (!req.file || !req.file.originalname) return next();
    const ext = extname(req.file.originalname).toLowerCase();
    if (allowedExtensions.has(ext)) return next();
    res.status(400).json({
      error: `Unsupported file extension: ${ext || "(none)"}.`,
      allowed: [...allowedExtensions].sort(),
    });
  };
};

module.exports = Object.freeze(Object.defineProperty(extensionFilter, "extensionFilter", {
  value: extensionFilter,
}));
