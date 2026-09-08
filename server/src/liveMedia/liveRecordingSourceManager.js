const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function isPlaylistUrl(value) {
  try {
    return /\.m3u8$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function proxyAgentFor(targetUrl, proxyUrl) {
  if (!proxyUrl) return undefined;
  return new URL(targetUrl).protocol === "https:"
    ? new HttpsProxyAgent(proxyUrl)
    : new HttpProxyAgent(proxyUrl);
}

function openUpstream(targetUrl, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, {
      agent: proxyAgentFor(url, options.proxyUrl),
      headers: {
        Accept: options.accept || "*/*",
        ...(options.range ? { Range: options.range } : {}),
      },
      timeout: Math.max(1000, Number(options.timeoutMs) || 15000),
    }, (response) => {
      const location = response.headers.location;
      if (
        location &&
        [301, 302, 303, 307, 308].includes(Number(response.statusCode)) &&
        redirectCount < MAX_REDIRECTS
      ) {
        response.resume();
        openUpstream(new URL(location, url).toString(), options, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      resolve({ response, finalUrl: url.toString() });
    });
    request.once("timeout", () => request.destroy(sourceError("RECORDING_SOURCE_TIMEOUT")));
    request.once("error", reject);
  });
}

function collectText(response) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    response.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_PLAYLIST_BYTES) {
        response.destroy(sourceError("RECORDING_SOURCE_PLAYLIST_TOO_LARGE"));
        return;
      }
      chunks.push(bytes);
    });
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
}

