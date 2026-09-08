const crypto = require("node:crypto");
const DefaultWebSocket = require("ws");

const LOGIN_PATH = "/cgi-bin/login.cgi";
const COMMAND_PATH = "/cgi-bin/websocket.cgi";

function targetSecToLocalTime(beginTime, targetSec = 0) {
  const date = parseDeviceLocalTime(beginTime);
  date.setSeconds(date.getSeconds() + Math.max(0, Number(targetSec) || 0));
  return formatDeviceLocalTime(date);
}

function buildHttpPlaybackCommand(options = {}) {
  const opr = options.opr;
  const channel = Number(options.channel || 0);
  const stream = options.stream || "Main";
  const payload = {
    Name: "HttpPlayBack",
    Salt: options.salt,
    HttpPlayBack: {
      Opr: opr,
      Channel: channel,
      Stream: stream,
    },
  };

  if (opr === "StartPlay") {
    payload.HttpPlayBack.PlayMode = "PlayByName";
    payload.HttpPlayBack.ExactSeek = 1;
    payload.HttpPlayBack.PlayByName = {
      LocalTime: targetSecToLocalTime(options.beginTime, options.targetSec || 0),
      FileName: options.fileName,
    };
    return payload;
  }

  if (opr === "Locate") {
    payload.HttpPlayBack.LocateTime = targetSecToLocalTime(options.beginTime, options.targetSec || 0);
  }

  return payload;
}

