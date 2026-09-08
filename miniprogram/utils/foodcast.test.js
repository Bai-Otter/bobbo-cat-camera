const test = require("node:test");
const assert = require("node:assert/strict");

const {
  foodcastErrorMessage,
  foodcastStageText,
  saveFoodcastVideo,
} = require("./foodcast.js");

test("foodcast status helpers provide stable user-facing Chinese text", () => {
  assert.equal(foodcastStageText({ status: "queued" }), "等待生成");
  assert.equal(foodcastStageText({ status: "running", stage: "rendering" }), "正在剪辑和配乐");
  assert.equal(foodcastStageText({ status: "ready" }), "吃播已生成");
  assert.equal(foodcastErrorMessage("NO_FEEDING_SEGMENTS"), "这段时间没有识别到猫咪进食");
  assert.equal(foodcastErrorMessage("NO_CUTE_HIGHLIGHTS"), "这次进食还没有识别到可爱瞬间");
  assert.equal(foodcastErrorMessage("BGM_LIBRARY_EMPTY"), "吃播曲库还没有配置音乐");
  assert.equal(foodcastErrorMessage("BGM_NOT_FOUND"), "歌曲暂不可用，请重新选择");
});

test("saveFoodcastVideo downloads the MP4 and saves it to the phone album", async () => {
  const calls = [];
  const uni = {
    downloadFile(options) {
      calls.push(["download", options.url]);
      options.success({ statusCode: 200, tempFilePath: "tmp/foodcast.mp4" });
    },
    saveVideoToPhotosAlbum(options) {
      calls.push(["save", options.filePath]);
      options.success();
    },
  };

  await saveFoodcastVideo(uni, "https://backend.test/job.mp4?token=secret");

  assert.deepEqual(calls, [
    ["download", "https://backend.test/job.mp4?token=secret"],
    ["save", "tmp/foodcast.mp4"],
  ]);
});

test("saveFoodcastVideo guides denied album permission to settings", async () => {
  let openedSettings = false;
  const uni = {
    downloadFile(options) {
      options.success({ statusCode: 200, tempFilePath: "tmp/foodcast.mp4" });
    },
    saveVideoToPhotosAlbum(options) {
      options.fail({ errMsg: "saveVideoToPhotosAlbum:fail auth deny" });
    },
    showModal(options) {
      assert.match(options.content, /相册权限/);
      options.success({ confirm: true });
    },
    openSetting(options) {
      openedSettings = true;
      options.success({});
    },
  };

  await assert.rejects(
    saveFoodcastVideo(uni, "https://backend.test/job.mp4"),
    { message: "ALBUM_PERMISSION_DENIED" }
  );

  assert.equal(openedSettings, true);
});

