const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("config defaults foodcast BGM directory to the repository catalog", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(require(${JSON.stringify(configPath)}).foodcast.bgmDir)`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      FOODCAST_BGM_DIR: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.resolve(__dirname, "../../bgm"));
});

test("FOODCAST_BGM_DIR overrides the default catalog directory", () => {
  const configPath = path.join(__dirname, "config.js");
  const customDir = path.join(__dirname, "fixtures", "custom-bgm");
  const script = `process.stdout.write(require(${JSON.stringify(configPath)}).foodcast.bgmDir)`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      FOODCAST_BGM_DIR: customDir,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, customDir);
});

test("FEED_ANALYSIS_ENABLED disables model analysis without disabling the server", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).analysis.enabled))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      FEED_ANALYSIS_ENABLED: "false",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), false);
});

test("feeding analysis caps accelerated low-bandwidth playback at eight-speed", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).analysis))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      FEED_ANALYSIS_PLAYBACK_SPEED: "16",
      FEED_ANALYSIS_PLAYBACK_STREAM_TYPE: "1",
      FEED_ANALYSIS_SCREENING_SAMPLE_SECONDS: "99",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const analysis = JSON.parse(result.stdout);
  assert.equal(analysis.playbackSpeed, 8);
  assert.equal(analysis.playbackStreamType, 1);
  assert.equal(analysis.screeningSampleSeconds, 10);
  assert.equal(analysis.orientation, "clockwise-90");
});

test("feeding analysis defaults to eight-speed low-bandwidth playback", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).analysis))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const analysis = JSON.parse(result.stdout);
  assert.equal(analysis.playbackSpeed, 8);
  assert.equal(analysis.playbackStreamType, 1);
  assert.equal(analysis.feedingStart.enabled, true);
  assert.equal(analysis.feedingStart.windowMs, 30_000);
  assert.equal(analysis.feedingStart.maxWindowMs, 45_000);
  assert.equal(analysis.feedingStart.rearmQuietMs, 600_000);
  assert.deepEqual(analysis.feedingStart.confirmationPolicy, {
    minActualEatingSeconds: 6,
    minSpanSeconds: 8,
    minConfidence: 0.6,
    maxEvidenceAgeSeconds: 5,
  });
});

test("foodcast material automation exposes durable defaults and environment overrides", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).foodcast.materials))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      FOODCAST_MATERIAL_COLLECTION: "custom_materials",
      FOODCAST_MATERIAL_RETENTION_DAYS: "7",
      FOODCAST_MEAL_GAP_MINUTES: "12",
      FOODCAST_JOB_LEASE_SECONDS: "90",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const materials = JSON.parse(result.stdout);
  assert.equal(materials.collection, "custom_materials");
  assert.equal(materials.retentionMs, 7 * 86_400_000);
  assert.equal(materials.mealGapMs, 12 * 60_000);
  assert.equal(materials.leaseMs, 90_000);
  assert.match(materials.stateFile, /foodcast-materials\.sqlite$/);
});

test("Cloud Hosting rejects a missing application session secret", () => {
  const configPath = path.join(__dirname, "config.js");
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(configPath)})`], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      WECHAT_CLOUD_HOSTING: "true",
      APP_SESSION_SECRET: "",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /JF_APPSECRET=test/);
});

test("Cloud Hosting rejects missing CloudBase database credentials", () => {
  const configPath = path.join(__dirname, "config.js");
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(configPath)})`], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      WECHAT_CLOUD_HOSTING: "true",
      APP_SESSION_SECRET: "test-session-secret-with-32-bytes-minimum",
      DEVICE_REGISTRY_BACKEND: "cloudbase",
      CLOUDBASE_SECRET_ID: "",
      CLOUDBASE_SECRET_KEY: "",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLOUDBASE_SECRET_ID/);
});

test("Cloud Hosting rejects a missing public media base URL", () => {
  const configPath = path.join(__dirname, "config.js");
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(configPath)})`], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      WECHAT_CLOUD_HOSTING: "true",
      APP_SESSION_SECRET: "test-session-secret-with-32-bytes-minimum",
      DEVICE_REGISTRY_BACKEND: "cloudbase",
      CLOUDBASE_SECRET_ID: "secret-id-test",
      CLOUDBASE_SECRET_KEY: "secret-key-test",
      PUBLIC_BASE_URL: "",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUBLIC_BASE_URL/);
});

