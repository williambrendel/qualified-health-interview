"use strict";

/**
 * @file spinner.test.js
 * @brief Unit tests for the Spinner class.
 *
 * process.stdout.write is mocked at the module level so terminal output
 * does not pollute the test runner. Suites cover: constructor, instance
 * spin/frame cycling, custom frames, interval lifecycle, reset,
 * per-instance isolation, static delegation to DEFAULT, and export shape.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock process.stdout.write
// ─────────────────────────────────────────────────────────────────────────────

const mockWrite = jest.fn();

beforeAll(() => {
  jest.spyOn(process.stdout, "write").mockImplementation(mockWrite);
});

afterAll(() => {
  process.stdout.write.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────

const Spinner = require("../../src/utilities/spinner");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Returns all strings written to stdout since the last flush. */
const flushFrames = () => {
  const calls = mockWrite.mock.calls.map(([str]) => str);
  mockWrite.mockClear();
  return calls;
};

/** Extracts the frame character from a stdout write string. */
const frameChar = (str) => [...str][1];

// Helper to create spinner instances (Spinner.create is the factory method)
const create = (...args) => Spinner.create(...args);

beforeEach(() => {
  mockWrite.mockClear();
  jest.useFakeTimers();

  // Ensure DEFAULT is clean between tests
  if (Spinner.DEFAULT && Spinner.DEFAULT.end) {
    Spinner.DEFAULT.end();
    Spinner.DEFAULT.reset();
  }
});

