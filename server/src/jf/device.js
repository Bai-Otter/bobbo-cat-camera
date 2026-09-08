/**
 * 杰峰设备 OpenAPI 调用链
 * 统一封装 bind / token / login / livestream / config / replay 相关接口。
 */
const { jfPost, jfPostWithToken } = require("./http");

const OP_FILE_QUERY_RESULT_LIMIT = 64;
const OP_FILE_QUERY_NO_FILE_RET = 119;
const MIN_RECORDING_QUERY_WINDOW_MS = 1000;
const MAX_RECORDING_QUERY_DEPTH = 20;

function isDeviceMissingTokenError(error) {
  return /29010|DEV_NOTEXIT|not found|未找到设备/i.test(String(error && error.message ? error.message : error));
}

function isDuplicateDeviceBindingError(error) {
  return /29013|DEV_SUPPORT_TOKEN_ONLY_ONE_ACCOUNT_ADD/i.test(String(error && error.message ? error.message : error));
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const keys = [
    "list",
    "records",
    "items",
    "rows",
    "AlarmArray",
    "AlarmList",
    "alarmList",
    "alarms",
    "DeviceAlarmList",
    "getDeviceAlarmList",
    "data",
  ];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === "object") {
      const nested = extractList(data[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function extractPictureUrl(data) {
  if (!data || typeof data !== "object") return "";
  const keys = [
    "PicUrl",
    "picUrl",
    "Picture",
    "picture",
    "SnapshotUrl",
    "snapshotUrl",
    "ImageUrl",
    "imageUrl",
    "url",
  ];
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const nested = extractPictureUrl(value);
      if (nested) return nested;
    }
  }
  return "";
}

function parseDeviceLocalTime(value) {
  const timestamp = new Date(String(value || "").replace(" ", "T")).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function formatDeviceLocalTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function recordingKey(record) {
  return [
    record.FileName || record.fileName || "",
    record.BeginTime || record.beginTime || "",
    record.EndTime || record.endTime || "",
  ].join("|");
}

function mergeRecordingPages(pages) {
  const recordsByKey = new Map();
  for (const page of pages) {
    for (const record of page) {
      const key = recordingKey(record);
      if (!recordsByKey.has(key)) recordsByKey.set(key, record);
    }
  }
  return Array.from(recordsByKey.values()).sort((left, right) => {
    const leftTime = parseDeviceLocalTime(left.BeginTime || left.beginTime);
    const rightTime = parseDeviceLocalTime(right.BeginTime || right.beginTime);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return String(left.FileName || left.fileName || "").localeCompare(String(right.FileName || right.fileName || ""));
  });
}

class JFDevice {
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.auth = opts.auth;
    this.sn = opts.sn;
    this.username = opts.username;
    this.password = opts.password;
    this.nickname = opts.nickname || "";
    this.ip = opts.ip || "";
    this.port = opts.port || "";
    this.adminToken = opts.adminToken || "";
    this.deviceToken = null;
    this.playbackRetryDelays = Array.isArray(opts.playbackRetryDelays) ? opts.playbackRetryDelays : [350, 750, 1250];
    this.sleepImpl = typeof opts.sleepImpl === "function" ? opts.sleepImpl : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.httpClient = opts.httpClient || { jfPost, jfPostWithToken };
  }

  async bind() {
    const body = {
      sn: this.sn,
      username: this.username,
      password: this.password,
      nickname: this.nickname,
      port: this.port || "",
      ip: this.ip,
    };
    const res = await this.httpClient.jfPost({
      endpoint: this.endpoint,
      path: "/gwp/v3/rtc/device/bind",
      auth: this.auth,
      body,
    });
    if (res.code !== 2000 && res.code !== 29001) {
      throw new Error(`设备绑定失败: ${JSON.stringify(res)}`);
    }
    return res;
  }

  async getToken() {
    const res = await this.httpClient.jfPost({
      endpoint: this.endpoint,
      path: "/gwp/v3/rtc/device/token",
      auth: this.auth,
      body: {
        sns: [this.sn],
        accessToken: "",
      },
    });
    if (res.code !== 2000 || !Array.isArray(res.data)) {
      throw new Error(`获取 token 失败: ${JSON.stringify(res)}`);
    }
    const item = res.data.find((entry) => entry.sn === this.sn);
    if (!item || !item.token) {
      throw new Error(`响应中未找到设备 ${this.sn} 的 token`);
    }
    this.deviceToken = item.token;
    return this.deviceToken;
  }

  async status() {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPost({
      endpoint: this.endpoint,
      path: "/gwp/v3/rtc/device/status",
      auth: this.auth,
      body: {
        deviceTokenList: [this.deviceToken],
      },
    });
    if (res.code !== 2000) {
      throw new Error(`查询状态失败: ${JSON.stringify(res)}`);
    }
    return res.data && res.data[0] ? res.data[0] : null;
  }

  async login() {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/login/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        UserName: this.username,
        PassWord: this.password,
      },
    });
    if (res.code !== 2000 || res.data?.Ret !== 100) {
      throw new Error(`设备登录失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async getLivestreamUrl(protocol, channel = 0, stream = 1) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/livestream/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        protocol,
        channel: String(channel),
        stream: String(stream),
        username: this.username,
        password: this.password,
      },
    });
    if (res.code !== 2000 || !res.data?.url) {
      throw new Error(`获取直播地址失败: ${JSON.stringify(res)}`);
    }
    return res.data.url;
  }

  async closeLivestream(channel = 0, stream = 1) {
    if (!this.deviceToken) throw new Error("璇峰厛璋冪敤 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/closeLivestream/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        channel: String(channel),
        stream: String(stream),
        username: this.username,
        password: this.password,
      },
    });
    if (res.code !== 2000) {
      throw new Error(`鍏抽棴鐩存挱澶辫触: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async getTalkbackUrl(options = {}) {
    if (!this.deviceToken) throw new Error("DEVICE_TOKEN_REQUIRED");
    const audioCode = String(options.audioCode || "aac").trim().toLowerCase();
    if (audioCode !== "aac") {
      const error = new Error("TALKBACK_AUDIO_CODEC_UNSUPPORTED");
      error.code = "TALKBACK_AUDIO_CODEC_UNSUPPORTED";
      throw error;
    }
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/talkbackUrl/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        mediaType: "rtmp",
        channel: String(options.channel ?? 0),
        audioCode,
        username: this.username,
        password: this.password,
      },
    });
    if (res.code !== 2000 || res.data?.Ret !== 100 || !res.data?.url) {
      const error = new Error("TALKBACK_URL_FAILED");
      error.code = "TALKBACK_URL_FAILED";
      throw error;
    }
    return res.data.url;
  }

  async getAbility(name) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/getability/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: { Name: name },
    });
    if (res.code !== 2000) {
      throw new Error(`获取 ability 失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async getConfig(name) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/getconfig/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: { Name: name },
    });
    if (res.code !== 2000 || res.data?.Ret !== 100) {
      throw new Error(`获取 config 失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async getInfo(name) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/getinfo/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: { Name: name },
    });
    if (res.code !== 2000 || res.data?.Ret !== 100) {
      throw new Error(`获取 device info 失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async setConfig(payload) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/setconfig/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: payload,
    });
    if (res.code !== 2000 || res.data?.Ret !== 100) {
      throw new Error(`设置 config 失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async opdev(payload) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/opdev/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: payload,
    });
    if (res.code !== 2000 || res.data?.Ret !== 100) {
      throw new Error(`设备操作失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async subscribeAlarmMessages(payload = {}) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/subscribeMessage/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: payload,
    });
    if (res.code !== 2000) {
      throw new Error(`订阅报警消息失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async unsubscribeAlarmMessages(payload = {}) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/unsubscribeMessage/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: payload,
    });
    if (res.code !== 2000) {
      throw new Error(`取消订阅报警消息失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async queryAlarmMessages(options = {}) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const {
      beginTime,
      startTime,
      endTime,
      page = 1,
      limit = 50,
      ...rest
    } = options;
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/getDeviceAlarmList/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        ...rest,
        startTime: startTime || beginTime,
        endTime,
        page: page || 1,
        limit: limit || 50,
      },
    });
    if (res.code !== 2000) {
      throw new Error(`获取报警消息失败: ${JSON.stringify(res)}`);
    }
    return extractList(res.data);
  }

  async getDeviceAlarmList({ beginTime, endTime, channel = 0, event = "*", page = 1, pageSize = 100 } = {}) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/getDeviceAlarmList/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        BeginTime: beginTime,
        EndTime: endTime,
        Channel: Number(channel) || 0,
        Event: event,
        Page: Number(page) || 1,
        PageSize: Number(pageSize) || 100,
      },
    });
    if (res.code !== 2000) {
      throw new Error(`查询报警列表失败: ${JSON.stringify(res)}`);
    }
    return extractList(res.data);
  }

  async getPicUrl(payload = {}) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/getPicUrl/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: payload,
    });
    if (res.code !== 2000) {
      throw new Error(`获取报警图片失败: ${JSON.stringify(res)}`);
    }
    return res.data;
  }

  async getAlarmPicUrl(alarm = {}) {
    const directUrl = extractPictureUrl(alarm) || extractPictureUrl(alarm.raw);
    if (directUrl) return directUrl;

    const alarmId = alarm.id || alarm.alarmId || alarm.AlarmID || alarm.AlarmId || alarm.raw?.AlarmID || "";
    if (!alarmId) return "";
    const response = await this.getPicUrl({ alarmIds: [alarmId] });
    return extractPictureUrl(response);
  }

  async queryRecordings({ beginTime, endTime, channel = 0, event = "*", streamType = "0x00000000", type = "h264" }) {
    const queryWindow = async (windowBegin, windowEnd, depth = 0) => {
      const records = await this.queryRecordingsOnce({
        beginTime: windowBegin,
        endTime: windowEnd,
        channel,
        event,
        streamType,
        type,
      });
      if (records.length < OP_FILE_QUERY_RESULT_LIMIT) return records;

      const beginMs = parseDeviceLocalTime(windowBegin);
      const endMs = parseDeviceLocalTime(windowEnd);
      if (
        !Number.isFinite(beginMs) ||
        !Number.isFinite(endMs) ||
        endMs - beginMs < MIN_RECORDING_QUERY_WINDOW_MS ||
        depth >= MAX_RECORDING_QUERY_DEPTH
      ) {
        return records;
      }

      const midMs = Math.floor((beginMs + endMs) / 2);
      const nextMs = midMs + 1000;
      if (nextMs > endMs) return records;

      const firstPage = await queryWindow(windowBegin, formatDeviceLocalTime(midMs), depth + 1);
      const secondPage = await queryWindow(formatDeviceLocalTime(nextMs), windowEnd, depth + 1);
      return mergeRecordingPages([firstPage, secondPage]);
    };

    return queryWindow(beginTime, endTime);
  }

  async queryRecordingsOnce({ beginTime, endTime, channel = 0, event = "*", streamType = "0x00000000", type = "h264" }) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const res = await this.httpClient.jfPostWithToken({
      endpoint: this.endpoint,
      pathTemplate: "/gwp/v3/rtc/device/opdev/{deviceToken}",
      deviceToken: this.deviceToken,
      auth: this.auth,
      body: {
        Name: "OPFileQuery",
        OPFileQuery: {
          BeginTime: beginTime,
          Channel: Number(channel),
          DriverTypeMask: "0x0000FFFF",
          EndTime: endTime,
          Event: event,
          StreamType: streamType,
          Type: type,
        },
      },
    });
    if (res.code === 2000 && res.data?.Ret === OP_FILE_QUERY_NO_FILE_RET) {
      return [];
    }
    if (res.code !== 2000 || res.data?.Ret !== 100) {
      throw new Error(`查询录像失败: ${JSON.stringify(res)}`);
    }
    return Array.isArray(res.data.OPFileQuery) ? res.data.OPFileQuery : [];
  }

  async getPlaybackUrl(record, options = {}) {
    if (!this.deviceToken) throw new Error("请先调用 getToken()");
    const beginTime = options.startTime || record.BeginTime || record.beginTime;
    const endTime = options.endTime || record.EndTime || record.endTime;
    const fileName = options.fileName || record.FileName || record.fileName;
    const body = {
      channel: Number(options.channel || 0),
      streamType: Number(options.streamType || 0),
      startTime: beginTime,
      endTime,
      username: this.username,
      devPwd: this.password,
      fileName,
      userToken: "",
    };
    if (options.mediaType) body.mediaType = options.mediaType;
    if (options.protocol) body.protocol = options.protocol;
    if (Number(options.speed) > 1) body.speed = Number(options.speed);
    const retryOccupied = options.retryOccupied !== false;
    const delays = retryOccupied
      ? (this.playbackRetryDelays.length > 0 ? this.playbackRetryDelays : [350, 750, 1250])
      : [];
    let lastError = null;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const res = await this.httpClient.jfPostWithToken({
          endpoint: this.endpoint,
          pathTemplate: "/gwp/v3/rtc/device/playbackUrl/{deviceToken}",
          deviceToken: this.deviceToken,
          auth: this.auth,
          body,
        });
        if (res.code !== 2000 || !res.data?.url) {
          throw new Error(`获取回放地址失败: ${JSON.stringify(res)}`);
        }
        return res.data.url;
      } catch (error) {
        lastError = error;
        if (attempt >= delays.length || !this.isPlaybackChannelOccupiedError(error)) {
          throw error;
        }
        const delayMs = Number(delays[attempt]) || 0;
        if (delayMs > 0) {
          await this.sleepImpl(delayMs);
        }
      }
    }
    throw lastError || new Error("获取回放地址失败");
  }

  isPlaybackChannelOccupiedError(error) {
    const text = String(error && error.message ? error.message : error);
    return /-514053|playback channel is already occupied/i.test(text);
  }

  async ensureDeviceToken() {
    if (this.deviceToken) return this.deviceToken;
    try {
      return await this.getToken();
    } catch (error) {
      if (!isDeviceMissingTokenError(error)) throw error;
    }
    let duplicateBindingError = null;
    try {
      await this.bind();
    } catch (error) {
      if (!isDuplicateDeviceBindingError(error)) throw error;
      duplicateBindingError = error;
    }
    try {
      return await this.getToken();
    } catch (error) {
      if (duplicateBindingError && isDeviceMissingTokenError(error)) {
        throw duplicateBindingError;
      }
      throw error;
    }
  }

  async ensureReady() {
    if (!this.deviceToken) {
      await this.ensureDeviceToken();
    }
    const st = await this.status();
    if (!st || st.status !== "online") {
      throw new Error(`设备未在线: ${JSON.stringify(st)}`);
    }
    await this.login();
    return true;
  }
}

module.exports = { JFDevice };
