const test = require("node:test");
const assert = require("node:assert/strict");

const { guideAlbumPermission, saveRemoteImage, saveRemoteVideo } = require("./mediaAlbum.js");

test("remote images and 200/206 videos download to temporary files before album save", async () => {
  const calls = [];
  const api = {
    downloadFile(options) {
      calls.push(["download", options.url]);
      options.success({
        statusCode: options.url.endsWith(".jpg") ? 200 : 206,
        tempFilePath: options.url.endsWith(".jpg") ? "tmp/capture.jpg" : "tmp/recording.mp4",
      });
    },
    saveImageToPhotosAlbum(options) {
      calls.push(["image", options.filePath]);
      options.success({});
    },
    saveVideoToPhotosAlbum(options) {
      calls.push(["video", options.filePath]);
      options.success({});
    },
  };

  assert.equal((await saveRemoteImage(api, "https://media.test/capture.jpg")).filePath, "tmp/capture.jpg");
  assert.equal((await saveRemoteVideo(api, "https://media.test/recording.mp4")).filePath, "tmp/recording.mp4");
  assert.deepEqual(calls, [
    ["download", "https://media.test/capture.jpg"],
    ["image", "tmp/capture.jpg"],
    ["download", "https://media.test/recording.mp4"],
    ["video", "tmp/recording.mp4"],
  ]);
});

test("local temporary screenshots skip download", async () => {
  let downloaded = false;
  const api = {
    downloadFile() { downloaded = true; },
    saveImageToPhotosAlbum(options) {
      assert.equal(options.filePath, "wxfile://tmp/capture.jpg");
      options.success({});
    },
  };
  await saveRemoteImage(api, "wxfile://tmp/capture.jpg");
  assert.equal(downloaded, false);
});

test("remote screenshots use a jpg destination so WeChat accepts the downloaded file", async () => {
  let downloadFilePath = "";
  let savedFilePath = "";
  const api = {
    env: { USER_DATA_PATH: "wxfile://userdata" },
    downloadFile(options) {
      downloadFilePath = options.filePath;
      options.success({ statusCode: 200 });
    },
    saveImageToPhotosAlbum(options) {
      savedFilePath = options.filePath;
      options.success({});
    },
  };

  await saveRemoteImage(api, "https://capture.test/private-image");

  assert.match(downloadFilePath, /^wxfile:\/\/userdata\/device-capture-\d+\.jpg$/);
  assert.equal(savedFilePath, downloadFilePath);
});

test("album denial opens settings after confirmation and cancellation is stable", async () => {
  let opened = 0;
  const confirmed = {
    showModal(options) { options.success({ confirm: true, cancel: false }); },
    openSetting(options) { opened += 1; options.success({}); },
  };
  assert.equal(await guideAlbumPermission(confirmed), true);
  assert.equal(opened, 1);

  const cancelled = {
    showModal(options) { options.success({ confirm: false, cancel: true }); },
    openSetting() { assert.fail("cancel must not open settings"); },
  };
  await assert.rejects(guideAlbumPermission(cancelled), { code: "ALBUM_PERMISSION_CANCELLED" });
});

test("denied save guides permission and preserves a completed recording for later retry", async () => {
  let saveAttempts = 0;
  let resolveCalls = 0;
  const api = {
    downloadFile(options) {
      options.success({ statusCode: 200, tempFilePath: `tmp/retry-${resolveCalls}.mp4` });
    },
    saveVideoToPhotosAlbum(options) {
      saveAttempts += 1;
      if (saveAttempts === 1) options.fail({ errMsg: "saveVideoToPhotosAlbum:fail auth deny" });
      else options.success({ filePath: options.filePath });
    },
    showModal(options) { options.success({ confirm: true }); },
    openSetting(options) { options.success({}); },
  };
  const saveCompletedRecording = async () => {
    resolveCalls += 1;
    const currentUrl = `https://media.test/recording.mp4?token=fresh-${resolveCalls}`;
    return saveRemoteVideo(api, currentUrl);
  };

  await assert.rejects(saveCompletedRecording(), { code: "ALBUM_PERMISSION_DENIED" });
  const saved = await saveCompletedRecording();
  assert.equal(saved.filePath, "tmp/retry-2.mp4");
  assert.equal(resolveCalls, 2);
  assert.equal(saveAttempts, 2);
});
