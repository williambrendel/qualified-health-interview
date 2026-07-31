const path = require("path");
const { env } = require("@xenova/transformers");

// Force a fresh download and bypass potential local cache issues
env.allowLocalModels = false;
env.allowRemoteModels = true; // Set to true once to download, then false to lock
env.useBrowserCache = false;
env.localModelPath = path.join(__dirname, "../../models");
env.cacheDir = path.join(__dirname, "../../.model_cache"); // Custom cache dir to avoid system-wide corruption