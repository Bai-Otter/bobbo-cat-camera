const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_EXTENSIONS = new Set([".mp3", ".m4a", ".wav"]);

class BgmLibrary {
  constructor({ dir, random = Math.random } = {}) {
    this.dir = path.resolve(dir || "");
    this.random = random;
  }

  list() {
    const manifestPath = path.join(this.dir, "library.json");
    if (!this.dir || !fs.existsSync(manifestPath)) return [];
    let manifest;
    let realDir;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      realDir = fs.realpathSync(this.dir);
    } catch (error) {
      return [];
    }
    const tracks = [];
    const seenIds = new Set();
    for (const entry of Array.isArray(manifest.tracks) ? manifest.tracks : []) {
      const track = this.normalizeTrack(entry, realDir);
      if (!track || seenIds.has(track.id)) continue;
      seenIds.add(track.id);
      tracks.push(track);
    }
    return tracks;
  }

  get(id) {
    const target = String(id || "").trim();
    return this.list().find((track) => track.id === target) || null;
  }

  listPublic() {
    return this.list().map(({ id, title, artist, licenseSource }) => ({
      id,
      title,
      artist,
      licenseSource,
    }));
  }

  normalizeTrack(track, realDir) {
    if (!track || typeof track !== "object" || Array.isArray(track)) return null;
    const id = String(track.id || "").trim();
    if (!id) return null;
    const relativeFile = String(track.file || "");
    const filePath = path.resolve(this.dir, relativeFile);
    const relative = path.relative(this.dir, filePath);
    if (!relativeFile || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
    try {
      const realFilePath = fs.realpathSync(filePath);
      const realRelative = path.relative(realDir, realFilePath);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
      if (!fs.statSync(realFilePath).isFile()) return null;
    } catch (error) {
      return null;
    }
    return {
      id,
      title: String(track.title || id),
      artist: String(track.artist || ""),
      filePath,
      licenseSource: String(track.licenseSource || ""),
    };
  }

  pick({ previousId = "" } = {}) {
    const tracks = this.list();
    if (tracks.length === 0) throw new Error("BGM_LIBRARY_EMPTY");
    let candidates = tracks.length > 1 && previousId
      ? tracks.filter((track) => track.id !== previousId)
      : tracks;
    if (candidates.length === 0) candidates = tracks;
    const index = Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length));
    return candidates[index];
  }
}

module.exports = { BgmLibrary, SUPPORTED_EXTENSIONS };

