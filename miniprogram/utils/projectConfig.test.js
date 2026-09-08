const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const WECHAT_APP_ID = "touristappid";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8"));
}

function readJsonIfExists(relativePath) {
  const filePath = path.join(__dirname, "..", relativePath);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("WeChat project configs keep the real mini program appid", () => {
  const projectConfig = readJson("project.config.json");
  const privateConfig = readJson("project.private.config.json");
  const manifest = readJson("manifest.json");
  const rootProjectConfig = readJson("../project.config.json");
  const generatedProjectConfig = readJsonIfExists("unpackage/dist/dev/mp-weixin/project.config.json");
  const generatedPrivateConfig = readJsonIfExists("unpackage/dist/dev/mp-weixin/project.private.config.json");

  assert.equal(projectConfig.appid, WECHAT_APP_ID);
  assert.equal(privateConfig.appid, WECHAT_APP_ID);
  assert.equal(manifest["mp-weixin"].appid, WECHAT_APP_ID);
  assert.equal(rootProjectConfig.appid, WECHAT_APP_ID);
  assert.equal(projectConfig.setting.useLanDebug, false);
  assert.equal(privateConfig.setting.useLanDebug, false);
  assert.equal(rootProjectConfig.setting.useLanDebug, false);
  if (generatedProjectConfig) {
    assert.equal(generatedProjectConfig.appid, WECHAT_APP_ID);
    assert.equal(generatedProjectConfig.setting.useLanDebug, false);
  }
  if (generatedPrivateConfig) {
    assert.equal(generatedPrivateConfig.appid, WECHAT_APP_ID);
    assert.equal(generatedPrivateConfig.setting.useLanDebug, false);
  }
});

test("WeChat project configs validate legal request domains", () => {
  const projectConfig = readJson("project.config.json");
  const privateConfig = readJson("project.private.config.json");
  const rootProjectConfig = readJson("../project.config.json");
  const rootPrivateConfig = readJson("../project.private.config.json");
  const generatedProjectConfig = readJsonIfExists("unpackage/dist/dev/mp-weixin/project.config.json");
  const generatedPrivateConfig = readJsonIfExists("unpackage/dist/dev/mp-weixin/project.private.config.json");

  for (const config of [
    projectConfig,
    privateConfig,
    rootProjectConfig,
    rootPrivateConfig,
    generatedProjectConfig,
    generatedPrivateConfig,
  ].filter(Boolean)) {
    assert.equal(config.setting.urlCheck, true);
  }
});

test("WeChat true-device builds avoid a second enhanced JavaScript compilation", () => {
  const projectConfig = readJson("project.config.json");
  const privateConfig = readJson("project.private.config.json");
  const manifest = readJson("manifest.json");
  const rootProjectConfig = readJson("../project.config.json");
  const rootPrivateConfig = readJson("../project.private.config.json");
  const generatedProjectConfig = readJsonIfExists("unpackage/dist/dev/mp-weixin/project.config.json");
  const generatedPrivateConfig = readJsonIfExists("unpackage/dist/dev/mp-weixin/project.private.config.json");

  for (const config of [projectConfig, rootProjectConfig, generatedProjectConfig].filter(Boolean)) {
    assert.equal(config.setting.es6, false);
    assert.equal(config.setting.enhance, false);
    assert.equal(config.setting.minified, true);
  }
  assert.equal(manifest["mp-weixin"].setting.es6, false);
  assert.equal(manifest["mp-weixin"].setting.enhance, false);
  assert.equal(manifest["mp-weixin"].setting.minified, true);
  for (const config of [privateConfig, rootPrivateConfig, generatedPrivateConfig].filter(Boolean)) {
    assert.equal(config.setting.compileHotReLoad, false);
  }
});
