const { readAppAuthState } = require("./appAuth.js");
const { getRequestBaseUrl } = require("./backendClient.js");
const {
  BACKEND_RUNTIME,
  getCloudContainerOptions,
  isCloudHosting,
} = require("../config/backend.js");

const RECORDER_OPTIONS = Object.freeze({
  duration: 300000,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: "aac",
  frameSize: 4,
});

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function buildMediaControlWebSocketUrl(baseUrl, deviceSn) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw stableError("BACKEND_URL_INVALID");
  const socketBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return `${socketBase}/api/devices/${encodeURIComponent(String(deviceSn || ""))}/media-control`;
}

class LiveMediaControl {
  constructor(options = {}) {
    this.wxApi = options.wxApi || (typeof wx !== "undefined" ? wx : null);
    this.uniApi = options.uniApi || (typeof uni !== "undefined" ? uni : null);
    this.backendRuntime = options.backendRuntime || BACKEND_RUNTIME;
    this.deviceSn = String(options.deviceSn || "");
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.heartbeatMs = Math.max(5000, Number(options.heartbeatMs) || 25000);
    this.socket = null;
    this.socketOpen = false;
    this.authorized = false;
    this.closed = false;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.talking = false;
    this.talkRequested = false;
    this.talkRequestVersion = 0;
    this.recording = false;
    this.recorder = this.wxApi && typeof this.wxApi.getRecorderManager === "function"
      ? this.wxApi.getRecorderManager()
      : null;
    this.recorderActive = false;
    this.socketListeners = null;
    this.recorderListeners = null;
    this.attachRecorder();
  }

  emit(event) {
    this.onEvent(event || {});
  }

  attachRecorder() {
    if (!this.recorder || this.recorderListeners) return;
    const listeners = {
      start: () => { this.recorderActive = true; },
      frameRecorded: (event = {}) => {
        if (!this.talking || !this.authorized || !event.frameBuffer) return;
        this.send(event.frameBuffer);
      },
      stop: () => { this.recorderActive = false; },
      error: (error = {}) => {
        if (this.authorized && (this.talking || this.talkRequested)) {
          try {
            this.sendJson({ type: "talk.stop" });
          } catch {}
        }
        this.recorderActive = false;
        this.talking = false;
        this.talkRequested = false;
        this.emit({ type: "talk.failed", error: error.errMsg || "MICROPHONE_FAILED" });
      },
    };
    if (typeof this.recorder.onStart === "function") this.recorder.onStart(listeners.start);
    if (typeof this.recorder.onFrameRecorded === "function") this.recorder.onFrameRecorded(listeners.frameRecorded);
    if (typeof this.recorder.onStop === "function") this.recorder.onStop(listeners.stop);
    if (typeof this.recorder.onError === "function") this.recorder.onError(listeners.error);
    this.recorderListeners = listeners;
  }

  detachRecorder() {
    const listeners = this.recorderListeners;
    if (!listeners || !this.recorder) return;
    if (typeof this.recorder.offStart === "function") this.recorder.offStart(listeners.start);
    if (typeof this.recorder.offFrameRecorded === "function") this.recorder.offFrameRecorded(listeners.frameRecorded);
    if (typeof this.recorder.offStop === "function") this.recorder.offStop(listeners.stop);
    if (typeof this.recorder.offError === "function") this.recorder.offError(listeners.error);
    this.recorderListeners = null;
  }

