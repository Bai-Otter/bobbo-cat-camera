const test = require("node:test");
const assert = require("node:assert/strict");

const { JFDevice } = require("./device");

function makeDevice(spy = {}) {
  const calls = [];
  const post = async (payload) => {
    calls.push({ type: "post", payload });
    if (spy.post) return spy.post(payload);
    return { code: 2000, data: { Ret: 100, url: "https://example.test/video.m3u8" } };
  };
  const postWithToken = async (payload) => {
    calls.push({ type: "postWithToken", payload });
    if (spy.postWithToken) return spy.postWithToken(payload);
    return { code: 2000, data: { Ret: 100, url: "https://example.test/video.m3u8" } };
  };
  const device = new JFDevice({
    endpoint: "api-cn.jftechws.com",
    auth: {
      uuid: "uuid",
      appKey: "appKey",
      appSecret: "appSecret",
      moveCard: 4,
    },
    sn: "SN001",
    username: "admin",
    password: "pw",
    nickname: "Kitchen cam",
    ip: "192.168.2.88",
    port: spy.port,
    adminToken: spy.adminToken,
    playbackRetryDelays: spy.playbackRetryDelays,
    sleepImpl: spy.sleepImpl,
    httpClient: {
      jfPost: post,
      jfPostWithToken: postWithToken,
    },
  });
  device.deviceToken = "token_1";
  return { device, calls };
}

test("JFDevice bind uses the SDK-compatible cloud binding fields", async () => {
  const { device, calls } = makeDevice({ adminToken: "admin-token-1" });

  await device.bind();

  assert.equal(calls[0].payload.path, "/gwp/v3/rtc/device/bind");
  assert.deepEqual(calls[0].payload.body, {
    sn: "SN001",
    username: "admin",
    password: "pw",
    nickname: "Kitchen cam",
    port: "",
    ip: "192.168.2.88",
  });
});

test("JFDevice ensureDeviceToken uses an existing cloud token before binding", async () => {
  const { device, calls } = makeDevice({
    post(payload) {
      if (payload.path === "/gwp/v3/rtc/device/bind") {
        throw new Error("bind should not be called when token exists");
      }
      return { code: 2000, data: [{ sn: "SN001", token: "cloud-token-1" }] };
    },
  });
  device.deviceToken = null;

  const token = await device.ensureDeviceToken();

  assert.equal(token, "cloud-token-1");
  assert.deepEqual(
    calls.map((entry) => entry.payload.path),
    ["/gwp/v3/rtc/device/token"]
  );
});

test("JFDevice ensureDeviceToken binds only after the device is missing from the cloud account", async () => {
  let tokenAttempts = 0;
  const { device, calls } = makeDevice({
    post(payload) {
      if (payload.path === "/gwp/v3/rtc/device/token") {
        tokenAttempts += 1;
        if (tokenAttempts === 1) return { code: 29010, msg: "DEV_NOTEXIT", data: [] };
        return { code: 2000, data: [{ sn: "SN001", token: "cloud-token-after-bind" }] };
      }
      return { code: 2000, data: null };
    },
  });
  device.deviceToken = null;

  const token = await device.ensureDeviceToken();

  assert.equal(token, "cloud-token-after-bind");
  assert.deepEqual(
    calls.map((entry) => entry.payload.path),
    [
      "/gwp/v3/rtc/device/token",
      "/gwp/v3/rtc/device/bind",
      "/gwp/v3/rtc/device/token",
    ]
  );
});

