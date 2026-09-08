const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const crypto = require("node:crypto");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const PLAYLIST_WAIT_MS = 8 * 1000;
const HLS_READY_TIMEOUT_MS = 8 * 1000;
const HLS_READY_POLL_MS = 100;
const HLS_READY_SEGMENT_COUNT = 1;
const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS = [0, 500, 1500];
const REPLAY_HLS_START_FAILED = "REPLAY_HLS_START_FAILED";
const REPLAY_HLS_START_TIMEOUT = "REPLAY_HLS_START_TIMEOUT";
const REPLAY_HLS_RECOVERY_FAILED = "REPLAY_HLS_RECOVERY_FAILED";

class HlsTranscodeSessionManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.rootDir = options.rootDir || path.join(os.tmpdir(), "cat-camera-replay-hls");
    this.ffmpegPath = options.ffmpegPath || "";
    this.spawn = options.spawn || defaultSpawn;
    this.createReadStream = options.createReadStream || fs.createReadStream;
    this.now = options.now || (() => Date.now());
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
    this.hlsReadyTimeoutMs = Number(options.hlsReadyTimeoutMs ?? HLS_READY_TIMEOUT_MS);
    this.hlsReadyPollMs = Number(options.hlsReadyPollMs ?? HLS_READY_POLL_MS);
    this.hlsReadySegmentCount = Number(options.hlsReadySegmentCount ?? HLS_READY_SEGMENT_COUNT);
    this.ffmpegStopTimeoutMs = Number(options.ffmpegStopTimeoutMs ?? 3000);
    this.recoveryMaxAttempts = Math.max(1, Number(options.recoveryMaxAttempts ?? RECOVERY_MAX_ATTEMPTS));
    this.recoveryBackoffMs = Array.isArray(options.recoveryBackoffMs)
      ? options.recoveryBackoffMs.map((value) => Math.max(0, Number(value) || 0))
      : RECOVERY_BACKOFF_MS;
    this.sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.logger = options.logger || console;
    this.instanceId = String(options.instanceId || process.env.HOSTNAME || "local").slice(0, 80);
    this.intentionalFfmpegStops = new WeakSet();
  }

  traceHttp(event, sessionId, fileName, fields = {}) {
    this.logger.info?.(
      `[DEBUG-HLS-HTTP-7f3a] ${event} ${JSON.stringify({
        instance: this.instanceId,
        session: String(sessionId || "").slice(0, 8),
        file: path.basename(String(fileName || "")),
        ...fields,
      })}`
    );
  }

  async createSession(options = {}) {
    if (!this.ffmpegPath) throw new Error("FFMPEG_NOT_CONFIGURED");
    if (!options.sourceUrl && !options.sourceController) throw new Error("HLS_SOURCE_REQUIRED");

    const reusable = this.findReusableSession(options);
    if (reusable) {
      reusable.lastAccessAt = this.now();
      return this.publicSession(reusable, false, true);
    }

    fs.mkdirSync(this.rootDir, { recursive: true });
    const sessionId = this.idFactory();
    const dir = path.join(this.rootDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const session = {
      id: sessionId,
      dir,
      sourceUrl: options.sourceUrl,
      sourceController: options.sourceController || null,
      seekSource: typeof options.seekSource === "function" ? options.seekSource : null,
      releaseSource: typeof options.releaseSource === "function" ? options.releaseSource : null,
      sourceStarted: false,
      sourceReleased: false,
      transport: options.transport || "rtsp-hls-relay",
      deviceSn: String(options.deviceSn || ""),
      ownerOpenid: String(options.ownerOpenid || ""),
      baseUrl: String(options.baseUrl || "").replace(/\/$/, ""),
      createdAt: this.now(),
      lastAccessAt: this.now(),
      durationSec: Number(options.durationSec || 0),
      currentSec: Math.max(0, Number(options.currentSec || 0)),
      live: options.live === true,
      videoFilter: String(options.videoFilter || ""),
      reuseKey: String(options.reuseKey || ""),
      forceTranscode: options.forceTranscode === true,
      videoMode: options.forceTranscode === true || options.videoFilter || options.sourceController
        ? "transcode"
        : "copy",
      fallbackAttempted: false,
      ffmpegStderr: "",
      ffmpeg: null,
      ffmpegStartedAt: 0,
      ffmpegExitCode: null,
      ffmpegExitSignal: "",
      startupState: "starting",
      startupError: "",
      readyAt: 0,
      closed: false,
      generation: 0,
      recoveryState: "idle",
      recoveryAttempts: 0,
      recoveryPromise: null,
      lastRecoveryError: "",
      readyTraced: false,
      seekChain: Promise.resolve(),
    };
    session.ffmpeg = this.startFfmpeg(session);
    this.sessions.set(sessionId, session);

    if (session.sourceController) {
      try {
        session.sourceStarted = true;
        await session.sourceController.start({
          write: (chunk) => this.writeSourceChunk(session, chunk),
          onError: (error) => this.logger.warn?.("[hlsRelay] native source error", error.message || error),
          onClose: () => this.logger.warn?.("[hlsRelay] native source closed"),
        });
      } catch (error) {
        await this.stopSession(sessionId);
        throw error;
      }
    }

    return this.publicSession(session);
  }

  publicSession(session, cacheBust = false, reused = false) {
    const suffix = cacheBust ? `?v=${session.generation}` : "";
    const playUrl = `${session.baseUrl}/api/replay-hls/${encodeURIComponent(session.id)}/index.m3u8${suffix}`;
    return {
      ok: true,
      sessionId: session.id,
      playUrl,
      streamUrl: playUrl,
      durationSec: session.durationSec,
      currentSec: session.currentSec,
      playbackType: "hls",
      transport: session.videoMode === "copy" && isRtspUrl(session.sourceUrl)
        ? "rtsp-hls-remux"
        : session.transport,
      fallback: true,
      reused,
    };
  }

  findReusableSession(options = {}) {
    const reuseKey = String(options.reuseKey || "");
    const deviceSn = String(options.deviceSn || "");
    const ownerOpenid = String(options.ownerOpenid || "");
    if (!reuseKey || !deviceSn || !ownerOpenid) return null;
    for (const session of this.sessions.values()) {
      if (
        !session.closed &&
        session.startupState !== "failed" &&
        session.reuseKey === reuseKey &&
        session.deviceSn === deviceSn &&
        session.ownerOpenid === ownerOpenid
      ) return session;
    }
    return null;
  }

  reuseSession(options = {}) {
    const session = this.findReusableSession(options);
    if (!session) return null;
    session.lastAccessAt = this.now();
    return this.publicSession(session, false, true);
  }

  async finalizeForAnalysis(sessionId, expectedDurationSec, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error("REPLAY_SESSION_NOT_FOUND");
    await this.waitUntilReady(sessionId, this.hlsReadyTimeoutMs);
    const expected = Math.max(0, Number(expectedDurationSec) || 0);
    const defaultTolerance = Math.max(1.5, Math.min(5, expected * 0.05));
    const tolerance = options.durationToleranceSec === undefined
      ? defaultTolerance
      : Math.max(0, Number(options.durationToleranceSec) || 0);
    const requiredDuration = Math.max(0, expected - tolerance);
    const timeoutMs = options.timeoutMs === undefined
      ? Math.max(60_000, expected * 1500 + 30_000)
      : Math.max(0, Number(options.timeoutMs) || 0);
    const ready = await waitForHlsCoverage(
      session.dir,
      requiredDuration,
      timeoutMs,
      this.hlsReadyPollMs
    );
    const partialCoverage = ready ? null : await readHlsCoverage(session.dir);
    if (!ready && partialCoverage.durationSec <= 0) {
      throw new Error("HLS_ANALYSIS_SOURCE_INCOMPLETE");
    }
    if (!ready) {
      this.logger.warn?.(
        `[hlsRelay] analysis source is partial (${partialCoverage.durationSec.toFixed(3)}s/${expected.toFixed(3)}s)`
      );
    }

    await this.finishFfmpeg(session);
    await appendHlsEndList(session.dir);
    session.lastAccessAt = this.now();
    const finalized = this.publicSession(session);
    return ready
      ? finalized
      : {
          ...finalized,
          analysisPartial: true,
          availableDurationSec: partialCoverage.durationSec,
        };
  }

  async finishFfmpeg(session) {
    const ffmpeg = session.ffmpeg;
    if (!ffmpeg) return;
    this.intentionalFfmpegStops.add(ffmpeg);
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          ffmpeg.kill("SIGKILL");
        } catch (error) {
          this.logger.warn?.("[hlsRelay] ffmpeg force stop failed", error.message || error);
          done();
        }
      }, this.ffmpegStopTimeoutMs);
      ffmpeg.once?.("close", done);
      ffmpeg.once?.("error", done);
      try {
        ffmpeg.kill("SIGTERM");
      } catch (error) {
        this.logger.warn?.("[hlsRelay] ffmpeg stop failed", error.message || error);
        done();
      }
    });
    if (session.ffmpeg === ffmpeg) session.ffmpeg = null;
  }

  writeSourceChunk(session, chunk) {
    const stdin = session.ffmpeg?.stdin;
    if (!stdin || stdin.destroyed || !chunk) return false;
    stdin.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  hasSession(sessionId) {
    const session = this.sessions.get(sessionId);
    return !!session && !session.closed;
  }

  getSessionMetadata(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return null;
    return {
      deviceSn: session.deviceSn,
      ownerOpenid: session.ownerOpenid,
    };
  }

  getSessionDescriptor(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return null;
    return {
      deviceSn: session.deviceSn,
      ownerOpenid: session.ownerOpenid,
      live: session.live,
      playUrl: this.publicSession(session).playUrl,
      reuseKey: session.reuseKey,
    };
  }

  getSessionStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return null;
    const state = session.recoveryState === "recovering" || session.recoveryState === "failed"
      ? session.recoveryState
      : session.startupState;
    return {
      ...this.publicSession(session, true),
      state,
      generation: session.generation,
      recoveryAttempts: session.recoveryAttempts,
      lastError: session.lastRecoveryError || session.startupError || "",
    };
  }

  async seekSession(sessionId, targetSec) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error("REPLAY_SESSION_NOT_FOUND");
    const nativeSeek = session.sourceController?.seek;
    if (!nativeSeek && !session.seekSource) throw new Error("HLS_SEEK_UNAVAILABLE");
    const normalizedTargetSec = Math.max(0, Math.min(Number(targetSec) || 0, Math.max(0, session.durationSec - 1)));
    const operation = session.seekChain.then(async () => {
      session.recoveryState = "idle";
      session.recoveryAttempts = 0;
      session.lastRecoveryError = "";
      await session.sourceController?.pause?.();
      await this.finishFfmpeg(session);
      await fs.promises.rm(session.dir, { recursive: true, force: true });
      await fs.promises.mkdir(session.dir, { recursive: true });
      session.currentSec = normalizedTargetSec;
      session.generation += 1;
      if (session.seekSource) {
        const refreshed = await session.seekSource(normalizedTargetSec);
        const sourceUrl = typeof refreshed === "string"
          ? refreshed
          : refreshed?.sourceUrl || refreshed?.url;
        if (!sourceUrl) throw new Error("HLS_SEEK_SOURCE_MISSING");
        session.sourceUrl = sourceUrl;
        if (Number(refreshed?.durationSec) > 0) {
          session.durationSec = Number(refreshed.durationSec);
        }
        if (Number.isFinite(Number(refreshed?.currentSec))) {
          session.currentSec = Math.max(0, Number(refreshed.currentSec));
        }
      }
      session.ffmpeg = this.startFfmpeg(session);
      if (nativeSeek) {
        await nativeSeek.call(session.sourceController, normalizedTargetSec);
        await session.sourceController.resume?.();
      }
      await this.waitUntilReady(sessionId, this.hlsReadyTimeoutMs);
      session.lastAccessAt = this.now();
      return this.publicSession(session, true);
    });
    session.seekChain = operation.catch(() => {});
    return operation;
  }

  startFfmpeg(session) {
    const playlistPath = path.join(session.dir, "index.m3u8");
    const segmentPath = path.join(session.dir, "seg_%05d.ts");
    const remainingSec = Math.max(1, Math.round(session.durationSec - session.currentSec));
    const inputArgs = session.sourceController
      ? ["-fflags", "+genpts+discardcorrupt", "-i", "pipe:0"]
      : isRtspUrl(session.sourceUrl)
        ? [
            "-fflags", "+genpts+discardcorrupt",
            "-analyzeduration", "500000",
            "-probesize", "1048576",
            "-timeout", "6000000",
            "-rtsp_transport", "tcp",
            "-i", session.sourceUrl,
          ]
        : ["-fflags", "+genpts+discardcorrupt", "-i", session.sourceUrl];
    const scaleFilter = "scale=w='trunc(min(1920,iw)/2)*2':h='trunc(min(1080,ih)/2)*2':force_original_aspect_ratio=decrease:in_range=auto:out_range=tv";
    const frameRateFilter = "fps=20";
    const outputFormatFilter = "setsar=1,format=yuv420p";
    const videoFilter = [scaleFilter, frameRateFilter, session.videoFilter, outputFormatFilter]
      .filter(Boolean)
      .join(",");
    const durationArgs = session.live ? [] : ["-t", String(remainingSec)];
    const videoCompatibilityArgs = [
      "-g", "20",
      "-keyint_min", "20",
      "-x264-params", "scenecut=0:force-cfr=1:repeat-headers=1:aud=1",
      "-force_key_frames", "expr:gte(t,n_forced*1)",
      "-avoid_negative_ts", "make_zero",
    ];
    const hlsWindowArgs = session.live
      ? [
          "-hls_list_size", "8",
          "-hls_delete_threshold", "8",
          "-hls_flags", "delete_segments+omit_endlist+independent_segments+temp_file",
        ]
      : [
          "-hls_list_size", "0",
          "-hls_playlist_type", "event",
          "-hls_flags", "independent_segments+temp_file",
        ];
    const videoArgs = session.videoMode === "copy"
      ? ["-c:v", "copy", "-avoid_negative_ts", "make_zero"]
      : [
          "-vf", videoFilter,
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-tune", "zerolatency",
          "-profile:v", "baseline",
          "-level", "4.0",
          "-pix_fmt", "yuv420p",
          ...videoCompatibilityArgs,
        ];
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      ...inputArgs,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      ...videoArgs,
      "-af",
      "aresample=async=1:first_pts=0",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "96k",
      "-ar",
      "44100",
      "-ac",
      "1",
      ...durationArgs,
      "-f",
      "hls",
      "-hls_time",
      "1",
      ...hlsWindowArgs,
      "-hls_segment_filename",
      segmentPath,
      playlistPath,
    ];
    session.startupState = "starting";
    session.startupError = "";
    session.ffmpegStderr = "";
    session.ffmpegStartedAt = this.now();
    session.ffmpegExitCode = null;
    session.ffmpegExitSignal = "";
    session.readyAt = 0;
    const ffmpeg = this.spawn(this.ffmpegPath, args, {
      stdio: [session.sourceController ? "pipe" : "ignore", "ignore", "pipe"],
    });
    ffmpeg.stdin?.on?.("error", (error) => {
      if (error.code !== "EPIPE") this.logger.warn?.("[hlsRelay] ffmpeg stdin error", error.message);
    });
    ffmpeg.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      session.ffmpegStderr = `${session.ffmpegStderr}\n${text}`.slice(-6000);
      if (text) this.logger.warn?.("[hlsRelay] ffmpeg", text);
    });
    ffmpeg.on("error", (error) => {
      this.logger.warn?.("[hlsRelay] ffmpeg error", error.message);
      if (session.ffmpeg === ffmpeg && session.startupState !== "ready") {
        this.markStartupFailed(session, REPLAY_HLS_START_FAILED, {
          exitSignal: "spawn-error",
        });
      }
    });
    ffmpeg.on("close", (code, signal) => {
      this.handleFfmpegClose(session, ffmpeg, code, signal).catch((error) => {
        this.markStartupFailed(session, REPLAY_HLS_START_FAILED, {
          exitCode: code,
          exitSignal: signal,
        });
        this.logger.warn?.("[hlsRelay] ffmpeg close handling failed", error.message || error);
      });
    });
    return ffmpeg;
  }

  async handleFfmpegClose(session, ffmpeg, code, signal) {
    if (session.ffmpeg !== ffmpeg) return;
    const intentional = this.intentionalFfmpegStops.delete(ffmpeg);
    session.ffmpeg = null;
    session.ffmpegExitCode = Number.isInteger(code) ? code : null;
    session.ffmpegExitSignal = String(signal || "");
    if (intentional || session.closed) return;
    const fallbackStarted = await this.maybeFallbackToTranscode(session);
    if (fallbackStarted || session.closed) return;
    if (session.startupState === "ready") {
      const coverage = await readHlsCoverage(session.dir);
      const reachedEnd = coverage.ended || (
        session.durationSec > 0 &&
        session.currentSec + coverage.durationSec >= session.durationSec - 1
      );
      if (reachedEnd || session.live || !session.seekSource) {
        session.recoveryState = reachedEnd ? "ended" : "idle";
        return;
      }
      this.scheduleRecovery(session);
      return;
    }
    if (await this.markReadyIfPlayable(session)) return;
    this.markStartupFailed(session, REPLAY_HLS_START_FAILED, {
      exitCode: code,
      exitSignal: signal,
    });
  }

  scheduleRecovery(session) {
    if (!session || session.closed || session.recoveryPromise) return session?.recoveryPromise || null;
    session.recoveryState = "recovering";
    const operation = session.seekChain.then(() => this.recoverSession(session));
    session.seekChain = operation.catch(() => {});
    const tracked = operation
      .catch((error) => {
        session.recoveryState = "failed";
        session.lastRecoveryError = String(error?.code || error?.message || REPLAY_HLS_RECOVERY_FAILED);
        session.startupState = "failed";
        session.startupError = REPLAY_HLS_RECOVERY_FAILED;
        this.logger.warn?.("[hlsRelay] recovery exhausted", {
          session: String(session.id || "").slice(0, 8),
          deviceSn: session.deviceSn,
          attempts: session.recoveryAttempts,
          code: session.lastRecoveryError,
        });
      })
      .finally(() => {
        if (session.recoveryPromise === tracked) session.recoveryPromise = null;
      });
    session.recoveryPromise = tracked;
    return tracked;
  }

  async recoverSession(session) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.recoveryMaxAttempts; attempt += 1) {
      if (session.closed) return;
      session.recoveryAttempts = attempt;
      const delayMs = this.recoveryBackoffMs[Math.min(attempt - 1, this.recoveryBackoffMs.length - 1)] || 0;
      if (delayMs > 0) await this.sleep(delayMs);
      try {
        const coverage = await readHlsCoverage(session.dir);
        const targetSec = Math.max(0, Math.min(
          session.currentSec + coverage.durationSec,
          Math.max(0, session.durationSec - 1)
        ));
        const refreshed = await session.seekSource(targetSec);
        const sourceUrl = typeof refreshed === "string"
          ? refreshed
          : refreshed?.sourceUrl || refreshed?.url;
        if (!sourceUrl) throw new Error("HLS_RECOVERY_SOURCE_MISSING");
        await fs.promises.rm(session.dir, { recursive: true, force: true });
        await fs.promises.mkdir(session.dir, { recursive: true });
        session.sourceUrl = sourceUrl;
        session.currentSec = Number.isFinite(Number(refreshed?.currentSec))
          ? Math.max(0, Number(refreshed.currentSec))
          : targetSec;
        if (Number(refreshed?.durationSec) > 0) session.durationSec = Number(refreshed.durationSec);
        session.generation += 1;
        session.readyTraced = false;
        session.lastRecoveryError = "";
        session.ffmpeg = this.startFfmpeg(session);
        await this.waitUntilReady(session.id, this.hlsReadyTimeoutMs);
        session.recoveryState = "idle";
        this.logger.info?.("[hlsRelay] recovery ready", {
          session: String(session.id || "").slice(0, 8),
          deviceSn: session.deviceSn,
          attempt,
          generation: session.generation,
          currentSec: session.currentSec,
        });
        return;
      } catch (error) {
        lastError = error;
        if (session.ffmpeg) await this.finishFfmpeg(session);
        session.lastRecoveryError = String(error?.code || error?.message || REPLAY_HLS_RECOVERY_FAILED);
        this.logger.warn?.("[hlsRelay] recovery failed", {
          session: String(session.id || "").slice(0, 8),
          deviceSn: session.deviceSn,
          attempt,
          code: session.lastRecoveryError,
        });
      }
    }
    throw lastError || new Error(REPLAY_HLS_RECOVERY_FAILED);
  }

  markStartupFailed(session, code, details = {}) {
    if (!session || session.closed || session.startupState === "ready") return false;
    session.startupState = "failed";
    session.startupError = String(code || REPLAY_HLS_START_FAILED);
    if (Number.isInteger(details.exitCode)) session.ffmpegExitCode = details.exitCode;
    if (details.exitSignal) session.ffmpegExitSignal = String(details.exitSignal);
    this.logger.warn?.("[hlsRelay] startup failed", {
      session: String(session.id || "").slice(0, 8),
      deviceSn: session.deviceSn,
      code: session.startupError,
      exitCode: session.ffmpegExitCode,
      exitSignal: session.ffmpegExitSignal,
    });
    return true;
  }

  async markReadyIfPlayable(session) {
    if (!session || session.closed) return false;
    const ready = await hasPlayableHlsSegments(session.dir, this.hlsReadySegmentCount);
    if (!ready) return false;
    if (session.startupState !== "ready") {
      session.startupState = "ready";
      session.startupError = "";
      session.readyAt = this.now();
      this.logger.info?.("[hlsRelay] startup ready", {
        session: String(session.id || "").slice(0, 8),
        deviceSn: session.deviceSn,
        transport: this.publicSession(session).transport,
        firstSegmentMs: Math.max(0, session.readyAt - session.ffmpegStartedAt),
      });
    }
    return true;
  }

  async waitUntilReady(sessionId, timeoutMs = this.hlsReadyTimeoutMs) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw codedReplayError("REPLAY_SESSION_NOT_FOUND");
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() <= deadline) {
      if (await this.markReadyIfPlayable(session)) return this.publicSession(session);
      if (session.startupState === "failed") {
        throw codedReplayError(session.startupError || REPLAY_HLS_START_FAILED);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, this.hlsReadyPollMs)));
    }
    if (await this.markReadyIfPlayable(session)) return this.publicSession(session);
    this.markStartupFailed(session, REPLAY_HLS_START_TIMEOUT);
    throw codedReplayError(REPLAY_HLS_START_TIMEOUT);
  }

  async maybeFallbackToTranscode(session) {
    if (
      session.closed ||
      session.videoMode !== "copy" ||
      session.fallbackAttempted ||
      !isRtspUrl(session.sourceUrl)
    ) return false;
    if (await hasPlayableHlsSegments(session.dir, 1)) return false;
    if (!isRemuxCompatibilityError(session.ffmpegStderr)) return false;
    session.fallbackAttempted = true;
    session.videoMode = "transcode";
    session.transport = "rtsp-hls-transcode-fallback";
    await fs.promises.rm(session.dir, { recursive: true, force: true });
    await fs.promises.mkdir(session.dir, { recursive: true });
    session.ffmpegStderr = "";
    session.ffmpeg = this.startFfmpeg(session);
    return true;
  }

  async attachHttpResponse(sessionId, fileName, res, req = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      this.traceHttp("miss", sessionId, fileName, { method: String(req.method || "GET") });
      res.statusCode = 404;
      res.end("replay hls session not found");
      return;
    }
    session.lastAccessAt = this.now();
    const safeName = path.basename(fileName || "index.m3u8");
    const filePath = path.join(session.dir, safeName);
    if (!filePath.startsWith(session.dir)) {
      res.statusCode = 400;
      res.end("invalid hls path");
      return;
    }
    let exists = false;
    if (safeName.endsWith(".m3u8")) {
      try {
        await this.waitUntilReady(sessionId, PLAYLIST_WAIT_MS);
        exists = true;
      } catch (error) {
        const code = String(error.code || error.message || REPLAY_HLS_START_FAILED);
        this.traceHttp("startup-failed", sessionId, safeName, {
          method: String(req.method || "GET"),
          code,
        });
        const statusCode = code === REPLAY_HLS_START_TIMEOUT ? 504 : 502;
        await this.stopSession(sessionId);
        res.statusCode = statusCode;
        res.end(code);
        return;
      }
    } else {
      exists = await waitForFile(filePath, 3000);
    }
    if (!exists) {
      this.traceHttp("not-ready", sessionId, safeName, { method: String(req.method || "GET") });
      res.statusCode = 404;
      res.end("hls file not ready");
      return;
    }
    if (safeName.endsWith(".m3u8") && !session.readyTraced) {
      const playlistText = await fs.promises.readFile(filePath, "utf8").catch(() => "");
      const playlistVersion = Number(/#EXT-X-VERSION:(\d+)/.exec(playlistText)?.[1] || 0);
      const segmentCount = playlistText
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith("#") && line.trim().endsWith(".ts"))
        .length;
      session.readyTraced = true;
      this.traceHttp("ready", session.id, safeName, {
        version: playlistVersion,
        segments: segmentCount,
        live: session.live,
        transport: this.publicSession(session).transport,
      });
    }
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      this.traceHttp("stat-error", sessionId, safeName, { code: String(error.code || "UNKNOWN") });
      res.statusCode = error.code === "ENOENT" ? 404 : 500;
      res.end(error.code === "ENOENT" ? "hls file expired" : "hls file stat failed");
      return;
    }
    const rangeHeader = String(req.headers?.range || "").trim();
    const byteRange = rangeHeader ? parseByteRange(rangeHeader, stat.size) : null;
    if (rangeHeader && !byteRange) {
      this.traceHttp("invalid-range", sessionId, safeName, {
        range: rangeHeader.slice(0, 80),
        size: stat.size,
      });
      res.writeHead(416, {
        "Content-Range": `bytes */${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": "0",
      });
      res.end();
      return;
    }
    const stream = byteRange
      ? this.createReadStream(filePath, { start: byteRange.start, end: byteRange.end })
      : this.createReadStream(filePath);
    stream.once("error", (error) => {
      this.traceHttp("stream-error", sessionId, safeName, { code: String(error.code || "UNKNOWN") });
      if (error.code !== "ENOENT") {
        this.logger.warn?.("[hlsRelay] HLS file read failed", error.message || error);
      }
      if (!res.headersSent) {
        res.statusCode = error.code === "ENOENT" ? 404 : 500;
        res.end(error.code === "ENOENT" ? "hls file expired" : "hls file read failed");
        return;
      }
      res.destroy?.();
    });
    stream.once("open", () => {
      if (session.closed || this.sessions.get(sessionId) !== session) {
        stream.destroy?.();
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end("replay hls session expired");
        }
        return;
      }
      const contentLength = byteRange
        ? byteRange.end - byteRange.start + 1
        : stat.size;
      const traceFields = {
        method: String(req.method || "GET"),
        status: byteRange ? 206 : 200,
        bytes: contentLength,
        range: rangeHeader.slice(0, 80),
      };
      this.traceHttp("begin", sessionId, safeName, traceFields);
      stream.once("end", () => this.traceHttp("complete", sessionId, safeName, traceFields));
      res.writeHead(byteRange ? 206 : 200, {
        "Content-Type": contentTypeForHlsFile(safeName),
        "Cache-Control": safeName.endsWith(".m3u8") ? "no-store" : "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Content-Length": String(contentLength),
        ...(byteRange
          ? { "Content-Range": `bytes ${byteRange.start}-${byteRange.end}/${stat.size}` }
          : {}),
      });
      stream.pipe(res);
    });
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.closed = true;
    if (session.sourceStarted && session.sourceController?.stop) {
      session.sourceStarted = false;
      try {
        await session.sourceController.stop();
      } catch (error) {
        this.logger.warn?.("[hlsRelay] native source stop failed", error.message || error);
      }
    }
    await this.finishFfmpeg(session);
    if (!session.sourceReleased && session.releaseSource) {
      session.sourceReleased = true;
      try {
        await session.releaseSource();
      } catch (error) {
        this.logger.warn?.("[hlsRelay] official source release failed", error.message || error);
      }
    }
    await fs.promises.rm(session.dir, { recursive: true, force: true });
    return true;
  }

  async stopDeviceSessions(deviceSn) {
    const normalizedSn = String(deviceSn || "");
    if (!normalizedSn) return 0;
    const sessionIds = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.deviceSn === normalizedSn) sessionIds.push(sessionId);
    }
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }
    return sessionIds.length;
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
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      fs.stat(filePath, (error, stat) => {
        if (!error && stat.size > 0) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || "").trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function waitForHlsReady(dir, requiredSegmentCount, timeoutMs, pollMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (await hasPlayableHlsSegments(dir, requiredSegmentCount)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs)));
  }
  return false;
}

async function hasPlayableHlsSegments(dir, requiredSegmentCount) {
  try {
    const playlist = await fs.promises.readFile(path.join(dir, "index.m3u8"), "utf8");
    const segmentNames = playlist
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.toLowerCase().endsWith(".ts"));
    if (segmentNames.length < requiredSegmentCount) return false;
    const stats = await Promise.all(
      segmentNames.slice(0, requiredSegmentCount).map((name) => fs.promises.stat(path.join(dir, path.basename(name))))
    );
    return stats.every((stat) => stat.size > 0);
  } catch {
    return false;
  }
}

async function waitForHlsCoverage(dir, requiredDurationSec, timeoutMs, pollMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const coverage = await readHlsCoverage(dir);
    if (coverage.ended || coverage.durationSec >= requiredDurationSec) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs)));
  }
  return false;
}

async function readHlsCoverage(dir) {
  try {
    const playlist = await fs.promises.readFile(path.join(dir, "index.m3u8"), "utf8");
    const durations = [...playlist.matchAll(/^#EXTINF:([0-9.]+),?$/gm)].map((match) => Number(match[1]) || 0);
    const segmentNames = playlist
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.toLowerCase().endsWith(".ts"));
    if (durations.length === 0 || durations.length !== segmentNames.length) {
      return { durationSec: 0, ended: false };
    }
    const lastSegment = path.join(dir, path.basename(segmentNames.at(-1)));
    const stat = await fs.promises.stat(lastSegment);
    return {
      durationSec: stat.size > 0 ? durations.reduce((sum, value) => sum + value, 0) : 0,
      ended: /#EXT-X-ENDLIST\s*$/m.test(playlist),
    };
  } catch {
    return { durationSec: 0, ended: false };
  }
}

async function appendHlsEndList(dir) {
  const playlistPath = path.join(dir, "index.m3u8");
  const playlist = await fs.promises.readFile(playlistPath, "utf8");
  if (/#EXT-X-ENDLIST\s*$/m.test(playlist)) return;
  await fs.promises.appendFile(playlistPath, `${playlist.endsWith("\n") ? "" : "\n"}#EXT-X-ENDLIST\n`);
}

function contentTypeForHlsFile(fileName) {
  if (fileName.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (fileName.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

function isRtspUrl(value) {
  return /^rtsp:\/\//i.test(String(value || ""));
}

function isRemuxCompatibilityError(value) {
  return /could not write header|not currently supported|codec .* not supported|invalid codec tag|tag .* incompatible|invalid argument/i
    .test(String(value || ""));
}

function codedReplayError(code) {
  const error = new Error(String(code || REPLAY_HLS_START_FAILED));
  error.code = String(code || REPLAY_HLS_START_FAILED);
  return error;
}

module.exports = {
  HlsTranscodeSessionManager,
  isRtspUrl,
  contentTypeForHlsFile,
  isRemuxCompatibilityError,
};