test("security config exposes signed session and durable registry settings", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)})))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      WECHAT_CLOUD_HOSTING: "true",
      APP_SESSION_SECRET: "test-session-secret-with-32-bytes-minimum",
      APP_SESSION_TTL_MS: "12345",
      LEGACY_DEVICE_OWNER_OPENID: "openid-owner",
      DEVICE_REGISTRY_BACKEND: "cloudbase",
      CLOUDBASE_ENV_ID: "env-test",
      CLOUDBASE_SECRET_ID: "secret-id-test",
      CLOUDBASE_SECRET_KEY: "secret-key-test",
      PUBLIC_BASE_URL: "https://media.example.test/",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.session.secret, "test-session-secret-with-32-bytes-minimum");
  assert.equal(config.session.ttlMs, 12345);
  assert.equal(config.legacyDeviceOwnerOpenid, "openid-owner");
  assert.equal(config.deviceRegistryBackend, "cloudbase");
  assert.equal(config.cloudbaseEnvId, "env-test");
  assert.equal(config.cloudbaseCredentials.secretId, "secret-id-test");
  assert.equal(config.cloudbaseCredentials.secretKey, "secret-key-test");
  assert.equal(config.publicBaseUrl, "https://media.example.test");
});

test("self-hosted WeChat login configuration stays on the server", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).wechat))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      WECHAT_APP_ID: "touristappid",
      WECHAT_APP_SECRET: "server-only-secret",
      WECHAT_LOGIN_TIMEOUT_MS: "4321",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    appId: "touristappid",
    appSecret: "server-only-secret",
    timeoutMs: 4321,
    miniCodeEnvVersion: "trial",
    envVersion: "trial",
  });
});

test("WeChat device message configuration supports trial templates without exposing client secrets", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).wechatDeviceMessages))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      JF_UUID: "test",
      JF_APPKEY: "test",
      JF_APPSECRET: "test",
      JF_MOVECARD: "1",
      JF_DEVICE_SN: "test",
      JF_DEVICE_USERNAME: "test",
      JF_ENDPOINT: "https://example.test",
      WECHAT_DEVICE_MESSAGE_MODEL_ID: "model-1",
      WECHAT_DEVICE_MESSAGE_START_TEMPLATE_ID: "tmpl-start",
      WECHAT_DEVICE_MESSAGE_END_TEMPLATE_ID: "tmpl-end",
      WECHAT_DEVICE_MESSAGE_START_DATA_JSON: '{"status1":{"value":"{{eventStatus}}"}}',
      WECHAT_DEVICE_MESSAGE_END_DATA_JSON: '{"time2":{"value":"{{eventTime}}"}}',
      WECHAT_DEVICE_MESSAGE_MINIPROGRAM_STATE: "trial",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    modelId: "model-1",
    startTemplateId: "tmpl-start",
    endTemplateId: "tmpl-end",
    startData: { status1: { value: "{{eventStatus}}" } },
    endData: { time2: { value: "{{eventTime}}" } },
    miniProgramState: "trial",
    timeoutMs: 5000,
  });
});

test("local auth service can start before camera credentials are configured", () => {
  const configPath = path.join(__dirname, "config.js");
  const script = `process.stdout.write(String(require(${JSON.stringify(configPath)}).cameraConfigured))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      NODE_ENV: "development",
      JF_UUID: "",
      JF_APPKEY: "",
      JF_APPSECRET: "",
      JF_MOVECARD: "",
      JF_DEVICE_SN: "",
      JF_DEVICE_USERNAME: "",
      JF_ENDPOINT: "",
      WECHAT_APP_ID: "touristappid",
      WECHAT_APP_SECRET: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "false");
  assert.match(result.stderr, /camera features are disabled/i);
  assert.doesNotMatch(result.stderr, /APPSECRET=.*|WECHAT_APP_SECRET=.*|JF_APPSECRET=.*/i);
});