test("JFDevice ensureDeviceToken recovers an existing token after duplicate bind", async () => {
  let tokenAttempts = 0;
  const { device, calls } = makeDevice({
    post(payload) {
      if (payload.path === "/gwp/v3/rtc/device/token") {
        tokenAttempts += 1;
        if (tokenAttempts === 1) return { code: 29010, msg: "DEV_NOTEXIT", data: [] };
        return { code: 2000, data: [{ sn: "SN001", token: "existing-token" }] };
      }
      if (payload.path === "/gwp/v3/rtc/device/bind") {
        return { code: 29013, msg: "DEV_SUPPORT_TOKEN_ONLY_ONE_ACCOUNT_ADD" };
      }
      throw new Error("unexpected request");
    },
  });
  device.deviceToken = null;

  const token = await device.ensureDeviceToken();

  assert.equal(token, "existing-token");
  assert.deepEqual(calls.map((entry) => entry.payload.path), [
    "/gwp/v3/rtc/device/token",
    "/gwp/v3/rtc/device/bind",
    "/gwp/v3/rtc/device/token",
  ]);
});

test("JFDevice getConfig and setConfig use official config endpoints", async () => {
  const { device, calls } = makeDevice();

  await device.getConfig("Detect.MotionDetect");
  await device.setConfig({ Name: "Detect.MotionDetect", "Detect.MotionDetect": [{ Enable: true }] });

  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/getconfig/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, { Name: "Detect.MotionDetect" });
  assert.equal(calls[1].payload.pathTemplate, "/gwp/v3/rtc/device/setconfig/{deviceToken}");
  assert.equal(calls[1].payload.body.Name, "Detect.MotionDetect");
});

test("JFDevice closeLivestream releases the official media session", async () => {
  const { device, calls } = makeDevice({
    postWithToken() {
      return { code: 2000, msg: "Success", data: null };
    },
  });

  await device.closeLivestream(0, 1);

  assert.equal(
    calls[0].payload.pathTemplate,
    "/gwp/v3/rtc/device/closeLivestream/{deviceToken}"
  );
  assert.deepEqual(calls[0].payload.body, {
    channel: "0",
    stream: "1",
    username: "admin",
    password: "pw",
  });
});

test("JFDevice getTalkbackUrl requests an AAC RTMP endpoint", async () => {
  const { device, calls } = makeDevice({
    postWithToken() {
      return { code: 2000, data: { Ret: 100, url: "rtmp://talk.test/live" } };
    },
  });

  const url = await device.getTalkbackUrl({ channel: 0, audioCode: "aac" });

  assert.equal(url, "rtmp://talk.test/live");
  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/talkbackUrl/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, {
    mediaType: "rtmp",
    channel: "0",
    audioCode: "aac",
    username: "admin",
    password: "pw",
  });
});

test("JFDevice getTalkbackUrl rejects unsupported audio codecs and invalid responses", async () => {
  const { device } = makeDevice({
    postWithToken() {
      return { code: 2000, data: { Ret: 119 } };
    },
  });

  await assert.rejects(device.getTalkbackUrl({ audioCode: "g711" }), { code: "TALKBACK_AUDIO_CODEC_UNSUPPORTED" });
  await assert.rejects(device.getTalkbackUrl(), { code: "TALKBACK_URL_FAILED" });
});

test("JFDevice queryRecordings and getPlaybackUrl use official replay endpoints", async () => {
  const { device, calls } = makeDevice({
    postWithToken(payload) {
      if (payload.pathTemplate.includes("opdev")) {
        return {
          code: 2000,
          data: {
            Ret: 100,
            OPFileQuery: [
              {
                BeginTime: "2026-07-04 12:00:00",
                EndTime: "2026-07-04 12:00:30",
                FileName: "clip-a.mp4",
              },
            ],
          },
        };
      }
      return {
        code: 2000,
        data: {
          url: "https://example.test/playback.m3u8",
        },
      };
    },
  });

  const records = await device.queryRecordings({
    beginTime: "2026-07-04 00:00:00",
    endTime: "2026-07-04 23:59:59",
  });
  const playbackUrl = await device.getPlaybackUrl(records[0]);

  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/opdev/{deviceToken}");
  assert.equal(calls[1].payload.pathTemplate, "/gwp/v3/rtc/device/playbackUrl/{deviceToken}");
  assert.equal(Object.hasOwn(calls[1].payload.body, "mediaType"), false);
  assert.equal(Object.hasOwn(calls[1].payload.body, "protocol"), false);
  assert.equal(playbackUrl, "https://example.test/playback.m3u8");
});