function buildPlaybackWebSocketUrl(options = {}) {
  const scheme = options.secure ? "wss" : "ws";
  const port = options.wsPort ? ":" + options.wsPort : "";
  const params = [
    ["Salt", options.salt || ""],
    ["Channel", String(options.channel || 0)],
    ["Stream", options.stream || "Main"],
    ["XMHead", "1"],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${scheme}://${options.host}${port}/websocket-bin/Type=HttpPlayBack?${params}`;
}

class JFDevicePriClient {
  constructor(options = {}) {
    this.host = options.host;
    this.httpPort = Number(options.httpPort || 80);
    this.wsPort = options.wsPort ? Number(options.wsPort) : null;
    this.secure = !!options.secure;
    this.username = options.username;
    this.password = options.password;
    this.fetch = options.fetch || globalThis.fetch;
    this.WebSocket = options.WebSocket || DefaultWebSocket;
    this.encrypt = options.encrypt || ((value) => rsaEncryptHex(value, this.publicKey));
    this.randomHex = options.randomHex || (() => crypto.randomBytes(48).toString("hex"));
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.keepAliveIntervalMs = Number(options.keepAliveIntervalMs || 10_000);
    this.salt = null;
    this.publicKey = null;
    this.tcpPort = null;
    this.keepAliveTimer = null;
    this.wsConnection = null;
    this.currentPlayback = null;
  }

  async login() {
    this.assertConfigured();
    const preLogin = await this.postLogin({ Name: "GetPreLoginInfo" });
    this.tcpPort = preLogin.TCPPort || this.tcpPort;

    const saltResponse = await this.postLogin({ Name: "GetSalt" });
    this.salt = saltResponse.Salt;
    this.publicKey = saltResponse.PublicKey;
    if (!this.salt || !this.publicKey) {
      throw new Error("DEVICE_PRI_LOGIN_SALT_MISSING");
    }

    const loginPayload = {
      Name: "Login",
      User: this.encrypt(this.username),
      Salt: this.salt,
      Sign: this.encrypt(this.salt + md5(this.password)),
      LoginEncryptionType: "RSA",
      VERK: this.encrypt(this.randomHex()),
    };
    const loginResponse = await this.postLogin(loginPayload);
    if (loginResponse.Ret !== 100) {
      throw new Error("DEVICE_PRI_LOGIN_FAILED: " + JSON.stringify(loginResponse));
    }
    this.startKeepAlive();
    return loginResponse;
  }

  async startPlayback(options = {}) {
    if (!this.salt) await this.login();
    this.currentPlayback = {
      channel: Number(options.channel || 0),
      stream: options.stream || "Main",
      beginTime: options.beginTime,
      fileName: options.fileName,
    };
    if (options.onData) {
      this.wsConnection = this.connectPlaybackStream({
        channel: this.currentPlayback.channel,
        stream: this.currentPlayback.stream,
        onData: options.onData,
        onText: options.onText,
        onError: options.onError,
        onClose: options.onClose,
      });
      await waitForSocketOpen(this.wsConnection.socket, this.WebSocket, options.openTimeoutMs || 1000);
    }
    await this.sendCommand(
      buildHttpPlaybackCommand({
        opr: "StartPlay",
        salt: this.salt,
        channel: this.currentPlayback.channel,
        stream: this.currentPlayback.stream,
        beginTime: this.currentPlayback.beginTime,
        fileName: this.currentPlayback.fileName,
        targetSec: options.targetSec || 0,
      })
    );
    return this.wsConnection;
  }

  connectPlaybackStream(options = {}) {
    if (!this.salt) throw new Error("DEVICE_PRI_NOT_LOGGED_IN");
    const url = buildPlaybackWebSocketUrl({
      host: this.host,
      wsPort: this.wsPort,
      secure: this.secure,
      salt: this.salt,
      channel: options.channel || 0,
      stream: options.stream || "Main",
    });
    const socket = new this.WebSocket(url);
    const onData = options.onData || (() => {});
    const onText = options.onText || (() => {});
    const onError = options.onError || (() => {});
    const onClose = options.onClose || (() => {});

    socket.on("message", (data) => {
      if (typeof data === "string") {
        onText(data);
        return;
      }
      if (Buffer.isBuffer(data)) {
        onData(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        onData(Buffer.from(data));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        onData(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    });
    socket.on("error", onError);
    socket.on("close", onClose);

    return {
      url,
      socket,
      close: () => {
        const closedState = socket.CLOSED ?? this.WebSocket.CLOSED ?? 3;
        if (socket.readyState !== closedState && typeof socket.close === "function") {
          socket.close();
        }
      },
    };
  }

  async seekTo(options = {}) {
    const playback = this.playbackOptions(options);
    await this.sendCommand(
      buildHttpPlaybackCommand({
        opr: "Locate",
        salt: this.salt,
        channel: playback.channel,
        stream: playback.stream,
        beginTime: playback.beginTime,
        targetSec: options.targetSec || 0,
      })
    );
  }

  async pausePlayback(options = {}) {
    const playback = this.playbackOptions(options);
    await this.sendCommand(
      buildHttpPlaybackCommand({
        opr: "Pause",
        salt: this.salt,
        channel: playback.channel,
        stream: playback.stream,
      })
    );
  }

  async resumePlayback(options = {}) {
    const playback = this.playbackOptions(options);
    await this.sendCommand(
      buildHttpPlaybackCommand({
        opr: "Continue",
        salt: this.salt,
        channel: playback.channel,
        stream: playback.stream,
      })
    );
  }

  async stopPlayback(options = {}) {
    try {
      if (this.salt) {
        const playback = this.playbackOptions(options);
        await this.sendCommand(
          buildHttpPlaybackCommand({
            opr: "StopPlay",
            salt: this.salt,
            channel: playback.channel,
            stream: playback.stream,
          })
        );
      }
    } finally {
      this.close();
    }
  }

  close() {
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
    if (this.keepAliveTimer) {
      this.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  async sendCommand(payload) {
    if (!this.salt) throw new Error("DEVICE_PRI_NOT_LOGGED_IN");
    const response = await this.postJson(COMMAND_PATH, payload);
    if (response && response.Ret && response.Ret !== 100) {
      throw new Error("DEVICE_PRI_COMMAND_FAILED: " + JSON.stringify(response));
    }
    return response;
  }

  async postLogin(payload) {
    const response = await this.postJson(LOGIN_PATH, payload);
    if (response && response.Ret && response.Ret !== 100) {
      throw new Error("DEVICE_PRI_LOGIN_STEP_FAILED: " + JSON.stringify(response));
    }
    return response;
  }

  async postJson(requestPath, payload) {
    if (!this.fetch) throw new Error("DEVICE_PRI_FETCH_UNAVAILABLE");
    const response = await this.fetch(this.httpUrl(requestPath), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: JSON.stringify(payload),
    });
    const text = typeof response.text === "function" ? await response.text() : "";
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        throw new Error("DEVICE_PRI_BAD_JSON: " + text);
      }
    } else if (typeof response.json === "function") {
      body = await response.json();
    }
    if (response.ok === false) {
      throw new Error(`DEVICE_PRI_HTTP_${response.status}: ${text || response.statusText || ""}`);
    }
    return body || {};
  }

  startKeepAlive() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = this.setInterval(() => {
      this.postLogin({ Name: "KeepAlive", Salt: this.salt }).catch(() => this.close());
    }, this.keepAliveIntervalMs);
    this.keepAliveTimer.unref?.();
  }

  playbackOptions(options = {}) {
    return {
      channel: Number(options.channel ?? this.currentPlayback?.channel ?? 0),
      stream: options.stream || this.currentPlayback?.stream || "Main",
      beginTime: options.beginTime || this.currentPlayback?.beginTime,
      fileName: options.fileName || this.currentPlayback?.fileName,
    };
  }

  httpUrl(requestPath) {
    const scheme = this.secure ? "https" : "http";
    return `${scheme}://${this.host}:${this.httpPort}${requestPath}`;
  }

  assertConfigured() {
    if (!this.host) throw new Error("DEVICE_PRI_CONFIG_MISSING: host");
    if (!this.username) throw new Error("DEVICE_PRI_CONFIG_MISSING: username");
  }
}

function parseDeviceLocalTime(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const text = String(value || "").replace("T", " ");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_DEVICE_TIME: " + value);
    return parsed;
  }
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
}

function formatDeviceLocalTime(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-") + " " + [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join(":");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function md5(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex");
}

