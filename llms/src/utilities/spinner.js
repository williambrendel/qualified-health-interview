/** @file spinner.js
 * @brief Terminal braille-frame spinner implemented as a class.
 *
 * Each {@link Spinner} instance owns its own frame counter and interval
 * handle, so multiple spinners can run concurrently without interference.
 *
 * A module-level default instance (`DEFAULT`) is created automatically.
 * The static helpers `Spinner.spin`, `Spinner.start`, `Spinner.end`,
 * `Spinner.isSpinning`, and `Spinner.reset` delegate to that default instance,
 * so callers that only need one shared spinner never have to instantiate
 * anything. `Spinner.create` is a convenience factory for new instances.
 *
 * @example
 * // Static API (default instance)
 * Spinner.start("Loading...");
 * Spinner.end();
 *
 * @example
 * // Factory
 * const s = Spinner.create("Building...");
 * s.start();
 * s.end();
 *
 * @example
 * // Direct instantiation + fluent chain
 * new Spinner("Processing...").start();
 *
 * @example
 * // Custom frame set
 * const s = new Spinner("Thinking...", 80, ["◐","◓","◑","◒"]);
 * s.start();
 */
"use strict";

/** @type {string[]} Default braille animation frames. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * @class Spinner
 * @brief Terminal braille-frame spinner.
 *
 * @details
 * Writes animated frames to stdout using `\r` to overwrite the current line
 * in place. Each instance tracks its own frame counter (`frameId`) and
 * interval handle (`timeoutId`) independently.
 *
 * Static helpers delegate to a shared module-level default instance for
 * convenience. A custom frame array can be supplied per-instance via the
 * `frames` constructor parameter.
 */
class Spinner {

  /**
   * @brief Constructs a new Spinner.
   *
   * @param {string}   [message="Loading..."] Default label shown beside the frame.
   * @param {number}   [ms=300]               Default interval period in milliseconds.
   * @param {string[]} [frames=FRAMES]        Animation frame array. Defaults to the
   *                                          module-level braille FRAMES constant.
   */
  constructor(message = "Loading...", ms = 300, frames = FRAMES) {
    /** @type {string}   Default label printed beside each frame. */
    this.message = message;
    /** @type {number}   Default interval period in milliseconds. */
    this.ms = ms;
    /** @type {number}   Current frame index. Advanced on every {@link Spinner#spin} call. */
    this.frameId = 0;
    /** @type {ReturnType<typeof setInterval>|null} Active interval handle, or null when stopped. */
    this.timeoutId = null;
    /** @type {string[]} Animation frames used by this instance. */
    this.frames = frames;
  }

  /**
   * @brief Writes one frame to stdout and advances the frame counter.
   *
   * @param {string} [message=this.message] Label to print beside the frame.
   *
   * @returns {this} The spinner instance (chainable).
   */
  spin(message = this.message) {
    process.stdout.write(`\r${this.frames[this.frameId]} ${message}`);
    this.frameId = (this.frameId + 1) % this.frames.length;
    return this;
  }

  /**
   * @brief Starts the spinner interval.
   *
   * If an interval is already running it is stopped first, so there is never
   * more than one active interval per instance.
   *
   * @param {string} [message=this.message] Label forwarded to {@link Spinner#spin} on each tick.
   * @param {number} [ms=this.ms]           Interval period in milliseconds.
   *
   * @returns {this} The spinner instance (chainable).
   */
  start(message = this.message, ms = this.ms) {
    if (this.timeoutId !== null) this.end();
    this.timeoutId = setInterval(() => this.spin(message), ms);
    return this;
  }

  /**
   * @brief Stops the spinner interval.
   *
   * Safe to call when no interval is active.
   *
   * @returns {this} The spinner instance (chainable).
   */
  end() {
    clearInterval(this.timeoutId);
    this.timeoutId = null;
    return this;
  }

  /**
   * @brief Returns whether the spinner interval is currently active.
   *
   * @returns {boolean} `true` if an interval is running.
   */
  isSpinning() {
    return this.timeoutId !== null;
  }

  /**
   * @brief Resets the frame counter to 0.
   *
   * Does not affect the interval — the spinner keeps running if it was
   * already started.
   *
   * @returns {this} The spinner instance (chainable).
   */
  reset() {
    this.frameId = 0;
    return this;
  }
}

/** @type {Spinner} Shared default instance used by all static helpers. */
const DEFAULT = new Spinner();

/**
 * @brief Factory — creates and returns a new {@link Spinner} instance.
 * @param {...*} args Forwarded to the {@link Spinner} constructor.
 * @returns {Spinner}
 */
const create = (...args) => new Spinner(...args);

/**
 * @brief Writes one frame via the default instance.
 * @param {...*} args Forwarded to {@link Spinner#spin}.
 * @returns {Spinner} The default instance (chainable).
 */
const spin = (...args) => DEFAULT.spin(...args);

/**
 * @brief Starts the default instance interval.
 * @param {...*} args Forwarded to {@link Spinner#start}.
 * @returns {Spinner} The default instance (chainable).
 */
const start = (...args) => DEFAULT.start(...args);

/**
 * @brief Stops the default instance interval.
 * @param {...*} args Forwarded to {@link Spinner#end}.
 * @returns {Spinner} The default instance (chainable).
 */
const end = (...args) => DEFAULT.end(...args);

/**
 * @brief Resets the default instance frame counter to 0.
 * @param {...*} args Forwarded to {@link Spinner#reset}.
 * @returns {Spinner} The default instance (chainable).
 */
const reset = (...args) => DEFAULT.reset(...args);

/**
 * @brief Returns whether the default instance interval is active.
 * @param {...*} args Forwarded to {@link Spinner#isSpinning}.
 * @returns {boolean}
 */
const isSpinning = (...args) => DEFAULT.isSpinning(...args);

/**
 * @ignore
 */
Spinner.FRAMES     = FRAMES;
Spinner.DEFAULT    = DEFAULT;
Spinner.create     = create;
Spinner.spin       = spin;
Spinner.start      = start;
Spinner.end        = end;
Spinner.reset      = reset;
Spinner.isSpinning = isSpinning;
module.exports = Object.freeze(Object.defineProperty(Spinner, "Spinner", {
  value: Spinner
}));