test("JFDevice queryRecordings splits full OPFileQuery windows past the device 64 item cap", async () => {
  function pad(value) {
    return String(value).padStart(2, "0");
  }
  function timeAtMinute(minute) {
    const hour = Math.floor(minute / 60);
    const min = minute % 60;
    return `2026-07-04 ${pad(hour)}:${pad(min)}:00`;
  }
  function endTimeAtMinute(minute) {
    const hour = Math.floor(minute / 60);
    const min = minute % 60;
    return `2026-07-04 ${pad(hour)}:${pad(min)}:30`;
  }
  const allRecords = Array.from({ length: 70 }, (_, index) => ({
    BeginTime: timeAtMinute(index),
    EndTime: endTimeAtMinute(index),
    FileName: `clip-${pad(index)}.mp4`,
  }));
  const { device, calls } = makeDevice({
    postWithToken(payload) {
      const query = payload.body.OPFileQuery;
      const matching = allRecords.filter(
        (record) => record.BeginTime >= query.BeginTime && record.BeginTime <= query.EndTime
      );
      return {
        code: 2000,
        data: {
          Ret: 100,
          OPFileQuery: matching.slice(0, 64),
        },
      };
    },
  });

  const records = await device.queryRecordings({
    beginTime: "2026-07-04 00:00:00",
    endTime: "2026-07-04 23:59:59",
  });

  assert.equal(records.length, 70);
  assert.deepEqual(records.map((record) => record.FileName), allRecords.map((record) => record.FileName));
  assert.ok(calls.filter((call) => call.payload.pathTemplate.includes("opdev")).length > 1);
});

test("JFDevice queryRecordings treats empty split OPFileQuery windows as empty pages", async () => {
  function pad(value) {
    return String(value).padStart(2, "0");
  }
  function timeAtMinute(minute) {
    const hour = Math.floor(minute / 60);
    const min = minute % 60;
    return `2026-07-04 ${pad(hour)}:${pad(min)}:00`;
  }
  function endTimeAtMinute(minute) {
    const hour = Math.floor(minute / 60);
    const min = minute % 60;
    return `2026-07-04 ${pad(hour)}:${pad(min)}:30`;
  }
  const allRecords = Array.from({ length: 70 }, (_, index) => ({
    BeginTime: timeAtMinute(12 * 60 + index),
    EndTime: endTimeAtMinute(12 * 60 + index),
    FileName: `noon-clip-${pad(index)}.mp4`,
  }));
  const { device } = makeDevice({
    postWithToken(payload) {
      const query = payload.body.OPFileQuery;
      const matching = allRecords.filter(
        (record) => record.BeginTime >= query.BeginTime && record.BeginTime <= query.EndTime
      );
      if (matching.length === 0) {
        return {
          code: 2000,
          msg: "Success",
          data: { Ret: 119, RetMsg: "No query to file", SessionID: "0x00000006" },
        };
      }
      return {
        code: 2000,
        data: {
          Ret: 100,
          OPFileQuery: matching.slice(0, 64),
        },
      };
    },
  });

  const records = await device.queryRecordings({
    beginTime: "2026-07-04 00:00:00",
    endTime: "2026-07-04 23:59:59",
  });

  assert.equal(records.length, 70);
  assert.deepEqual(records.map((record) => record.FileName), allRecords.map((record) => record.FileName));
});