afterEach(() => {
  jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// spin()
// ─────────────────────────────────────────────────────────────────────────────

describe("spin()", () => {
  test("cycles through all 10 frames in order", () => {
    const s = create();
    
    // Call spin 10 times to get all frames
    for (let i = 0; i < 10; i++) {
      s.spin("x");
    }
    
    const outputs = flushFrames();
    const seen = outputs.map(f => frameChar(f));
    expect(seen).toEqual(FRAMES);
  });

  test("wraps around on the 11th call (frame index 0 again)", () => {
    const s = create();
    
    // Call spin 11 times
    for (let i = 0; i < 11; i++) {
      s.spin("x");
    }
    
    const outputs = flushFrames();
    const seen = outputs.map(f => frameChar(f));
    // First 10 should be all frames, 11th should be first frame again
    expect(seen[0]).toBe(FRAMES[0]);
    expect(seen[10]).toBe(FRAMES[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSpinning()
// ─────────────────────────────────────────────────────────────────────────────

describe("isSpinning()", () => {
  test("returns false before start() is called", () => {
    const s = create("msg");
    expect(s.isSpinning()).toBe(false);
  });

  test("returns true while interval is active", () => {
    const s = create("x");
    s.start();
    jest.advanceTimersByTime(1);
    expect(s.isSpinning()).toBe(true);
    s.end();
  });

  test("returns false after end() is called", () => {
    const s = create("x");
    s.start();
    s.end();
    expect(s.isSpinning()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create() factory — shape
// ─────────────────────────────────────────────────────────────────────────────

describe("create() factory — shape", () => {
  test("returns an object with spin, start, end, isSpinning methods", () => {
    const s = create("msg");
    expect(typeof s.spin).toBe("function");
    expect(typeof s.start).toBe("function");
    expect(typeof s.end).toBe("function");
    expect(typeof s.isSpinning).toBe("function");
    expect(typeof s.reset).toBe("function");
  });

  test("spin() is chainable — returns the spinner instance", () => {
    const s = create("msg");
    expect(s.spin()).toBe(s);
  });

  test("start() is chainable — returns the spinner instance", () => {
    const s = create("msg");
    expect(s.start()).toBe(s);
    s.end();
  });

  test("end() is chainable — returns the spinner instance", () => {
    const s = create("msg");
    s.start();
    expect(s.end()).toBe(s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create() factory — message
// ─────────────────────────────────────────────────────────────────────────────

describe("create() factory — message", () => {
  test("spin() uses the instance default message", () => {
    const s = create("my-label");
    s.spin();
    const [output] = flushFrames();
    expect(output).toMatch(/my-label/);
  });

  test("spin() accepts a one-off message override", () => {
    const s = create("default");
    s.spin("override");
    const [output] = flushFrames();
    expect(output).toMatch(/override/);
    expect(output).not.toMatch(/default/);
  });

  test("start() uses the instance default message on each tick", () => {
    const s = create("tick-label", 300);
    s.start();
    jest.advanceTimersByTime(900);
    const frames = flushFrames();
    expect(frames.every(f => f.includes("tick-label"))).toBe(true);
    s.end();
  });

  test("start() accepts a one-off message override", () => {
    const s = create("default", 300);
    s.start("override");
    jest.advanceTimersByTime(300);
    const frames = flushFrames();
    expect(frames[0]).toMatch(/override/);
    s.end();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create() factory — isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("create() factory — isolation", () => {
  test("two instances write their own labels without interfering", () => {
    const s1 = create("AAA", 300);
    const s2 = create("BBB", 300);
    
    s1.start();
    s2.start();
    
    jest.advanceTimersByTime(300);
    
    const frames = flushFrames();
    expect(frames.some(f => f.includes("AAA"))).toBe(true);
    expect(frames.some(f => f.includes("BBB"))).toBe(true);
    
    s1.end();
    s2.end();
  });

  test("ending one instance does not stop the other", () => {
    const s1 = create("AAA", 300);
    const s2 = create("BBB", 300);
    
    s1.start();
    s2.start();
    
    s1.end();
    
    mockWrite.mockClear();
    
    jest.advanceTimersByTime(300);
    
    const frames = flushFrames();
    expect(frames.some(f => f.includes("BBB"))).toBe(true);
    
    s2.end();
  });

  test("instance end() does not clear the module-level timeoutId", () => {
    // Start the module-level DEFAULT spinner
    Spinner.start("module-level", 300);
    
    const s = create("instance");
    s.start();
    s.end();
    
    mockWrite.mockClear();
    
    // DEFAULT should still be spinning
    jest.advanceTimersByTime(300);
    const frames = flushFrames();
    expect(frames.some(f => f.includes("module-level"))).toBe(true);
    
    Spinner.end();
  });

  test("isSpinning() on one instance is unaffected by the other", () => {
    const s1 = create("A");
    const s2 = create("B");
    
    s1.start();
    
    expect(s2.isSpinning()).toBe(false);
    
    s1.end();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reset() functionality
// ─────────────────────────────────────────────────────────────────────────────

describe("reset()", () => {
  test("reset() resets the frame counter to 0", () => {
    const s = create();
    
    s.spin(); // frame 0
    s.spin(); // frame 1
    s.spin(); // frame 2
    
    expect(s.frameId).toBe(3);
    
    s.reset();
    
    expect(s.frameId).toBe(0);
  });
  
  test("reset() does not stop a running interval", () => {
    const s = create("test", 300);
    s.start();
    s.reset();
    expect(s.isSpinning()).toBe(true);
    s.end();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static method delegation
// ─────────────────────────────────────────────────────────────────────────────

describe("static method delegation", () => {
  test("Spinner.start() delegates to DEFAULT", () => {
    const spy = jest.spyOn(Spinner.DEFAULT, "start");
    Spinner.start("test", 100);
    expect(spy).toHaveBeenCalledWith("test", 100);
    Spinner.end();
    spy.mockRestore();
  });
  
  test("Spinner.end() delegates to DEFAULT", () => {
    const spy = jest.spyOn(Spinner.DEFAULT, "end");
    Spinner.start();
    Spinner.end();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  
  test("Spinner.isSpinning() delegates to DEFAULT", () => {
    const spy = jest.spyOn(Spinner.DEFAULT, "isSpinning");
    Spinner.isSpinning();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});