"use strict";

/**
 * @type {number}
 * @description Default port the HTTP server listens on when no port is explicitly
 * provided to {@link App#listen}.
 */
const DEFAULT_PORT = 8080;

/**
 * @type {object|null}
 * @description The module-level default Express app instance. Set once via
 * {@link setDefaultApp}. Endpoints registered without an explicit app are stored under
 * `null` and attached to this instance when {@link attachRegisteredEndpoints} is called.
 */
let DEFAULT_APP = null;

/**
 * @function setDefaultApp
 * @description Sets the module-level default app instance, used by
 * {@link attachRegisteredEndpoints} when no explicit app is provided. A no-op if
 * `DEFAULT_APP` has already been set.
 *
 * @param {object} app - The Express app instance to designate as the default.
 *
 * @returns {object|null} The newly assigned default app, or the pre-existing value if
 *   already set.
 *
 * @example
 * const app = express();
 * setDefaultApp(app);
 *
 * @see attachRegisteredEndpoints
 * @see isDefaultApp
 */
const setDefaultApp = app => DEFAULT_APP || (DEFAULT_APP = app);

/**
 * @function getDefaultApp
 * @description Returns the current module-level default app instance, or `null` if
 * {@link setDefaultApp} has not yet been called.
 *
 * @returns {object|null} The default app instance, or `null`.
 *
 * @example
 * const app = getDefaultApp(); // → App instance or null
 *
 * @see setDefaultApp
 * @see isDefaultApp
 */
const getDefaultApp = () => DEFAULT_APP;

/**
 * @function isDefaultApp
 * @description Returns `true` if the given app is the module-level default app, or if
 * no app is provided (`null` / `undefined`). Used to determine whether an operation
 * should fall back to or also apply to the default app bucket.
 *
 * @param {object|null} [app] - The app instance to test. A falsy value is treated as
 *   a reference to the default app and always returns `true`.
 *
 * @returns {boolean} `true` if `app` is falsy or strictly equal to {@link DEFAULT_APP}.
 *
 * @example
 * isDefaultApp(app);   // → true if app === DEFAULT_APP
 * isDefaultApp(null);  // → true
 * isDefaultApp(other); // → false
 *
 * @see setDefaultApp
 */
const isDefaultApp = app => !app || app === DEFAULT_APP;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze({
  DEFAULT_PORT,
  getDefaultApp,
  setDefaultApp,
  isDefaultApp
});