function waitForSocketOpen(socket, WebSocketCtor, timeoutMs) {
  const openState = socket.OPEN ?? WebSocketCtor.OPEN ?? 1;
  const closedState = socket.CLOSED ?? WebSocketCtor.CLOSED ?? 3;
  if (socket.readyState === openState) return Promise.resolve();
  if (socket.readyState === closedState) return Promise.reject(new Error("DEVICE_PRI_WS_CLOSED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("DEVICE_PRI_WS_OPEN_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off?.("open", onOpen);
      socket.off?.("error", onError);
      socket.off?.("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("DEVICE_PRI_WS_CLOSED"));
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function rsaEncryptHex(value, publicKey) {
  if (!publicKey) throw new Error("DEVICE_PRI_PUBLIC_KEY_MISSING");
  const [modulusHex, exponentHex] = publicKey.split(",");
  const modulus = BigInt("0x" + modulusHex);
  const exponent = BigInt("0x" + exponentHex);
  const byteLength = Math.ceil(modulusHex.length / 2);
  const message = Buffer.from(String(value), "utf8");
  if (message.length > byteLength - 11) {
    throw new Error("DEVICE_PRI_RSA_MESSAGE_TOO_LONG");
  }
  const paddingLength = byteLength - message.length - 3;
  const padding = nonZeroRandomBytes(paddingLength);
  const encoded = Buffer.concat([Buffer.from([0, 2]), padding, Buffer.from([0]), message]);
  const encrypted = modPow(bufferToBigInt(encoded), exponent, modulus);
  return encrypted.toString(16).padStart(byteLength * 2, "0");
}

function nonZeroRandomBytes(length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const chunk = crypto.randomBytes(length - offset);
    for (const byte of chunk) {
      if (byte === 0) continue;
      bytes[offset] = byte;
      offset += 1;
      if (offset === length) break;
    }
  }
  return bytes;
}

function bufferToBigInt(buffer) {
  return BigInt("0x" + buffer.toString("hex"));
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let current = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    power >>= 1n;
  }
  return result;
}

module.exports = {
  JFDevicePriClient,
  buildHttpPlaybackCommand,
  buildPlaybackWebSocketUrl,
  targetSecToLocalTime,
  rsaEncryptHex,
};