test("JFDevice getPlaybackUrl forwards explicit replay protocol options", async () => {
  const { device, calls } = makeDevice();

  await device.getPlaybackUrl(
    {
      BeginTime: "2026-07-04 12:00:00",
      EndTime: "2026-07-04 12:00:30",
      FileName: "clip-a.mp4",
    },
    { mediaType: "flv", protocol: "flv", streamType: 1, speed: 4 }
  );

  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/playbackUrl/{deviceToken}");
  assert.equal(calls[0].payload.body.mediaType, "flv");
  assert.equal(calls[0].payload.body.protocol, "flv");
  assert.equal(calls[0].payload.body.streamType, 1);
  assert.equal(calls[0].payload.body.speed, 4);
});

test("JFDevice opdev sends official device operations", async () => {
  const { device, calls } = makeDevice({
    postWithToken() {
      return { code: 2000, data: { Ret: 100, StorageInfo: [] } };
    },
  });

  const result = await device.opdev({ Name: "StorageInfo" });
  assert.equal(result.Ret, 100);
  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/opdev/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, { Name: "StorageInfo" });
});

test("JFDevice getInfo sends official device information queries", async () => {
  const { device, calls } = makeDevice({
    postWithToken() {
      return { code: 2000, data: { Ret: 100, StorageInfo: [] } };
    },
  });

  const result = await device.getInfo("StorageInfo");
  assert.equal(result.Ret, 100);
  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/getinfo/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, { Name: "StorageInfo" });
});

test("JFDevice getDeviceAlarmList wraps the alarm list endpoint", async () => {
  const { device, calls } = makeDevice({
    postWithToken(payload) {
      if (payload.pathTemplate.includes("getDeviceAlarmList")) {
        return {
          code: 2000,
          data: {
            list: [
              {
                AlarmTime: "2026-07-14 12:00:00",
                Event: "Motion",
              },
            ],
          },
        };
      }
      return { code: 2000, data: { Ret: 100 } };
    },
  });

  const alarms = await device.getDeviceAlarmList({
    beginTime: "2026-07-14 00:00:00",
    endTime: "2026-07-14 23:59:59",
  });

  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/getDeviceAlarmList/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, {
    BeginTime: "2026-07-14 00:00:00",
    EndTime: "2026-07-14 23:59:59",
    Channel: 0,
    Event: "*",
    Page: 1,
    PageSize: 100,
  });
  assert.deepEqual(alarms, [
    {
      AlarmTime: "2026-07-14 12:00:00",
      Event: "Motion",
    },
  ]);
});

test("JFDevice subscribes to and queries official alarm messages", async () => {
  const { device, calls } = makeDevice({
    postWithToken(payload) {
      if (payload.pathTemplate.includes("getDeviceAlarmList")) {
        return {
          code: 2000,
          data: {
            AlarmArray: [
              {
                AlarmId: "alarm-1",
                AlarmEvent: "appEventHumanDetectAlarm:2",
                AlarmTime: "2026-07-04 07:30:12",
              },
            ],
          },
        };
      }
      return { code: 2000, data: { Ret: 100 } };
    },
  });

  await device.subscribeAlarmMessages({ alarmTypes: ["HumanDetect"] });
  const alarms = await device.queryAlarmMessages({
    beginTime: "2026-07-04 07:00:00",
    endTime: "2026-07-04 08:00:00",
    limit: 20,
  });

  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/subscribeMessage/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, { alarmTypes: ["HumanDetect"] });
  assert.equal(calls[1].payload.pathTemplate, "/gwp/v3/rtc/device/getDeviceAlarmList/{deviceToken}");
  assert.equal(calls[1].payload.body.startTime, "2026-07-04 07:00:00");
  assert.equal(calls[1].payload.body.endTime, "2026-07-04 08:00:00");
  assert.equal(calls[1].payload.body.limit, 20);
  assert.equal(Object.hasOwn(calls[1].payload.body, "beginTime"), false);
  assert.equal(alarms[0].AlarmId, "alarm-1");
});

