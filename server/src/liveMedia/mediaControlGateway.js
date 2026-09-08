const { WebSocketServer } = require("ws");

const {
  parseControlMessage,
  validateAudioFrame,
  mediaEvent,
  mediaError,
} = require("./protocol");
const { publicRecording } = require("./liveRecordingStore");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function mediaPath(url) {
  const pathname = String(url || "").split("?")[0];
  const match = /^\/api\/devices\/([^/]+)\/media-control\/?$/.exec(pathname);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

class MediaControlGateway {
  constructor(options = {}) {
    for (const dependency of [
      "authenticate",
      "resolveOwnedDevice",
      "createTalkback",
      "createRecording",
    ]) {
      if (typeof options[dependency] !== "function") throw codedError(`MEDIA_${dependency.toUpperCase()}_REQUIRED`);
    }
    this.authenticate = options.authenticate;
    this.resolveOwnedDevice = options.resolveOwnedDevice;
    this.resolveLiveSession = options.resolveLiveSession;
    this.createTalkback = options.createTalkback;
    this.createRecording = options.createRecording;
    this.webSocketServer = options.webSocketServer || new WebSocketServer({ noServer: true });
    this.logger = options.logger || console;
    this.contexts = new Set();
    this.server = null;
    this.upgradeHandler = null;
  }

  get connectionCount() {
    return this.contexts.size;
  }

  attach(server) {
    if (this.server) throw codedError("MEDIA_GATEWAY_ALREADY_ATTACHED");
    this.server = server;
    this.upgradeHandler = (req, socket, head) => {
      const deviceSn = mediaPath(req.url);
      if (!deviceSn) {
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
        this.acceptConnection(ws, req, deviceSn);
      });
    };
    server.on("upgrade", this.upgradeHandler);
    return this;
  }

  acceptConnection(ws, req, deviceSn) {
    const context = {
      ws,
      req,
      deviceSn,
      openid: "",
      device: null,
      authorized: false,
      talkback: null,
      recording: null,
      recordingStart: null,
      recordingGeneration: 0,
      recordingTerminal: false,
      reportedRecordingFailures: new WeakSet(),
      queue: Promise.resolve(),
      operations: new Set(),
      closed: false,
    };
    this.contexts.add(context);
    ws.on("message", (data, isBinary) => {
      this.enqueue(context, () => this.handleMessage(context, data, isBinary), isBinary ? "talk" : "");
    });
    ws.once("close", () => {
      context.closed = true;
      this.enqueue(context, () => this.cleanupContext(context));
    });
    ws.once("error", (error) => {
      this.logger.warn?.("[media-control] socket error", error?.message || "socket error");
    });
    return context;
  }

  enqueue(context, action, scope = "") {
    context.queue = context.queue.then(action).catch((error) => {
      this.handleCommandError(context, error, scope);
    });
    return context.queue;
  }

  runOperation(context, scope, action) {
    const operation = Promise.resolve().then(action).catch((error) => {
      this.handleCommandError(context, error, scope);
    }).finally(() => {
      context.operations.delete(operation);
    });
    context.operations.add(operation);
    return operation;
  }

  async handleMessage(context, data, isBinary) {
    if (isBinary) {
      if (!context.authorized) throw codedError("AUTH_REQUIRED");
      if (!context.talkback) throw codedError("TALKBACK_NOT_ACTIVE");
      try {
        validateAudioFrame(data);
        context.talkback.writeAudio(Buffer.from(data));
      } catch (error) {
        await this.stopTalkback(context, false).catch(() => {});
        throw codedError("TALKBACK_AUDIO_FAILED");
      }
      return;
    }
    const command = parseControlMessage(data);
    if (!context.authorized) {
      if (command.type !== "authorize") throw codedError("AUTH_REQUIRED");
      const identity = this.authenticate(context.req, command.token);
      const device = await this.resolveOwnedDevice(identity.openid, context.deviceSn);
      if (!device) throw codedError("DEVICE_NOT_FOUND");
      context.openid = identity.openid;
      context.device = device;
      context.authorized = true;
      this.send(context, { type: "authorized", deviceSn: context.deviceSn });
      return;
    }
    if (command.type === "authorize") throw codedError("MEDIA_MESSAGE_INVALID");
    if (command.type === "ping") {
      this.send(context, { type: "pong" });
      return;
    }
    if (command.type === "talk.start") {
      this.runOperation(context, "talk", () => this.startTalkback(context));
      return;
    }
    if (command.type === "talk.stop") {
      return this.stopTalkback(context, true).catch((error) => {
        this.handleCommandError(context, error, "talk");
      });
    }
    if (command.type === "record.start") {
      this.runOperation(context, "record", () => this.startRecording(context, command.sessionId));
      return;
    }
    if (command.type === "record.stop") {
      return this.stopRecording(context, true).catch((error) => {
        this.handleCommandError(context, error, "record");
      });
    }
    throw codedError("MEDIA_MESSAGE_INVALID");
  }

  async startTalkback(context) {
    if (context.talkback) throw codedError("MEDIA_ALREADY_ACTIVE");
    this.send(context, mediaEvent("talk", "starting"));
    const session = this.createTalkback({
      ownerOpenid: context.openid,
      deviceSn: context.deviceSn,
      device: context.device,
    });
    context.talkback = session;
    session.once?.("failed", (error) => {
      if (context.talkback === session) context.talkback = null;
      this.send(context, mediaError("talk", error?.code || "TALKBACK_DISCONNECTED"));
    });
    try {
      const result = await session.start({
        ownerOpenid: context.openid,
        deviceSn: context.deviceSn,
        device: context.device,
      });
      if (context.talkback !== session || result?.cancelled) return;
    } catch (error) {
      if (context.talkback !== session) return;
      if (context.talkback === session) context.talkback = null;
      throw error;
    }
    this.send(context, mediaEvent("talk", "active"));
  }

  async stopTalkback(context, notify) {
    const session = context.talkback;
    if (!session) throw codedError("TALKBACK_NOT_ACTIVE");
    if (notify) this.send(context, mediaEvent("talk", "stopping"));
    if (context.talkback === session) context.talkback = null;
    await session.stop();
    if (notify) this.send(context, mediaEvent("talk", "idle"));
  }

  async startRecording(context, sessionId = "") {
    if (context.recording || context.recordingStart) throw codedError("MEDIA_ALREADY_ACTIVE");
    const generation = ++context.recordingGeneration;
    context.recordingTerminal = false;
    const start = { cancelled: false, session: null, startPromise: null };
    context.recordingStart = start;
    try {
      const descriptor = sessionId && this.resolveLiveSession
        ? await this.resolveLiveSession(context.openid, context.deviceSn, sessionId)
        : null;
      if (start.cancelled || context.recordingStart !== start) return;
      if (sessionId && !descriptor) throw codedError("LIVE_SESSION_NOT_FOUND");
      this.send(context, mediaEvent("record", "starting"));
      const session = this.createRecording({
        ownerOpenid: context.device.ownerOpenid || context.openid,
        actorOpenid: context.openid,
        deviceSn: context.deviceSn,
        ...(descriptor ? { descriptor } : { device: context.device }),
      });
      start.session = session;
      context.recording = session;
      session.once?.("failed", (error) => {
        if (generation !== context.recordingGeneration) return;
        if (context.recording === session) context.recording = null;
        context.recordingTerminal = true;
        context.reportedRecordingFailures.add(session);
        this.send(context, mediaError("record", error?.code || "RECORDING_FAILED"));
      });
      start.startPromise = session.start({
        ownerOpenid: context.device.ownerOpenid || context.openid,
        actorOpenid: context.openid,
        deviceSn: context.deviceSn,
        ...(descriptor ? {
          hlsSessionId: sessionId,
          sourceUrl: descriptor.playUrl,
          httpProxy: descriptor.httpProxy,
        } : { device: context.device }),
      });
      const job = await start.startPromise;
      start.startPromise = null;
      if (start.cancelled || context.recording !== session) {
        const stopped = await session.stop();
        if (generation !== context.recordingGeneration) return;
        if (stopped) {
          context.recordingTerminal = true;
          this.send(context, { ...mediaEvent("record", "ready"), ...publicRecording(stopped) });
        }
        return;
      }
      context.recordingStart = null;
      this.send(context, { ...mediaEvent("record", "active"), ...publicRecording(job) });
    } catch (error) {
      if (generation !== context.recordingGeneration) return;
      const failedSessionAlreadyReported = start.session && context.reportedRecordingFailures.has(start.session);
      if (context.recordingStart === start) context.recordingStart = null;
      if (context.recording === start.session) context.recording = null;
      if ((start.cancelled && !start.session) || failedSessionAlreadyReported || context.closed) return;
      throw error;
    }
  }

  async stopRecording(context, notify) {
    const start = context.recordingStart;
    const session = context.recording;
    if (!session && start) {
      start.cancelled = true;
      context.recordingStart = null;
      context.recordingTerminal = true;
      if (notify) {
        this.send(context, mediaEvent("record", "stopping"));
        this.send(context, mediaEvent("record", "idle"));
      }
      return;
    }
    if (!session && context.recordingTerminal) return;
    if (!session) throw codedError("RECORDING_NOT_ACTIVE");
    if (notify) this.send(context, mediaEvent("record", "stopping"));
    if (start?.startPromise) {
      start.cancelled = true;
      context.recording = null;
      context.recordingStart = null;
      context.recordingTerminal = true;
      if (notify) this.send(context, mediaEvent("record", "idle"));
      return;
    }
    context.recording = null;
    let job;
    try {
      job = await session.stop();
    } catch (error) {
      context.recordingTerminal = true;
      if (context.reportedRecordingFailures.has(session)) return;
      throw error;
    }
    context.recordingTerminal = true;
    if (notify) this.send(context, { ...mediaEvent("record", "finalizing"), ...publicRecording(job) });
  }

  async cleanupContext(context) {
    const operations = [];
    if (context.talkback) operations.push(this.stopTalkback(context, false).catch(() => {}));
    if (context.recording) operations.push(this.stopRecording(context, false).catch(() => {}));
    await Promise.all(operations);
    this.contexts.delete(context);
  }

  handleCommandError(context, error, operationScope = "") {
    const code = error?.code || "MEDIA_CONTROL_FAILED";
    const scope = operationScope || (code.startsWith("TALKBACK") ? "talk"
      : code.startsWith("RECORDING") || code.startsWith("LIVE_SESSION") ? "record"
        : "media");
    this.send(context, mediaError(scope, code));
    if (!context.authorized && ["AUTH_REQUIRED", "SESSION_INVALID", "DEVICE_NOT_FOUND"].includes(code)) {
      context.ws.close?.(1008, code);
    }
  }

  send(context, payload) {
    if (context?.closed || !context?.ws?.send) return;
    try {
      context.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn?.("[media-control] send failed", error?.message || "send failed");
    }
  }

  async idle() {
    await Promise.all([...this.contexts].map(async (context) => {
      await context.queue;
      await Promise.all([...context.operations]);
    }));
  }

  async close() {
    if (this.server && this.upgradeHandler) this.server.removeListener?.("upgrade", this.upgradeHandler);
    await Promise.all([...this.contexts].map((context) => this.enqueue(context, () => this.cleanupContext(context))));
    if (typeof this.webSocketServer.close === "function") {
      await new Promise((resolve) => this.webSocketServer.close(resolve));
    }
    this.server = null;
    this.upgradeHandler = null;
  }

  async closeUserDeviceContexts(openid, deviceSn) {
    const normalizedOpenid = String(openid || "");
    const normalizedSn = String(deviceSn || "");
    const contexts = [...this.contexts].filter((context) => (
      context.openid === normalizedOpenid && context.deviceSn === normalizedSn
    ));
    await Promise.all(contexts.map(async (context) => {
      context.closed = true;
      await this.enqueue(context, () => this.cleanupContext(context));
      context.ws.close?.(1008, "DEVICE_ACCESS_REVOKED");
    }));
    return contexts.length;
  }
}

module.exports = { MediaControlGateway, mediaPath };