class LiveRecordingSourceManager {
  constructor(options = {}) {
    this.sources = new Map();
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.tokenFactory = options.tokenFactory || defaultToken;
    this.ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL_MS);
    this.openUpstream = options.openUpstream || openUpstream;
  }

  createSource(options = {}) {
    const playUrl = String(options.playUrl || "");
    const ownerOpenid = String(options.ownerOpenid || "");
    const deviceSn = String(options.deviceSn || "");
    const relayBaseUrl = String(options.relayBaseUrl || "").replace(/\/+$/, "");
    if (!ownerOpenid || !deviceSn || !/^https?:\/\//i.test(playUrl)) {
      throw new Error("LIVE_SESSION_NOT_FOUND");
    }
    const sessionId = String(this.idFactory());
    const relayToken = String(this.tokenFactory());
    const relayMode = String(options.relayMode || "");
    const manifestOnly = relayMode === "manifest";
    const useRelay = /^https?:\/\//i.test(relayBaseUrl)
      && (manifestOnly || !!String(options.httpProxy || ""));
    const source = {
      sessionId,
      ownerOpenid,
      deviceSn,
      upstreamUrl: playUrl,
      upstreamProxy: String(options.httpProxy || ""),
      relayBaseUrl,
      relayToken,
      useRelay,
      manifestOnly,
      vodPlaylist: options.vodPlaylist === true,
      assets: new Map(),
      cachedPlaylists: new Map(),
      transport: String(options.transport || "official-hls-recording-source"),
      live: options.live !== false,
      createdAt: this.now(),
      releaseSource: typeof options.releaseSource === "function" ? options.releaseSource : null,
      released: false,
    };
    this.sources.set(sessionId, source);
    return {
      ok: true,
      sessionId,
      transport: source.transport,
      recordingSource: true,
    };
  }

  hasSession(sessionId) {
    return this.sources.has(String(sessionId || ""));
  }

  getSessionMetadata(sessionId) {
    const source = this.sources.get(String(sessionId || ""));
    if (!source) return null;
    return {
      sessionId: source.sessionId,
      ownerOpenid: source.ownerOpenid,
      deviceSn: source.deviceSn,
      live: source.live,
      createdAt: source.createdAt,
    };
  }

  getSessionDescriptor(sessionId) {
    const source = this.sources.get(String(sessionId || ""));
    if (!source) return null;
    const playUrl = source.useRelay
      ? this.buildRelayUrl(source, "index.m3u8")
      : source.upstreamUrl;
    return {
      sessionId: source.sessionId,
      ownerOpenid: source.ownerOpenid,
      deviceSn: source.deviceSn,
      playUrl,
      httpProxy: "",
      transport: source.transport,
      live: source.live,
    };
  }

  buildRelayUrl(source, fileName) {
    return `${source.relayBaseUrl}/api/live-recording-sources/`
      + `${encodeURIComponent(source.sessionId)}/${encodeURIComponent(fileName)}`
      + `?access=${encodeURIComponent(source.relayToken)}`;
  }

  registerAsset(source, targetUrl) {
    const assetId = crypto.createHash("sha256").update(targetUrl).digest("base64url").slice(0, 32);
    const fileName = `asset-${assetId}${isPlaylistUrl(targetUrl) ? ".m3u8" : ".bin"}`;
    source.assets.set(fileName, targetUrl);
    return this.buildRelayUrl(source, fileName);
  }

  rewritePlaylist(source, playlist, baseUrl) {
    const rewriteTarget = (value) => {
      const target = new URL(value, baseUrl).toString();
      if (source.manifestOnly && !isPlaylistUrl(target)) return target;
      return this.registerAsset(source, target);
    };
    const lines = String(playlist || "").split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith("#")) return rewriteTarget(trimmed);
      return line.replace(/URI="([^"]+)"/g, (_match, value) => `URI="${rewriteTarget(value)}"`);
    });
    const hasEndList = lines.some((line) => line.trim() === "#EXT-X-ENDLIST");
    const hasPlaylistType = lines.some((line) => /^#EXT-X-PLAYLIST-TYPE:/i.test(line.trim()));
    if (source.vodPlaylist && hasEndList && !hasPlaylistType) {
      const headerIndex = lines.findIndex((line) => line.trim() === "#EXTM3U");
      lines.splice(headerIndex >= 0 ? headerIndex + 1 : 0, 0, "#EXT-X-PLAYLIST-TYPE:VOD");
    }
    return lines.join("\n");
  }

  async attachHttpResponse(sessionId, fileName, req, res) {
    const source = this.sources.get(String(sessionId || ""));
    if (!source || !source.useRelay || !safeEqual(req.query?.access, source.relayToken)) {
      throw sourceError("RECORDING_SOURCE_NOT_FOUND");
    }
    const targetUrl = fileName === "index.m3u8"
      ? source.upstreamUrl
      : source.assets.get(String(fileName || ""));
    if (!targetUrl) throw sourceError("RECORDING_SOURCE_NOT_FOUND");
    const cachedPlaylist = isPlaylistUrl(targetUrl)
      ? source.cachedPlaylists.get(targetUrl)
      : "";
    if (cachedPlaylist) {
      res.status(200);
      res.set({
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "private, max-age=300, immutable",
        "Content-Length": Buffer.byteLength(cachedPlaylist),
      });
      res.end(cachedPlaylist);
      return;
    }
    const { response, finalUrl } = await this.openUpstream(targetUrl, {
      proxyUrl: source.upstreamProxy,
      accept: isPlaylistUrl(targetUrl) ? "application/vnd.apple.mpegurl,*/*" : "*/*",
      range: req.get?.("range") || "",
    });
    if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
      response.resume();
      throw sourceError("RECORDING_SOURCE_UPSTREAM_UNAVAILABLE");
    }
    if (isPlaylistUrl(targetUrl)) {
      const playlist = await collectText(response);
      const rewritten = this.rewritePlaylist(source, playlist, finalUrl);
      if (source.vodPlaylist && /(?:^|\n)#EXT-X-ENDLIST(?:\n|$)/.test(rewritten)) {
        source.cachedPlaylists.set(targetUrl, rewritten);
      }
      res.status(200);
      res.set({
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": source.cachedPlaylists.has(targetUrl)
          ? "private, max-age=300, immutable"
          : "no-store",
        "Content-Length": Buffer.byteLength(rewritten),
      });
      res.end(rewritten);
      return;
    }
    res.status(Number(response.statusCode) || 200);
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers[header];
      if (value) res.set(header, value);
    }
    res.set("Cache-Control", "no-store");
    response.once("error", () => {
      if (!res.destroyed) res.destroy();
    });
    response.pipe(res);
  }

  async stopSession(sessionId) {
    const key = String(sessionId || "");
    const source = this.sources.get(key);
    if (!source) return false;
    this.sources.delete(key);
    if (!source.released && source.releaseSource) {
      source.released = true;
      await source.releaseSource();
    }
    return true;
  }

  async stopUserDeviceSessions(ownerOpenid, deviceSn) {
    const normalizedOpenid = String(ownerOpenid || "");
    const normalizedSn = String(deviceSn || "");
    if (!normalizedOpenid || !normalizedSn) return 0;
    const sessionIds = [...this.sources.values()]
      .filter((source) => source.ownerOpenid === normalizedOpenid && source.deviceSn === normalizedSn)
      .map((source) => source.sessionId);
    for (const sessionId of sessionIds) await this.stopSession(sessionId);
    return sessionIds.length;
  }

  async stopDeviceSessions(deviceSn, options = {}) {
    const normalizedSn = String(deviceSn || "");
    if (!normalizedSn) return 0;
    const liveFilter = typeof options.live === "boolean" ? options.live : null;
    const sessionIds = [...this.sources.values()]
      .filter((source) => source.deviceSn === normalizedSn)
      .filter((source) => liveFilter === null || source.live === liveFilter)
      .map((source) => source.sessionId);
    for (const sessionId of sessionIds) await this.stopSession(sessionId);
    return sessionIds.length;
  }

  async cleanupExpired() {
    const expired = [...this.sources.values()]
      .filter((source) => this.now() - source.createdAt >= this.ttlMs)
      .map((source) => source.sessionId);
    await Promise.all(expired.map((sessionId) => this.stopSession(sessionId)));
    return expired.length;
  }
}

module.exports = {
  LiveRecordingSourceManager,
  isPlaylistUrl,
  openUpstream,
};
