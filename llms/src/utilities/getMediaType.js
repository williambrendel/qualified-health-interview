"use strict";
const path = require("path");

/**
 * @file getMediaType.js
 * @brief MIME type resolver and static registry for common file extensions.
 *
 * Exports a single function that resolves a standardized MIME media type from
 * a raw extension, dot-prefixed extension, filename, or full file path.
 * Resolution is case-insensitive and falls back to a caller-supplied default
 * or `"text/plain"` when no match is found.
 *
 * All registered types are mirrored with dot-prefixed keys so both `"pdf"`
 * and `".pdf"` resolve identically. The function object itself carries all
 * type entries as static properties for direct access (e.g. `getMediaType.pdf`),
 * and is frozen to prevent runtime modification of the registry.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types
 */

/**
 * @function getMediaType
 * @description
 * Resolves a standardized MIME media type from a provided file extension, 
 * filename, or full file path.
 * This utility serves as both a lookup function and a static registry. It 
 * automatically handles case-insensitivity and parses file paths to extract 
 * extensions. If a direct match is not found, it falls back to a provided 
 * default or the internal global default.
 * 
 * @param {string} [input=""] 
 * The string to resolve. Supports raw extensions ("pdf"), dotted extensions 
 * (".PDF"), or full paths ("/path/to/file.docx").
 * 
 * @param {string} [defaultType=getMediaType.default] 
 * An optional fallback value to return if the input cannot be resolved. 
 * Defaults to "text/plain".
 * 
 * @returns {string} 
 * The resolved MIME media type. Returns `defaultType` (or an empty string if 
 * no defaults are available) upon resolution failure.
 * 
 * @property {string} txt - "text/plain"
 * @property {string} pdf - "application/pdf"
 * @property {string} doc - "application/msword"
 * @property {string} docx - "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 * @property {string} xml - "application/xml"
 * @property {string} csv - "application/csv"
 * @property {string} md  - "text/plain"
 * @property {string} default - Global fallback: "text/plain"
 * 
 * @example
 * const getMediaType = require("./mediaTypes");
 * // 1. Standard resolution
 * getMediaType("report.pdf");       // "application/pdf"
 * // 2. Case-insensitive and dot-prefixed support
 * getMediaType(".DOCX");           // "application/vnd..."
 * // 3. Custom fallback override
 * getMediaType("unknown.xyz", "application/octet-stream"); // "application/octet-stream"
 * // 4. Direct property access
 * const mime = getMediaType.csv;    // "application/csv"
 * 
 * @notes
 * - The function object is **frozen**; registry entries are immutable at runtime.
 * - All defined types are automatically mirrored with dot-prefixed keys 
 * (e.g., `getMediaType[".pdf"] === getMediaType["pdf"]`).
 * - For backward compatibility, the function is also accessible via the 
 * `.MEDIA_TYPES` property.
 * 
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types
 */

const MEDIA_TYPES = {
  txt: "text/plain",
  text: "text/plain",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xml: "application/xml",
  csv: "application/csv",
  markdown: "text/markdown",
  md: "text/markdown",
  ppl: "text/plain",
  dsl: "text/plain",
  toon: "text/toon",
  moon: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
}

// Add dot-prefixed keys.
for (const k in MEDIA_TYPES) MEDIA_TYPES[`.${k}`] = MEDIA_TYPES[k];

// Add default type.
MEDIA_TYPES.default = MEDIA_TYPES.txt;

// Function to get media type.
const getMediaType = (input, defaultType = MEDIA_TYPES.default) => (
  MEDIA_TYPES[input || (input = "")]
    || MEDIA_TYPES[input = input.toLowerCase()]
    || MEDIA_TYPES[path.extname(input)]
    || MEDIA_TYPES[path.basename(input)]
    || defaultType
    || ""
);

// Backward compatibility.
Object.assign(getMediaType, MEDIA_TYPES).MEDIA_TYPES = MEDIA_TYPES;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(getMediaType, "getMediaType", {
  value: getMediaType
}));