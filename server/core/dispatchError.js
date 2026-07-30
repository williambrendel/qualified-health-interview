"use strict";

/**
 * @function displayError
 * @description Default error handler. Prints the error to `console.error`.
 * Used as the fallback `onerror` callback in {@link dispatchError} when none
 * is provided.
 *
 * @param {Error} error - The error to display.
 * @returns {void}
 *
 * @see dispatchError
 */
const displayError = error => console.error(error);

/**
 * @function dispatchError
 * @description Normalizes and dispatches an error value to a callback. If `error` is
 * truthy but not an `Error` instance, it is coerced via `Error(error)`. The callback
 * defaults to {@link displayError} when `onerror` is `undefined`. Passing `null` or
 * `false` as `onerror` explicitly suppresses dispatch.
 *
 * @param {Error|string|*} error       - The error to dispatch. Falsy values are
 *   silently ignored.
 * @param {Function|null|undefined} [onerror] - Callback invoked with the normalized
 *   `Error` instance. Defaults to {@link displayError} when `undefined`. Pass `null`
 *   or `false` to suppress dispatch entirely.
 *
 * @returns {Error|null} The input error, encapsulated in Error if needed, or null if the error is empty.
 *   Note: 0, "", false are not valid errors anyways.
 *
 * @example
 * // Default handler (console.error)
 * dispatchError("something went wrong");
 *
 * @example
 * // Custom handler
 * dispatchError(new Error("db failure"), err => logger.error(err.message));
 *
 * @example
 * // Suppressed — onerror is null
 * dispatchError("ignored", null);
 *
 * @see displayError
 */
const dispatchError = (error, onerror) => error && (
  error instanceof Error || (error = Error(error)),
  onerror === undefined && (onerror = displayError),
  typeof onerror === "function" && onerror(error),
  error || null
);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(dispatchError, "dispatchError", {
  value: dispatchError
}));