  connect() {
    if (this.closed) return Promise.reject(stableError("MEDIA_CONTROL_CLOSED"));
    if (this.authorized) return Promise.resolve(this);
    const auth = readAppAuthState(this.uniApi);
    if (!this.deviceSn || !auth.sessionToken) {
      return Promise.reject(stableError("AUTH_REQUIRED"));
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      if (!isCloudHosting(this.backendRuntime)) {
        if (!this.wxApi || !this.wxApi.connectSocket) {
          reject(stableError("MEDIA_CONTROL_UNAVAILABLE"));
          return;
        }
        try {
          const socket = this.wxApi.connectSocket({
            url: buildMediaControlWebSocketUrl(
              getRequestBaseUrl(this.uniApi, this.backendRuntime, this.wxApi),
              this.deviceSn
            ),
          });
          this.attachSocket(socket, auth.sessionToken);
        } catch (error) {
          reject(stableError(error && (error.errMsg || error.message) || "MEDIA_CONTROL_CONNECT_FAILED"));
        }
        return;
      }

      const cloud = this.wxApi && this.wxApi.cloud;
      const container = getCloudContainerOptions(this.backendRuntime);
      if (!cloud || !cloud.connectContainer || !container.env || !container.serviceName) {
        reject(stableError("CLOUD_CONTAINER_UNAVAILABLE"));
        return;
      }
      let result;
      try {
        result = cloud.connectContainer({
          config: { env: container.env },
          service: container.serviceName,
          path: `/api/devices/${encodeURIComponent(this.deviceSn)}/media-control`,
        });
      } catch (error) {
        reject(stableError(error && (error.errMsg || error.message) || "MEDIA_CONTROL_CONNECT_FAILED"));
        return;
      }
      if (result && typeof result.then === "function") {
        result.then((response) => this.attachSocket(response && response.socketTask || response, auth.sessionToken)).catch((error) => {
          reject(stableError(error && (error.errMsg || error.message) || "MEDIA_CONTROL_CONNECT_FAILED"));
        });
      } else {
        this.attachSocket(result && result.socketTask || result, auth.sessionToken);
      }
    });
  }

  attachSocket(socket, sessionToken) {
    if (!socket) {
      if (typeof this.pendingReject === "function") this.pendingReject(stableError("MEDIA_CONTROL_CONNECT_FAILED"));
      return;
    }
    this.socket = socket;
    const listeners = {
      open: () => {
        this.socketOpen = true;
        this.sendJson({ type: "authorize", token: sessionToken });
      },
      message: (event) => this.handleMessage(event && event.data),
      close: (event) => this.handleSocketClose(event),
      error: (error) => this.emit({
        type: "media.error",
        error: error && (error.errMsg || error.message) || "MEDIA_CONTROL_SOCKET_FAILED",
      }),
    };
    if (typeof socket.onOpen === "function") socket.onOpen(listeners.open);
    if (typeof socket.onMessage === "function") socket.onMessage(listeners.message);
    if (typeof socket.onClose === "function") socket.onClose(listeners.close);
    if (typeof socket.onError === "function") socket.onError(listeners.error);
    this.socketListeners = listeners;
  }

  detachSocket() {
    const socket = this.socket;
    const listeners = this.socketListeners;
    if (socket && listeners) {
      if (typeof socket.offOpen === "function") socket.offOpen(listeners.open);
      if (typeof socket.offMessage === "function") socket.offMessage(listeners.message);
      if (typeof socket.offClose === "function") socket.offClose(listeners.close);
      if (typeof socket.offError === "function") socket.offError(listeners.error);
    }
    this.socketListeners = null;
  }

  handleMessage(data) {
    let event;
    try {
      event = typeof data === "string" ? JSON.parse(data) : JSON.parse(String(data || ""));
    } catch {
      this.emit({ type: "media.error", error: "MEDIA_MESSAGE_INVALID" });
      return;
    }
    if (event.type === "authorized") {
      this.authorized = true;
      this.reconnectCount = 0;
      this.startHeartbeat();
      if (typeof this.pendingResolve === "function") this.pendingResolve(this);
      this.pendingResolve = null;
      this.pendingReject = null;
    } else if (event.type === "talk.active") {
      this.talking = true;
      this.startRecorder();
    } else if (event.type === "talk.idle" || event.type === "talk.failed") {
      this.talking = false;
      this.talkRequested = false;
      this.stopRecorder();
    } else if (event.type === "record.active") {
      this.recording = true;
    } else if (event.type === "record.finalizing" || event.type === "record.ready" || event.type === "record.failed") {
      this.recording = false;
    }
    this.emit(event);
  }

  startHeartbeat() {
    if (this.heartbeatTimer) this.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = this.setInterval(() => {
      if (this.authorized) this.sendJson({ type: "ping" });
    }, this.heartbeatMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) this.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(data) {
    if (!this.socketOpen || !this.socket || !this.socket.send) throw stableError("MEDIA_CONTROL_NOT_CONNECTED");
    this.socket.send({ data });
  }

  sendJson(message) {
    this.send(JSON.stringify(message));
  }

  startRecording(sessionId = "") {
    if (!this.authorized) throw stableError("MEDIA_CONTROL_NOT_AUTHORIZED");
    this.sendJson({
      type: "record.start",
      ...(sessionId ? { sessionId: String(sessionId) } : {}),
    });
  }

  stopRecording() {
    if (!this.authorized) return;
    this.sendJson({ type: "record.stop" });
  }

  readMicrophonePermission() {
    if (!this.wxApi || !this.wxApi.getSetting) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.wxApi.getSetting({
        success: (result = {}) => resolve(result.authSetting && result.authSetting["scope.record"]),
        fail: () => reject(stableError("MICROPHONE_PERMISSION_CHECK_FAILED")),
      });
    });
  }

  requestMicrophonePermission() {
    if (!this.wxApi || !this.wxApi.authorize) return Promise.reject(stableError("MICROPHONE_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      this.wxApi.authorize({
        scope: "scope.record",
        success: resolve,
        fail: () => reject(stableError("MICROPHONE_PERMISSION_DENIED")),
      });
    });
  }

  async ensureMicrophonePermission() {
    const permission = await this.readMicrophonePermission();
    if (permission === true) return;
    await this.requestMicrophonePermission();
  }

  async startTalk() {
    if (!this.authorized) throw stableError("MEDIA_CONTROL_NOT_AUTHORIZED");
    if (!this.recorder || !this.recorder.start) throw stableError("MICROPHONE_UNAVAILABLE");
    const requestVersion = ++this.talkRequestVersion;
    await this.ensureMicrophonePermission();
    if (requestVersion !== this.talkRequestVersion) return false;
    if (!this.authorized || this.closed) throw stableError("MEDIA_CONTROL_NOT_AUTHORIZED");
    this.talkRequested = true;
    this.sendJson({ type: "talk.start" });
    return true;
  }

  stopTalk() {
    this.talkRequestVersion += 1;
    this.talkRequested = false;
    if (!this.authorized) return;
    this.sendJson({ type: "talk.stop" });
  }

  startRecorder() {
    if (!this.recorder || !this.recorder.start || this.recorderActive) return;
    this.recorder.start({ ...RECORDER_OPTIONS });
    this.recorderActive = true;
  }

  stopRecorder() {
    if (!this.recorderActive) return;
    if (this.recorder && typeof this.recorder.stop === "function") this.recorder.stop();
    this.recorderActive = false;
  }

  handleSocketClose(event = {}) {
    const wasTalking = this.talking || this.talkRequested;
    this.detachSocket();
    this.stopHeartbeat();
    this.socketOpen = false;
    this.authorized = false;
    this.talking = false;
    this.talkRequested = false;
    this.recording = false;
    this.stopRecorder();
    if (wasTalking) this.emit({ type: "talk.failed", error: "MEDIA_CONTROL_DISCONNECTED" });
    this.emit({ type: "media.disconnected", code: Number(event.code) || 0 });
    if (!this.closed && this.reconnectCount < 1) {
      this.reconnectCount += 1;
      this.reconnectTimer = this.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch((error) => this.emit({ type: "media.error", error: error.code || error.message }));
      }, 800);
    }
  }

  isTalking() {
    return this.talking;
  }

  isAuthorized() {
    return this.authorized && this.socketOpen && !this.closed;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.talkRequestVersion += 1;
    if (this.reconnectTimer) this.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    if (this.authorized && this.recording) this.sendJson({ type: "record.stop" });
    if (this.authorized && (this.talking || this.talkRequested)) this.sendJson({ type: "talk.stop" });
    this.detachSocket();
    this.stopRecorder();
    this.detachRecorder();
    this.socketOpen = false;
    this.authorized = false;
    this.talking = false;
    this.recording = false;
    if (this.socket && typeof this.socket.close === "function") {
      this.socket.close({ code: 1000, reason: "page closed" });
    }
    this.socket = null;
  }
}

function createLiveMediaControl(options) {
  return new LiveMediaControl(options);
}

module.exports = {
  LiveMediaControl,
  RECORDER_OPTIONS,
  buildMediaControlWebSocketUrl,
  createLiveMediaControl,
};
