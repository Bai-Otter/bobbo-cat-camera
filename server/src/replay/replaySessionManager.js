const crypto = require("node:crypto");

const DEFAULT_TTL_MS = 10 * 60 * 1000;

class ReplaySessionManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.sessionByDevice = new Map();
    this.createNativeClient = options.createNativeClient || (() => {
      throw new Error("REPLAY_NATIVE_CLIENT_FACTORY_MISSING");
    });
    this.createRelay = options.createRelay || (() => {
      throw new Error("REPLAY_RELAY_FACTORY_MISSING");
    });
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.now = options.now || (() => Date.now());
    this.ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  }

  async createSession(options = {}) {
    if (!options.deviceSn) throw new Error("REPLAY_DEVICE_SN_REQUIRED");
    const record = normalizeReplayRecord(options.record || options);
    await this.stopDeviceSession(options.deviceSn);

    const sessionId = this.idFactory();
    const relay = this.createRelay({ sessionId, deviceSn: options.deviceSn });
    const nativeClient = this.createNativeClient({
      deviceSn: options.deviceSn,
      lanHost: options.lanHost || "",
    });
    const channel = Number(options.channel || 0);
    const stream = options.stream || "Main";
    const targetSec = Math.max(0, Number(options.targetSec) || 0);
    const session = {
      id: sessionId,
      deviceSn: options.deviceSn,
      ownerOpenid: String(options.ownerOpenid || ""),
      channel,
      stream,
      record,
      currentSec: targetSec,
      durationSec: record.durationSec,
      nativeClient,
      relay,
      createdAt: this.now(),
      lastAccessAt: this.now(),
      transport: relay.transport || "device-pri-flv",
    };

    try {
      await nativeClient.startPlayback({
        channel,
        stream,
        beginTime: record.beginTime,
        fileName: record.fileName,
        targetSec,
        onData: (chunk) => relay.write?.(chunk),
        onError: (error) => relay.destroy?.(error),
        onClose: () => relay.end?.(),
      });
    } catch (error) {
      relay.close?.();
      throw error;
    }

    this.sessions.set(sessionId, session);
    this.sessionByDevice.set(options.deviceSn, sessionId);
    return this.publicSession(session, options.baseUrl);
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastAccessAt = this.now();
    return session;
  }

  getSessionMetadata(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      deviceSn: session.deviceSn,
      ownerOpenid: session.ownerOpenid,
    };
  }

  async seekSession(sessionId, targetSec) {
    const session = this.requireSession(sessionId);
    const currentSec = Math.max(0, Number(targetSec) || 0);
    await session.nativeClient.seekTo({
      channel: session.channel,
      stream: session.stream,
      beginTime: session.record.beginTime,
      targetSec: currentSec,
    });
    session.currentSec = currentSec;
    session.lastAccessAt = this.now();
    return { ok: true, currentSec, transport: session.transport };
  }

  async pauseSession(sessionId) {
    const session = this.requireSession(sessionId);
    await session.nativeClient.pausePlayback({ channel: session.channel, stream: session.stream });
    session.lastAccessAt = this.now();
    return { ok: true };
  }

  async resumeSession(sessionId) {
    const session = this.requireSession(sessionId);
    await session.nativeClient.resumePlayback({ channel: session.channel, stream: session.stream });
    session.lastAccessAt = this.now();
    return { ok: true };
  }

  attachHttpResponse(sessionId, req, res) {
    const session = this.requireSession(sessionId);
    session.lastAccessAt = this.now();
    return session.relay.attachHttpResponse(req, res);
  }

  async stopDeviceSession(deviceSn) {
    const sessionId = this.sessionByDevice.get(deviceSn);
    if (!sessionId) return false;
    return this.stopSession(sessionId);
  }

  async stopUserDeviceSessions(ownerOpenid, deviceSn) {
    const normalizedOpenid = String(ownerOpenid || "");
    const normalizedSn = String(deviceSn || "");
    if (!normalizedOpenid || !normalizedSn) return 0;
    const sessionIds = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.ownerOpenid === normalizedOpenid && session.deviceSn === normalizedSn) {
        sessionIds.push(sessionId);
      }
    }
    for (const sessionId of sessionIds) await this.stopSession(sessionId);
    return sessionIds.length;
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (this.sessionByDevice.get(session.deviceSn) === sessionId) {
      this.sessionByDevice.delete(session.deviceSn);
    }
    try {
      await session.nativeClient.stopPlayback({
        channel: session.channel,
        stream: session.stream,
        beginTime: session.record.beginTime,
      });
    } finally {
      session.relay.close?.();
    }
    return true;
  }

  async cleanupExpired() {
    const cutoff = this.now() - this.ttlMs;
    const staleIds = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastAccessAt < cutoff) staleIds.push(sessionId);
    }
    for (const sessionId of staleIds) {
      await this.stopSession(sessionId);
    }
    return staleIds.length;
  }

  requireSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("REPLAY_SESSION_NOT_FOUND");
    return session;
  }

  publicSession(session, baseUrl = "") {
    const normalizedBaseUrl = String(baseUrl || "").replace(/\/$/, "");
    return {
      ok: true,
      sessionId: session.id,
      streamUrl: `${normalizedBaseUrl}/api/replay-sessions/${encodeURIComponent(session.id)}/live.flv`,
      durationSec: session.durationSec,
      currentSec: session.currentSec,
      transport: session.transport,
    };
  }
}

function normalizeReplayRecord(record = {}) {
  const beginTime = record.beginTime || record.BeginTime || record.startTime;
  const endTime = record.endTime || record.EndTime;
  const fileName = record.fileName || record.FileName;
  const durationSec =
    Number(record.durationSec) ||
    Math.max(1, Math.round((parseDeviceLocalTime(endTime) - parseDeviceLocalTime(beginTime)) / 1000));
  if (!beginTime) throw new Error("REPLAY_BEGIN_TIME_REQUIRED");
  if (!endTime) throw new Error("REPLAY_END_TIME_REQUIRED");
  if (!fileName) throw new Error("REPLAY_FILE_NAME_REQUIRED");
  return { beginTime, endTime, fileName, durationSec };
}

function parseDeviceLocalTime(value) {
  const text = String(value || "").replace("T", " ");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_DEVICE_TIME: " + value);
  return parsed;
}

module.exports = {
  ReplaySessionManager,
  normalizeReplayRecord,
};
