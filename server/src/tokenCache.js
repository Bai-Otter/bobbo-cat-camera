/**
 * deviceToken 缓存
 * - deviceToken 有效 24 小时,缓存避免每次请求重新绑定
 * - deviceToken 持久化到本地运行时文件，服务重启后继续使用
 * - 直播 url 默认有效 10 小时,同样缓存
 */
const fs = require("node:fs");
const path = require("node:path");

const TTL_TOKEN = 23 * 60 * 60 * 1000; // 留 1 小时余量
const TTL_URL = 9 * 60 * 60 * 1000;
const CACHE_FILE = process.env.JF_TOKEN_CACHE_FILE || path.join(__dirname, "../data/token-cache.json");

const store = {
  token: { value: null, expireAt: 0 },
  webrtcUrl: { value: null, expireAt: 0 },
  hlsUrl: { value: null, expireAt: 0 },
};

function isDeviceTokenKey(key) {
  return key === "token" || String(key || "").startsWith("token:");
}

function persistDeviceTokens() {
  const entries = {};
  for (const [key, item] of Object.entries(store)) {
    if (isDeviceTokenKey(key) && item?.value && item.expireAt > Date.now()) {
      entries[key] = item;
    }
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ entries }, null, 2));
}

function loadDeviceTokens() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    for (const [key, item] of Object.entries(parsed.entries || {})) {
      if (!isDeviceTokenKey(key) || !item?.value || Number(item.expireAt) <= Date.now()) continue;
      store[key] = { value: item.value, expireAt: Number(item.expireAt) };
    }
  } catch (error) {
    // Missing or incomplete runtime cache is equivalent to an empty cache.
  }
}

loadDeviceTokens();

function get(key) {
  const item = store[key];
  if (!item) return null;
  if (Date.now() > item.expireAt) {
    store[key] = { value: null, expireAt: 0 };
    if (isDeviceTokenKey(key)) persistDeviceTokens();
    return null;
  }
  return item.value;
}

function set(key, value, ttl) {
  store[key] = { value, expireAt: Date.now() + ttl };
  if (isDeviceTokenKey(key)) persistDeviceTokens();
}

function remove(key) {
  delete store[key];
  if (isDeviceTokenKey(key)) persistDeviceTokens();
}

function clear() {
  for (const k of Object.keys(store)) {
    store[k] = { value: null, expireAt: 0 };
  }
  persistDeviceTokens();
}

module.exports = { get, set, remove, clear, TTL_TOKEN, TTL_URL };
