const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDemoDataPayload,
  buildLocalDemoRequest,
  handleLocalAction,
  mergeDeviceCoverResults,
} = require("./demoCloud.js");

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

test("saveDeviceCover stores the latest cover and getDeviceCovers returns a keyed map", () => {
  const uniApi = createUniStorage();

  const saved = handleLocalAction(uniApi, "saveDeviceCover", {
    sn: "SN001",
    fileId: "cloud://demo/covers/sn001-first.jpg",
    coverUrl: "https://example.test/sn001-first.jpg",
    capturedAt: 1710000000000,
  });

  assert.equal(saved.ok, true);

  const covers = handleLocalAction(uniApi, "getDeviceCovers", {
    sns: ["SN001", "SN404"],
  });

  assert.deepEqual(covers, {
    ok: true,
    coversBySn: {
      SN001: {
        sn: "SN001",
        fileId: "cloud://demo/covers/sn001-first.jpg",
        coverUrl: "https://example.test/sn001-first.jpg",
        capturedAt: 1710000000000,
        updatedAt: 1710000000000,
      },
    },
  });
});

test("saveDeviceCover overwrites an existing device cover with the newest payload", () => {
  const uniApi = createUniStorage();

  handleLocalAction(uniApi, "saveDeviceCover", {
    sn: "SN001",
    fileId: "cloud://demo/covers/sn001-first.jpg",
    coverUrl: "https://example.test/sn001-first.jpg",
    capturedAt: 1710000000000,
  });

  handleLocalAction(uniApi, "saveDeviceCover", {
    sn: "SN001",
    fileId: "cloud://demo/covers/sn001-latest.jpg",
    coverUrl: "https://example.test/sn001-latest.jpg",
    capturedAt: 1710000005000,
  });

  const covers = handleLocalAction(uniApi, "getDeviceCovers", {
    sns: ["SN001"],
  });

  assert.deepEqual(covers.coversBySn.SN001, {
    sn: "SN001",
    fileId: "cloud://demo/covers/sn001-latest.jpg",
    coverUrl: "https://example.test/sn001-latest.jpg",
    capturedAt: 1710000005000,
    updatedAt: 1710000005000,
  });
});

test("feeding detection setting keeps local analysis and notification switches coupled", () => {
  const uniApi = createUniStorage();

  handleLocalAction(uniApi, "saveNotificationSetting", {
    deviceSn: "SN001",
    enabled: true,
    templateId: "template-1",
  });

  const enabled = handleLocalAction(uniApi, "getFeedAnalysisSetting", {
    deviceSn: "SN001",
  });
  assert.deepEqual(enabled.setting, {
    deviceSn: "SN001",
    feedingDetectionEnabled: true,
    analysisEnabled: true,
    notifyEnabled: true,
    updatedAt: enabled.setting.updatedAt,
  });

  handleLocalAction(uniApi, "setFeedAnalysisEnabled", {
    deviceSn: "SN001",
    enabled: false,
  });
  const disabled = handleLocalAction(uniApi, "getFeedAnalysisSetting", {
    deviceSn: "SN001",
  });
  assert.equal(disabled.setting.feedingDetectionEnabled, false);
  assert.equal(disabled.setting.analysisEnabled, false);
  assert.equal(disabled.setting.notifyEnabled, false);
});

test("Cloud Hosting demo data calls include the public backend URL for analysis sync", () => {
  const data = buildDemoDataPayload(
    "syncFeedAnalysis",
    { deviceSn: "SN001", date: "2026-07-22", force: true },
    {
      mode: "cloud-hosting",
      localBaseUrl: "http://192.168.63.215:8000",
      cloud: {
        envId: "cloud1-prod",
        serviceName: "cat-camera-api",
        publicBaseUrl: "https://cat-camera.example.com/",
      },
    }
  );

  assert.deepEqual(data, {
    action: "syncFeedAnalysis",
    deviceSn: "SN001",
    date: "2026-07-22",
    force: true,
    serverBaseUrl: "https://cat-camera.example.com",
  });
});

test("local device covers use durable phone paths and beat older server covers", () => {
  const uniApi = createUniStorage();
  handleLocalAction(uniApi, "saveDeviceCover", {
    sn: "SN001",
    localPath: "wxfile://userdata/device-cover-SN001.jpg",
    coverUrl: "https://example.test/remote.jpg",
    capturedAt: 1710000005000,
  });
  const local = handleLocalAction(uniApi, "getDeviceCovers", { sns: ["SN001"] });
  const merged = mergeDeviceCoverResults({
    ok: true,
    coversBySn: {
      SN001: { sn: "SN001", coverUrl: "https://example.test/old.jpg", capturedAt: 1710000000000 },
    },
  }, local);

  assert.equal(merged.coversBySn.SN001.coverUrl, "wxfile://userdata/device-cover-SN001.jpg");
});

test("local demo data routes durable actions to the self-hosted API", () => {
  assert.deepEqual(
    buildLocalDemoRequest("getDiary", { deviceSn: "SN001", date: "2026-07-30" }),
    {
      path: "/api/feed-analysis/diary",
      options: {
        method: "GET",
        query: { deviceSn: "SN001", date: "2026-07-30", sync: "0" },
      },
    }
  );
  assert.deepEqual(
    buildLocalDemoRequest("submitFeedback", { type: "建议", content: "很好" }),
    {
      path: "/api/feedback",
      options: {
        method: "POST",
        data: { type: "建议", content: "很好" },
      },
    }
  );
  assert.deepEqual(
    buildLocalDemoRequest("getDeviceCovers", { sns: ["SN001", "SN002"] }),
    {
      path: "/api/device-covers",
      options: {
        method: "GET",
        query: { sns: "SN001,SN002" },
      },
    }
  );
  assert.deepEqual(
    buildLocalDemoRequest("saveDeviceCover", {
      sn: "SN001",
      fileId: "",
      coverUrl: "https://example.test/frame.jpg",
      localPath: "wxfile://userdata/private.jpg",
      capturedAt: 1710000000000,
    }),
    {
      path: "/api/device-covers",
      options: {
        method: "POST",
        data: {
          sn: "SN001",
          fileId: "",
          coverUrl: "https://example.test/frame.jpg",
          capturedAt: 1710000000000,
        },
      },
    }
  );
  assert.equal(
    buildLocalDemoRequest("saveDeviceCover", {
      sn: "SN001",
      localPath: "wxfile://userdata/private.jpg",
      capturedAt: 1710000000000,
    }),
    null
  );
});
