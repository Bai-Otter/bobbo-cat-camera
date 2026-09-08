const test = require("node:test");
const assert = require("node:assert/strict");

const {
	DEFAULT_BACKEND_BASE_URL,
	clearAppSession,
	readAppAuthState,
	resolveBackendBaseUrl,
	saveAppSession,
	setBackendBaseUrl,
} = require("./appAuth.js");
const { BACKEND_RUNTIME } = require("../config/backend.js");

function createUniStorage() {
  const store = new Map();
  return {
    getStorageSync(key) {
      return store.has(key) ? store.get(key) : "";
    },
    setStorageSync(key, value) {
      store.set(key, value);
    },
    removeStorageSync(key) {
      store.delete(key);
    },
  };
}

test("saveAppSession stores backend session and marks profile logged in", () => {
  const uniApi = createUniStorage();

  const profile = saveAppSession(
    {
      sessionToken: "session-123456",
      user: { id: "openid-1", openid: "openid-1", nickname: "Mimi", avatar: "cat.png" },
    },
    uniApi
  );
  const authState = readAppAuthState(uniApi);

  assert.equal(profile.loggedIn, true);
  assert.equal(profile.cloudOk, false);
  assert.equal(profile.openid, "openid-1");
  assert.equal(authState.hasSession, true);
  assert.equal(authState.sessionPreview, "sess...3456");
});

test("clearAppSession preserves profile but logs it out", () => {
  const uniApi = createUniStorage();
  saveAppSession({ sessionToken: "session-1", user: { id: "openid-1", openid: "openid-1" } }, uniApi);

  clearAppSession(uniApi);

  const authState = readAppAuthState(uniApi);
  assert.equal(authState.hasSession, false);
  assert.equal(authState.profile.loggedIn, false);
  assert.equal(authState.profile.openid, "openid-1");
});

test("setBackendBaseUrl trims trailing slashes", () => {
  const uniApi = createUniStorage();

  assert.equal(
    setBackendBaseUrl("http://192.168.2.131:8000///", uniApi),
    "http://192.168.2.131:8000"
  );
});

test("stored loopback backend url migrates to the configured default", () => {
  const uniApi = createUniStorage();

  setBackendBaseUrl("http://127.0.0.1:8000", uniApi);

  assert.equal(readAppAuthState(uniApi).backendBaseUrl, DEFAULT_BACKEND_BASE_URL);
});

test("saveAppSession preserves cached nickname and avatar when login response omits them", () => {
  const uniApi = createUniStorage();
  saveAppSession({
    sessionToken: "session-first",
    user: { openid: "openid-1", nickname: "陈柏希", avatar: "wxfile://store/avatar.jpg" },
  }, uniApi);

  const profile = saveAppSession({
    sessionToken: "session-repeat",
    user: { openid: "openid-1", nickname: "", avatar: "" },
  }, uniApi);

  assert.equal(profile.nickname, "陈柏希");
  assert.equal(profile.avatar, "wxfile://store/avatar.jpg");
});

test("stored former LAN backend url migrates to the active experience ingress", () => {
  const uniApi = createUniStorage();

  setBackendBaseUrl("http://172.20.10.3:8000", uniApi);

  const authState = readAppAuthState(uniApi);
  assert.equal(authState.backendBaseUrl, DEFAULT_BACKEND_BASE_URL);
  assert.equal(uniApi.getStorageSync("catBackendBaseUrl"), DEFAULT_BACKEND_BASE_URL);
});

test("stored production API domain migrates while the ICP gate is active", () => {
  const uniApi = createUniStorage();

  setBackendBaseUrl("https://api.example.com", uniApi);

  const authState = readAppAuthState(uniApi);
  assert.equal(authState.backendBaseUrl, DEFAULT_BACKEND_BASE_URL);
  assert.equal(uniApi.getStorageSync("catBackendBaseUrl"), DEFAULT_BACKEND_BASE_URL);
});

test("stored former temporary tunnels remain on the active experience ingress", () => {
  const uniApi = createUniStorage();

  setBackendBaseUrl("https://maple-reform-benjamin-metro.trycloudflare.com", uniApi);

  const authState = readAppAuthState(uniApi);
  assert.equal(authState.backendBaseUrl, DEFAULT_BACKEND_BASE_URL);
  assert.equal(uniApi.getStorageSync("catBackendBaseUrl"), DEFAULT_BACKEND_BASE_URL);
});

test("cloud hosting ignores a stale LAN URL stored by an earlier local build", () => {
	const runtime = {
		...BACKEND_RUNTIME,
		mode: "cloud-hosting",
		cloud: {
			...BACKEND_RUNTIME.cloud,
			publicBaseUrl: "https://cat-camera.example.com",
		},
	};

	assert.equal(
		resolveBackendBaseUrl("http://192.168.63.215:8000", runtime),
		"https://cat-camera.example.com"
	);
});
