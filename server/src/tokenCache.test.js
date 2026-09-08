const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("device tokens survive a token cache module reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-token-cache-"));
  const cacheFile = path.join(dir, "tokens.json");
  const previousFile = process.env.JF_TOKEN_CACHE_FILE;
  process.env.JF_TOKEN_CACHE_FILE = cacheFile;
  const modulePath = require.resolve("./tokenCache");

  try {
    delete require.cache[modulePath];
    let cache = require("./tokenCache");
    cache.set("token:device-a", "device-token-a", 60_000);

    delete require.cache[modulePath];
    cache = require("./tokenCache");
    assert.equal(cache.get("token:device-a"), "device-token-a");

    cache.clear();
    delete require.cache[modulePath];
    cache = require("./tokenCache");
    assert.equal(cache.get("token:device-a"), null);
  } finally {
    delete require.cache[modulePath];
    if (previousFile === undefined) delete process.env.JF_TOKEN_CACHE_FILE;
    else process.env.JF_TOKEN_CACHE_FILE = previousFile;
  }
});
