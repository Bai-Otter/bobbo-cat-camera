const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BgmLibrary } = require("./bgmLibrary");

function makeLibrary(tracks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-bgm-"));
  for (const track of tracks) {
    if (track && !Array.isArray(track) && typeof track === "object" && track.file) {
      fs.writeFileSync(path.join(dir, track.file), "audio");
    }
  }
  fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify({ tracks }));
  return dir;
}

test("BgmLibrary loads authorized tracks from its manifest", () => {
  const dir = makeLibrary([
    { id: "cute-1", title: "Cute One", artist: "Artist", file: "cute-1.mp3", licenseSource: "user-authorized" },
  ]);

  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.list(), [
    {
      id: "cute-1",
      title: "Cute One",
      artist: "Artist",
      filePath: path.join(dir, "cute-1.mp3"),
      licenseSource: "user-authorized",
    },
  ]);
});

test("BgmLibrary resolves tracks by stable ID", () => {
  const dir = makeLibrary([
    { id: "bgm-01", title: "Track", artist: "Artist", file: "1.m4a", licenseSource: "authorized" },
  ]);
  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.get("bgm-01"), {
    id: "bgm-01",
    title: "Track",
    artist: "Artist",
    filePath: path.join(dir, "1.m4a"),
    licenseSource: "authorized",
  });
  assert.equal(library.get("../1.m4a"), null);
  assert.equal(library.get("missing"), null);
});

test("BgmLibrary exposes public metadata without filesystem paths", () => {
  const dir = makeLibrary([
    { id: "bgm-01", title: "Track", artist: "Artist", file: "1.m4a", licenseSource: "authorized" },
  ]);
  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.listPublic(), [
    {
      id: "bgm-01",
      title: "Track",
      artist: "Artist",
      licenseSource: "authorized",
    },
  ]);
});

test("repository BGM catalog contains the seven authorized audio files", () => {
  const dir = path.resolve(__dirname, "../../../bgm");
  const library = new BgmLibrary({ dir });
  const expected = [
    ["bgm-01", "似顔絵広場 (似顔絵チャンネル)", "戸高一生"],
    ["bgm-02", "咱是猫（猫なの）", "恩田　貴則"],
    ["bgm-03", "啦咪哆茜", "子凡"],
    ["bgm-04", "亿点点偷感", "丢了一个月亮"],
    ["bgm-05", "Droplets", "Irishy"],
    ["bgm-06", "兜圈（洛克王国BGM管弦乐版）", "GG BONG"],
    ["bgm-07", "Pixel Purr", "MAECU"],
  ].map(([id, title, artist]) => ({
    id,
    title,
    artist,
    licenseSource: "User-provided authorized file",
  }));

  assert.deepEqual(library.listPublic(), expected);
  for (const [index, track] of library.list().entries()) {
    const stats = fs.statSync(track.filePath);
    assert.equal(stats.isFile(), true);
    assert.equal(path.extname(track.filePath), ".m4a");
    assert.ok(stats.size < 100 * 1024 * 1024, `${index + 1}.m4a exceeds 100 MB`);
  }
});

test("BgmLibrary rejects missing, unsupported, and escaped track files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-bgm-invalid-"));
  fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify({
    tracks: [
      { id: "missing", file: "missing.mp3" },
      { id: "video", file: "clip.mp4" },
      { id: "escape", file: "../outside.mp3" },
    ],
  }));

  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.list(), []);
  assert.throws(() => library.pick(), { message: "BGM_LIBRARY_EMPTY" });
});

test("BgmLibrary rejects files that resolve outside the catalog through a junction", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-bgm-link-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-bgm-outside-"));
  const junctionPath = path.join(dir, "linked");
  fs.writeFileSync(path.join(outsideDir, "outside.mp3"), "audio");
  fs.symlinkSync(outsideDir, junctionPath, "junction");
  fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify({
    tracks: [{ id: "outside", file: "linked/outside.mp3" }],
  }));
  t.after(() => {
    fs.unlinkSync(junctionPath);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.list(), []);
  assert.equal(library.get("outside"), null);
});

test("BgmLibrary filters empty IDs and keeps the first track for duplicate IDs", () => {
  const dir = makeLibrary([
    { id: "", title: "Empty", file: "empty.mp3" },
    { id: "same", title: "First", file: "first.mp3" },
    { id: "same", title: "Second", file: "second.mp3" },
  ]);
  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.listPublic(), [
    { id: "same", title: "First", artist: "", licenseSource: "" },
  ]);
  assert.equal(library.get("same").title, "First");
  assert.equal(library.get("empty"), null);
});

test("BgmLibrary pick falls back to the stable duplicate when previous ID removes all candidates", () => {
  const dir = makeLibrary([
    { id: "same", title: "First", file: "first.mp3" },
    { id: "same", title: "Second", file: "second.mp3" },
  ]);
  const library = new BgmLibrary({ dir, random: () => 0 });

  const picked = library.pick({ previousId: "same" });

  assert.equal(picked.id, "same");
  assert.equal(picked.title, "First");
});

test("BgmLibrary ignores malformed manifest entries without hiding valid tracks", () => {
  const dir = makeLibrary([
    null,
    [],
    "invalid",
    42,
    { id: "valid", title: "Valid", file: "valid.mp3" },
  ]);
  const library = new BgmLibrary({ dir });

  assert.deepEqual(library.listPublic(), [
    { id: "valid", title: "Valid", artist: "", licenseSource: "" },
  ]);
});

test("BgmLibrary avoids selecting the previous track when alternatives exist", () => {
  const dir = makeLibrary([
    { id: "one", file: "one.mp3" },
    { id: "two", file: "two.wav" },
  ]);
  const library = new BgmLibrary({ dir, random: () => 0 });

  const picked = library.pick({ previousId: "one" });

  assert.equal(picked.id, "two");
});