test("JFDevice getPicUrl calls the official alarm picture endpoint", async () => {
  const { device, calls } = makeDevice({
    postWithToken(payload) {
      if (payload.pathTemplate.includes("getPicUrl")) {
        return { code: 2000, data: { url: "https://example.test/alarm.jpg" } };
      }
      return { code: 2000, data: { Ret: 100 } };
    },
  });

  const result = await device.getPicUrl({ AlarmID: "alarm-1" });

  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/getPicUrl/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, { AlarmID: "alarm-1" });
  assert.deepEqual(result, { url: "https://example.test/alarm.jpg" });
});

test("JFDevice getAlarmPicUrl prefers an alarm-provided picture url", async () => {
  const { device, calls } = makeDevice();

  const url = await device.getAlarmPicUrl({
    AlarmID: "alarm-1",
    PicUrl: "https://example.test/direct.jpg",
  });

  assert.equal(url, "https://example.test/direct.jpg");
  assert.equal(calls.length, 0);
});

test("JFDevice getAlarmPicUrl calls getPicUrl and extracts nested urls when alarm has no picture", async () => {
  const { device, calls } = makeDevice({
    postWithToken(payload) {
      if (payload.pathTemplate.includes("getPicUrl")) {
        return {
          code: 2000,
          data: [{
            id: "alarm-1",
            url: "https://example.test/from-api.jpg",
          }],
        };
      }
      return { code: 2000, data: { Ret: 100 } };
    },
  });
  const alarm = {
    raw: { extra: "keep-me" },
    id: "alarm-1",
    alarmType: "HumanDetect",
    occurredAt: "2026-07-04 07:30:12",
  };

  const url = await device.getAlarmPicUrl(alarm);

  assert.equal(url, "https://example.test/from-api.jpg");
  assert.equal(calls[0].payload.pathTemplate, "/gwp/v3/rtc/device/getPicUrl/{deviceToken}");
  assert.deepEqual(calls[0].payload.body, { alarmIds: ["alarm-1"] });
});

test("JFDevice getPlaybackUrl retries when the playback channel is occupied", async () => {
  let attempts = 0;
  const { device, calls } = makeDevice({
    playbackRetryDelays: [0, 0],
    sleepImpl: async () => {},
    postWithToken(payload) {
      if (payload.pathTemplate.includes("playbackUrl")) {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("playback url failed: {'code': -514053, 'msg': 'The playback channel is already occupied [login failed]', 'data': null}");
        }
        return {
          code: 2000,
          data: {
            url: "https://example.test/retry-playback.m3u8",
          },
        };
      }
      return {
        code: 2000,
        data: {
          Ret: 100,
          OPFileQuery: [
            {
              BeginTime: "2026-07-04 12:00:00",
              EndTime: "2026-07-04 12:00:30",
              FileName: "clip-a.mp4",
            },
          ],
        },
      };
    },
  });

  const url = await device.getPlaybackUrl({
    BeginTime: "2026-07-04 12:00:00",
    EndTime: "2026-07-04 12:00:30",
    FileName: "clip-a.mp4",
  });

  assert.equal(url, "https://example.test/retry-playback.m3u8");
  assert.equal(attempts, 3);
  assert.equal(calls.filter((entry) => entry.payload.pathTemplate.includes("playbackUrl")).length, 3);
});

test("JFDevice getPlaybackUrl can leave occupied-channel recovery to its coordinator", async () => {
  let attempts = 0;
  const device = new JFDevice({
    sn: "SN-PLAYBACK-ONCE",
    username: "admin",
    password: "password",
    httpClient: {
      async jfPostWithToken() {
        attempts += 1;
        throw new Error("playback url failed: code -514053 playback channel occupied");
      },
    },
  });
  device.deviceToken = "device-token";

  await assert.rejects(
    () => device.getPlaybackUrl({
      BeginTime: "2026-08-22 08:00:00",
      EndTime: "2026-08-22 08:30:00",
      FileName: "recording.h264",
    }, { retryOccupied: false }),
    /-514053/
  );
  assert.equal(attempts, 1);
});
