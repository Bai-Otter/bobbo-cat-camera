const { spawn: defaultSpawn } = require("node:child_process");

class FlvRelay {
  constructor(options = {}) {
    this.transport = options.transport || "device-pri-flv";
    this.contentType = options.contentType || "video/x-flv";
    this.spawn = options.spawn || defaultSpawn;
    this.ffmpegPath = options.ffmpegPath || "";
    this.logger = options.logger || console;
    this.clients = new Set();
    this.closed = false;
    this.firstChunkSeen = false;
    this.ffmpeg = null;
  }

  write(chunk) {
    if (this.closed || !chunk) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.firstChunkSeen) {
      this.firstChunkSeen = true;
      if (!isLikelyFlv(buffer) && this.ffmpegPath) {
        this.startFfmpeg();
      }
    }
    if (this.ffmpeg) {
      this.ffmpeg.stdin.write(buffer);
      return;
    }
    this.broadcast(buffer);
  }

  attachHttpResponse(req, res) {
    if (this.closed) {
      res.statusCode = 410;
      res.end("replay session closed");
      return;
    }
    res.writeHead(200, {
      "Content-Type": this.contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "keep-alive",
    });
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  end() {
    if (this.ffmpeg?.stdin && !this.ffmpeg.stdin.destroyed) {
      this.ffmpeg.stdin.end();
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  destroy(error) {
    if (error) this.logger.warn?.("[flvRelay] source error", error.message || error);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
      this.ffmpeg = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  startFfmpeg() {
    if (this.ffmpeg || !this.ffmpegPath) return;
    this.transport = "device-pri-ffmpeg-flv";
    this.ffmpeg = this.spawn(this.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-i",
      "pipe:0",
      "-c",
      "copy",
      "-f",
      "flv",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpeg.stdout.on("data", (chunk) => this.broadcast(chunk));
    this.ffmpeg.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.logger.warn?.("[flvRelay] ffmpeg", text);
    });
    this.ffmpeg.on("error", (error) => {
      this.logger.warn?.("[flvRelay] ffmpeg error", error.message);
      this.close();
    });
    this.ffmpeg.on("close", () => {
      this.ffmpeg = null;
      this.end();
    });
  }

  broadcast(chunk) {
    for (const client of this.clients) {
      client.write(chunk);
    }
  }
}

function isLikelyFlv(chunk) {
  return chunk.length >= 3 && chunk[0] === 0x46 && chunk[1] === 0x4c && chunk[2] === 0x56;
}

module.exports = {
  FlvRelay,
  isLikelyFlv,
};
