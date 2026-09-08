const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

class TalkbackSession extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.ffmpegPath) throw codedError("FFMPEG_PATH_REQUIRED");
    if (typeof options.resolveTalkbackUrl !== "function") throw codedError("TALKBACK_URL_RESOLVER_REQUIRED");
    this.ffmpegPath = options.ffmpegPath;
    this.resolveTalkbackUrl = options.resolveTalkbackUrl;
    this.spawn = options.spawn || childProcess.spawn;
    this.logger = options.logger || console;
    this.stopTimeoutMs = Math.max(1, Number(options.stopTimeoutMs) || 1500);
    this.maxBytes = Math.max(1, Number(options.maxBytes) || 64 * 1024 * 1024);
    this.state = "idle";
    this.bytesWritten = 0;
    this.process = null;
    this.stderrText = "";
    this.stopPromise = null;
    this.stopRequested = false;
    this.closePromise = null;
    this.resolveClose = null;
  }

  async start() {
    if (this.state !== "idle") throw codedError("TALKBACK_ALREADY_STARTED");
    this.state = "starting";
    let talkbackUrl;
    try {
      talkbackUrl = await this.resolveTalkbackUrl();
      if (this.stopRequested) {
        this.state = "stopped";
        return { active: false, cancelled: true };
      }
      if (!/^rtmps?:\/\//i.test(String(talkbackUrl || ""))) {
        throw codedError("TALKBACK_URL_INVALID");
      }
      const args = [
        "-hide_banner", "-loglevel", "warning",
        "-f", "aac", "-i", "pipe:0",
        "-vn", "-c:a", "copy", "-f", "flv", talkbackUrl,
      ];
      this.process = this.spawn(this.ffmpegPath, args, {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.state = "failed";
      throw codedError("TALKBACK_START_FAILED", error);
    }

    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    if (this.process.stderr?.on) {
      this.process.stderr.on("data", (chunk) => {
        this.stderrText = `${this.stderrText}${String(chunk || "")}`.slice(-4096);
      });
    }
    this.process.once("error", (error) => this.handleProcessFailure(error));
    this.process.once("close", (code, signal) => this.handleProcessClose(code, signal));
    this.state = "active";
    return { active: true };
  }

  writeAudio(frame) {
    if (this.state !== "active" || !this.process?.stdin) {
      throw codedError("TALKBACK_NOT_ACTIVE");
    }
    const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    if (this.bytesWritten + buffer.length > this.maxBytes) {
      throw codedError("TALKBACK_AUDIO_LIMIT");
    }
    this.process.stdin.write(buffer);
    this.bytesWritten += buffer.length;
    return buffer.length;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "starting" && !this.process) {
      this.stopRequested = true;
      this.state = "stopping";
      return;
    }
    if (!this.process || ["idle", "stopped"].includes(this.state)) return;
    this.stopPromise = this.stopProcess();
    return this.stopPromise;
  }

  async stopProcess() {
    const process = this.process;
    this.state = "stopping";
    if (process.stdin && !process.stdin.writableEnded) process.stdin.end();
    process.kill("SIGTERM");
    let timer;
    const timedOut = await Promise.race([
      this.closePromise.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), this.stopTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) process.kill("SIGKILL");
    this.state = "stopped";
    this.process = null;
  }

  handleProcessFailure(error) {
    if (["stopping", "stopped"].includes(this.state)) return;
    this.state = "failed";
    this.emit("failed", codedError("TALKBACK_DISCONNECTED", error));
  }

  handleProcessClose(code) {
    this.resolveClose?.();
    if (["stopping", "stopped"].includes(this.state)) return;
    if (Number(code) === 0) {
      this.state = "stopped";
      return;
    }
    const formatFailure = /invalid data|codec|aac|header|format/i.test(this.stderrText);
    const error = codedError(formatFailure ? "TALKBACK_FORMAT_REJECTED" : "TALKBACK_DISCONNECTED");
    this.state = "failed";
    this.emit("failed", error);
  }
}

module.exports = { TalkbackSession };
