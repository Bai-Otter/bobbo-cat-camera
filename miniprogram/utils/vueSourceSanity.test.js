const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("backend login sends only the one-time WeChat code", () => {
  const source = fs.readFileSync(path.join(__dirname, "../pages/login/index.vue"), "utf8");
  const loginCall = source.match(/callBackend\('\/api\/auth\/wechat-login',[\s\S]*?\n\s*\}\)/);

  assert.ok(loginCall, "backend login call must remain present");
  assert.doesNotMatch(loginCall[0], /\bopenid\s*,/);
  assert.match(loginCall[0], /\bcode\b/);
  assert.doesNotMatch(loginCall[0], /nickname:|avatar:|appSecret|session_key/);
  assert.match(source, /const profile = saveAppSession/);
  assert.match(source, /finishLoginNavigation\(profile\)/);
});

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function extractStyleBlock(source, fileLabel) {
  const match = source.match(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/i);
  assert.ok(match, `${fileLabel} must include a style block`);
  return match[1].replace(/\/\*[\s\S]*?\*\//g, "");
}

const BOBBO_HEX_PALETTE = new Set([
  "#FBFBFA",
  "#EFEEEC",
  "#141414",
  "#989893",
  "#C4C4C0",
  "#E8E8E5",
  "#EFEFED",
  "#F1F1EF",
  "#2FA35C",
  "#3DDC74",
  "#E8734A",
  "#FFFFFF",
  "#000000",
  "#B4B4B0",
  "#DBDBD8",
  "#EDEDEB",
  "#8B8B88",
  "#C9A24B",
  "#D8D8D5",
  "#5A5A56",
  "#9A4A40",
  "#3476C9",
]);

function assertUsesOnlyBobboHexColors(styleSource, fileLabel) {
  const tokens = styleSource.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])/gi) || [];

  for (const token of tokens) {
    const raw = token.slice(1).toUpperCase();
    const hasAlpha = raw.length === 4 || raw.length === 8;
    assert.equal(hasAlpha, false, `${fileLabel} must not use alpha hex color ${token}`);
    const rgb = raw.length === 3
      ? raw.split("").map((digit) => digit + digit).join("")
      : raw;
    assert.ok(BOBBO_HEX_PALETTE.has(`#${rgb}`), `${fileLabel} uses non-Bobbo hex color ${token}`);
  }
}

function extractCssRules(styleSource, selector, fileLabel) {
  const matchingBodies = [];
  const rules = styleSource.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const match of rules) {
    const selectors = match[1].split(",").map((candidate) => candidate.trim());
    if (selectors.includes(selector)) matchingBodies.push(match[2]);
  }
  assert.ok(matchingBodies.length > 0, `${fileLabel} must define the ${selector} rule`);
  return matchingBodies;
}

function readCssDeclarations(ruleSources, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationPattern = new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+)`, "gi");
  return ruleSources.flatMap((ruleSource) =>
    Array.from(ruleSource.matchAll(declarationPattern), (match) => match[1].trim())
  );
}

function assertUniqueExactDeclaration(ruleSources, property, expectedValues, message) {
  const values = readCssDeclarations(ruleSources, property);
  assert.equal(values.length, 1, `${message}; ${property} must be declared exactly once`);
  const normalized = values[0].replace(/\s*!important\s*$/i, "").toUpperCase();
  assert.ok(expectedValues.map((value) => value.toUpperCase()).includes(normalized), message);
}

function splitCssValue(value) {
  const tokens = [];
  let current = "";
  let parenthesisDepth = 0;

  for (const character of value.trim()) {
    if (/\s/.test(character) && parenthesisDepth === 0) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    if (character === "(") parenthesisDepth += 1;
    if (character === ")") parenthesisDepth -= 1;
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isZeroCssValue(value) {
  return value == null || /^0(?:[a-z%]+)?$/i.test(value);
}

function assertNoHorizontalBoxSpacing(ruleSources, property, fileLabel) {
  const shorthands = readCssDeclarations(ruleSources, property);
  const explicitLeft = readCssDeclarations(ruleSources, `${property}-left`);
  const explicitRight = readCssDeclarations(ruleSources, `${property}-right`);

  for (const shorthand of shorthands) {
    const values = splitCssValue(shorthand);
    assert.ok(values.length >= 1 && values.length <= 4, `${fileLabel} has invalid ${property} shorthand`);
    const right = values.length === 1 ? values[0] : values[1];
    const left = values.length < 4 ? right : values[3];
    assert.ok(isZeroCssValue(left) && isZeroCssValue(right), `${fileLabel} must not use horizontal ${property}`);
  }
  assert.ok(explicitLeft.every(isZeroCssValue) && explicitRight.every(isZeroCssValue), `${fileLabel} must not use horizontal ${property}`);
}

function assertNoHorizontalLogicalSpacing(ruleSources, property, fileLabel) {
  const shorthands = readCssDeclarations(ruleSources, property);
  const starts = readCssDeclarations(ruleSources, `${property}-start`);
  const ends = readCssDeclarations(ruleSources, `${property}-end`);

  for (const shorthand of shorthands) {
    const values = splitCssValue(shorthand);
    assert.ok(values.length >= 1 && values.length <= 2, `${fileLabel} has invalid ${property} shorthand`);
    assert.ok(values.every(isZeroCssValue), `${fileLabel} must not use horizontal ${property}`);
  }
  assert.ok(starts.every(isZeroCssValue) && ends.every(isZeroCssValue), `${fileLabel} must not use horizontal ${property}`);
}

function assertNoCssProperties(ruleSources, properties, fileLabel) {
  for (const property of properties) {
    assert.equal(readCssDeclarations(ruleSources, property).length, 0, `${fileLabel} must not declare ${property}`);
  }
}

function extractScriptBlock(source, fileLabel) {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, `${fileLabel} 缺少 <script> 代码块`);
  return match[1];
}

function scriptToParsableJs(scriptSource) {
  return scriptSource
    .replace(/import\s+([A-Za-z0-9_$]+)\s+from\s+['"][^'"]+['"]/g, "const $1 = null")
    .replace(/export\s+default/, "module.exports =");
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

function assertVuePageIsSane(relativePath) {
  const source = readWorkspaceFile(relativePath);
  assert.equal(
    countMatches(source, /<text(?=[\s>])/g),
    countMatches(source, /<\/text>/g),
    `${relativePath} 的 <text> 标签没有正确闭合`
  );
  assert.doesNotThrow(() => {
    new Function(scriptToParsableJs(extractScriptBlock(source, relativePath)));
  }, `${relativePath} 的 <script> 代码不是有效语法`);
}

for (const relativePath of [
  "App.vue",
  "pages/launch/index.vue",
  "pages/login/index.vue",
	"pages/login/profile-setup.vue",
	"pages/share/accept.vue",
  "pages/bind/addDevice.vue",
  "pages/bind/bluetooth.vue",
  "pages/bind/qrcode.vue",
  "pages/bind/repairing.vue",
  "pages/device/index.vue",
	"pages/device/detail.vue",
  "pages/today/index.vue",
  "pages/clips/index.vue",
  "pages/clips/foodcast.vue",
  "pages/live/overview.vue",
  "pages/live/index.vue",
  "pages/live/replay.vue",
  "pages/profile/feedback.vue",
  "pages/profile/notifications.vue",
  "pages/profile/index.vue",
  "pages/profile/cats.vue",
  "pages/profile/settings.vue",
	"pages/profile/device-storage.vue",
	"pages/profile/foodcast-preferences.vue",
	"pages/profile/share-device.vue",
]) {
  test(`${relativePath} template and script stay syntactically sane`, () => {
    assertVuePageIsSane(relativePath);
  });
}

test("App.vue silently refreshes an existing backend session on launch", () => {
  const source = readWorkspaceFile("App.vue");

  assert.match(source, /refreshExistingSession/);
  assert.match(source, /requestWechatLoginCode/);
  assert.match(source, /\/api\/auth\/wechat-login/);
  assert.match(source, /saveAppSession/);
});

test("startup uses a non-tab launch gate before resolving authentication", () => {
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const launch = readWorkspaceFile("pages/launch/index.vue");
  const app = readWorkspaceFile("App.vue");
  const invalidSessionBranch = app.match(
    /if \(validation\.status === STARTUP_SESSION_STATUS\.INVALID\) \{([\s\S]*?)\n\s*\}/
  );

  assert.equal(pages.pages[0].path, "pages/launch/index");
  assert.equal(pages.pages[0].style.navigationStyle, "custom");
  assert.equal(Object.hasOwn(pages, "tabBar"), false, "the legacy native tab bar must not be configured");
  assert.match(launch, /src="\/static\/images\/bobbo-logo\.png"/);
  assert.doesNotMatch(launch, /<app-tab-bar|uni\.showTabBar/);
  assert.match(app, /postLoginRoute\(\)/);
	assert.match(app, /captureShareToken\(options\)/);
	assert.match(app, /onShow\(options = \{\}\)/);
	assert.match(app, /routeToPendingShare\(shareToken, this\.globalData\.startupResolved\)/);
	assert.match(app, /startupResolved/);
  assert.doesNotMatch(app, /uni\.switchTab|uni\.hideTabBar|uni\.showTabBar/);
  assert.match(app, /uni\.reLaunch\(\{ url: '\/pages\/login\/index' \}\)/);
  assert.ok(invalidSessionBranch, "invalid cached sessions must be handled explicitly");
  assert.match(invalidSessionBranch[1], /uni\.reLaunch\(\{ url: '\/pages\/login\/index' \}\)/);
});

test("login page keeps its visible WeChat login action and copy", () => {
  const source = readWorkspaceFile("pages/login/index.vue");

	assert.match(source, /首次登录将创建布卜布卜账号/);
  assert.match(source, /<button[^>]*@click=["']wxLogin["'][^>]*>[\s\S]*微信登录[\s\S]*<\/button>/);
  assert.match(source, /wx\.login\s*\(/);
  assert.match(source, /runLoginWithRetry/);
  assert.match(source, /requestWechatLoginCode/);
  assert.doesNotMatch(source, /wx\.cloud\.callFunction\s*\(/);
});

test("login page presents the Bobbo welcome panel with a clear visual hierarchy", () => {
  const source = readWorkspaceFile("pages/login/index.vue");
  const style = extractStyleBlock(source, "pages/login/index.vue");
  const logoAsset = path.join(__dirname, "..", "static", "images", "bobbo-logo.png");

  assert.match(source, /每一餐，都值得被看见/);
  assert.match(source, /从今天开始，记录猫咪的一天/);
  assert.match(source, /class="brand-logo"/);
  assert.match(source, /src="\/static\/images\/bobbo-logo\.png"/);
  assert.doesNotMatch(source, /class="brand-icon"|<cat-icon|BOBBO PET CAMERA/);
  assert.equal(fs.existsSync(logoAsset), true, "login page brand logo should be packaged");
  assert.equal(fs.readFileSync(logoAsset).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.match(source, /class="login-panel"/);
  assert.match(source, /class="login-meta"/);
  assert.match(style, /\.login-panel\s*\{[\s\S]*background:\s*#FFFFFF/i);
  assert.match(style, /\.brand-logo\s*\{/);
  assert.match(style, /\.brand-tagline\s*\{/);
  assert.doesNotMatch(style, /linear-gradient|box-shadow/i);
});

test("bobbo secondary utility pages use custom navigation and flat neutral styling", () => {
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const pagesByPath = new Map(pages.pages.map((page) => [page.path, page]));
  const utilityPages = [
    ["pages/bind/addDevice", "添加设备"],
    ["pages/bind/repairing", "手动绑定"],
    ["pages/bind/bluetooth", "蓝牙配网"],
    ["pages/bind/qrcode", "二维码配置"],
    ["pages/profile/feedback", "反馈"],
  ];

  for (const [pagePath, title] of utilityPages) {
    const route = pagesByPath.get(pagePath);
    const file = `${pagePath}.vue`;
    const source = readWorkspaceFile(file);
    const style = extractStyleBlock(source, file);
    assert.equal(route && route.style && route.style.navigationStyle, "custom", `${pagePath} must use custom navigation`);
    assert.match(source, new RegExp(`<bobbo-nav-bar[^>]*title="${title}"`));
    assert.match(style, /background:\s*#FBFBFA/i, `${file} must use the Bobbo root surface`);
    assert.doesNotMatch(style, /linear-gradient|box-shadow|#2F7FE8|#4D7FD1|#5A7FAF|#75A7EA/i);
    assertUsesOnlyBobboHexColors(style, file);
  }
});

test("login and profile setup keep auth behavior in the quiet Bobbo visual system", () => {
  const login = readWorkspaceFile("pages/login/index.vue");
  const setup = readWorkspaceFile("pages/login/profile-setup.vue");
  for (const [file, source] of [["pages/login/index.vue", login], ["pages/login/profile-setup.vue", setup]]) {
    const style = extractStyleBlock(source, file);
    assert.match(style, /background:\s*#FBFBFA/i);
    assert.doesNotMatch(style, /linear-gradient|box-shadow|#2F7FE8|#4D7FD1|#5A7594|#EDF4FE/i);
    assertUsesOnlyBobboHexColors(style, file);
  }
  assert.match(login, /@click="wxLogin"/);
  assert.match(login, /wx\.login/);
  assert.doesNotMatch(login, /wx\.cloud\.callFunction/);
  assert.match(login, /finishLoginNavigation/);
  assert.match(setup, /open-type="chooseAvatar"/);
  assert.match(setup, /@chooseavatar="onChooseAvatar"/);
  assert.match(setup, /type="nickname"/);
  assert.match(setup, /@click="finish"/);
  assert.match(setup, /@click="skip"/);
});

test("secondary page scripts retain implemented setup and submission behavior", () => {
  const addDevice = readWorkspaceFile("pages/bind/addDevice.vue");
  const repairing = readWorkspaceFile("pages/bind/repairing.vue");
  const bluetooth = readWorkspaceFile("pages/bind/bluetooth.vue");
  const qrcode = readWorkspaceFile("pages/bind/qrcode.vue");
  const feedback = readWorkspaceFile("pages/profile/feedback.vue");

  assert.match(addDevice, /bluetooth:\s*['"]\/pages\/bind\/bluetooth['"]/);
  assert.match(addDevice, /qrcode:\s*['"]\/pages\/bind\/qrcode['"]/);
  assert.match(addDevice, /manual:\s*['"]\/pages\/bind\/repairing\?type=manual['"]/);
  assert.match(repairing, /callBackend\(['"]\/api\/devices['"]/);
  assert.match(repairing, /@click="bindDevice"/);
  assert.match(bluetooth, /startDevicesDiscovery/);
  assert.match(bluetooth, /bindConnectBluetooth/);
  assert.match(bluetooth, /bindManualDevice/);
  assert.match(qrcode, /uQRCode\.make/);
  assert.match(qrcode, /getQrcodeResult/);
  assert.match(qrcode, /@click="regenerate"/);
  assert.match(feedback, /callDemoData\(['"]submitFeedback['"]/);
  assert.match(feedback, /@click="submit"/);
});

test("bobbo primary pages use flat neutral surfaces", () => {
  const pageRules = [
    ["pages/today/index.vue", ".today-page"],
    ["pages/live/overview.vue", ".live-overview-page"],
    ["pages/clips/index.vue", ".page"],
    ["pages/profile/index.vue", ".profile-page"],
  ];

  for (const [file, selector] of pageRules) {
    const style = extractStyleBlock(readWorkspaceFile(file), file);
    const rules = extractCssRules(style, selector, file);
    assertUniqueExactDeclaration(rules, "background", ["#FBFBFA"], `${file} must use the Bobbo neutral surface`);
    assertUniqueExactDeclaration(rules, "color", ["#141414"], `${file} must use the Bobbo ink color`);
    assert.doesNotMatch(style, /box-shadow|linear-gradient/i, `${file} must stay flat and must not retain gradients`);
    assertUsesOnlyBobboHexColors(style, file);
  }
});

test("notification and profile pages expose continuous WxPusher WeChat delivery with a hardware upgrade path", () => {
  const notificationSource = readWorkspaceFile("pages/profile/notifications.vue");
  const profileSource = readWorkspaceFile("pages/profile/index.vue");

	assert.match(notificationSource, /WxPusher 微信提醒/);
	assert.doesNotMatch(notificationSource, /PushPlus 微信提醒|pushplus 推送加/);
	assert.match(notificationSource, /微信 ClawBot 直达/);
	assert.match(notificationSource, /我已在 App 绑定，发送测试/);
	assert.match(notificationSource, /只有你明确确认/);
	assert.match(notificationSource, /微信硬件消息仍在等待正式版资格/);
	assert.doesNotMatch(notificationSource, /测试提醒已发送|WxPusher 连续提醒/);
  assert.doesNotMatch(profileSource, /连接设置|goBackendLogin/);
});

test("primary navigation exposes only the four custom product destinations", () => {
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const tabBar = readWorkspaceFile("components/app-tab-bar/app-tab-bar.vue");
  const destinations = [
    "/pages/today/index",
    "/pages/live/overview",
    "/pages/clips/index",
    "/pages/profile/index",
  ];

  assert.equal(Object.hasOwn(pages, "tabBar"), false);
  assert.ok(destinations.every((destination) => tabBar.includes(`url: '${destination}'`)));
  assert.ok(destinations.every((destination, index) =>
    index === 0 || tabBar.indexOf(destinations[index - 1]) < tabBar.indexOf(destination)
  ));
  for (const legacyAsset of [
    "tab-today.png",
    "tab-today-active.png",
    "tab-clips.png",
    "tab-clips-active.png",
    "tab-profile.png",
    "tab-profile-active.png",
    "device.png",
    "device-active.png",
  ]) {
    assert.equal(
      fs.existsSync(path.join(__dirname, "..", "static", "images", legacyAsset)),
      false,
      `${legacyAsset} belongs to the removed native tab bar`
    );
  }
});

test("all four primary pages use only the shared custom bottom navigation", () => {
  for (const page of [
    "pages/today/index.vue",
    "pages/live/overview.vue",
    "pages/clips/index.vue",
    "pages/profile/index.vue",
  ]) {
    const source = readWorkspaceFile(page);
    assert.match(source, /<app-tab-bar/);
    assert.doesNotMatch(source, /uni\.(?:hideTabBar|showTabBar|switchTab)/);
  }

  const tabBar = readWorkspaceFile("components/app-tab-bar/app-tab-bar.vue");
  assert.match(tabBar, /今日/);
  assert.match(tabBar, /实时/);
  assert.match(tabBar, /吃播/);
  assert.match(tabBar, /我的/);
  assert.match(tabBar, /uni\.reLaunch/);
  assert.doesNotMatch(tabBar, /uni\.(?:hideTabBar|showTabBar|switchTab)/);
});

test("shared tab bar follows the improved home video foodcast and profile icon language", () => {
  const tabBar = readWorkspaceFile("components/app-tab-bar/app-tab-bar.vue");
  const icons = readWorkspaceFile("components/cat-icon/cat-icon.vue");

  assert.match(tabBar, /icon:\s*['"]home['"][^\n]*activeIcon:\s*['"]home-solid['"]/);
  assert.match(tabBar, /icon:\s*['"]video['"][^\n]*activeIcon:\s*['"]video-solid['"]/);
  assert.match(tabBar, /icon:\s*['"]foodcast['"][^\n]*activeIcon:\s*['"]foodcast-solid['"]/);
  assert.match(tabBar, /icon:\s*['"]profile['"][^\n]*activeIcon:\s*['"]profile-solid['"]/);
  assert.doesNotMatch(tabBar, /\.tab-item\.active\s*\{[^}]*background/);
  assert.match(icons, /['"]home-solid['"]:/);
  assert.match(icons, /\bvideo:/);
  assert.match(icons, /['"]video-solid['"]:/);
  assert.match(icons, /\bfoodcast:/);
  assert.match(icons, /['"]foodcast-solid['"]:/);
  assert.match(icons, /\bprofile:/);
  assert.match(icons, /['"]profile-solid['"]:/);
});

test("bobbo tab bar is edge-to-edge glass from the improved prototype", () => {
  const file = "components/app-tab-bar/app-tab-bar.vue";
  const style = extractStyleBlock(readWorkspaceFile(file), file);
  const shellRules = extractCssRules(style, ".tab-shell", file);
  const barRules = extractCssRules(style, ".tab-bar", file);
  const activeItemRules = extractCssRules(style, ".tab-item.active", file);
  const shellAndBarRules = [...shellRules, ...barRules];

  assertUniqueExactDeclaration(shellRules, "left", ["0"], `${file} .tab-shell must reach the left edge`);
  assertUniqueExactDeclaration(shellRules, "right", ["0"], `${file} .tab-shell must reach the right edge`);
  assertUniqueExactDeclaration(shellRules, "bottom", ["0"], `${file} .tab-shell must reach the bottom edge`);
  assertNoHorizontalBoxSpacing(shellRules, "padding", `${file} .tab-shell`);
  assertNoHorizontalBoxSpacing(shellAndBarRules, "margin", `${file} tab bar`);
  assertNoHorizontalBoxSpacing(shellAndBarRules, "inset", `${file} tab bar`);
  assertNoHorizontalLogicalSpacing(shellRules, "padding-inline", `${file} .tab-shell`);
  assertNoHorizontalLogicalSpacing(shellAndBarRules, "margin-inline", `${file} tab bar`);
  assertNoHorizontalLogicalSpacing(shellAndBarRules, "inset-inline", `${file} tab bar`);
  assertNoCssProperties(shellAndBarRules, ["width", "max-width", "transform", "translate"], `${file} tab bar`);
  assertNoCssProperties(barRules, ["left", "right"], `${file} .tab-bar`);
  assertUniqueExactDeclaration(shellRules, "background", ["rgba(251,251,250,.62)"], `${file} .tab-shell must use the approved translucent surface`);
  assertUniqueExactDeclaration(shellRules, "backdrop-filter", ["blur(22px) saturate(1.8)"], `${file} .tab-shell must use the approved glass treatment`);
  assertUniqueExactDeclaration(shellRules, "border-top", ["2rpx solid rgba(0,0,0,.06)"], `${file} .tab-shell must keep the approved hairline`);
  assertUniqueExactDeclaration(barRules, "background", ["transparent"], `${file} .tab-bar must reveal the glass surface`);
  assert.doesNotMatch(barRules.join("\n"), /border-radius/i, `${file} .tab-bar must not be a floating rounded card`);
  assertUniqueExactDeclaration(activeItemRules, "color", ["#141414"], `${file} active tab must use Bobbo ink`);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i, `${file} must stay free of shadows and gradients`);
  assertUsesOnlyBobboHexColors(style, file);
});

test("bobbo registers the five navigation routes", () => {
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const pagesByPath = new Map(pages.pages.map((page) => [page.path, page]));
  const requiredPaths = [
    "pages/today/detail",
    "pages/profile/cats",
    "pages/profile/settings",
		"pages/profile/device-storage",
    "pages/device/detail",
    "pages/profile/foodcast-preferences",
    "pages/profile/share-device",
  ];

  for (const pagePath of requiredPaths) {
    const page = pagesByPath.get(pagePath);
    assert.ok(page, `pages.json must register ${pagePath}`);
    assert.equal(page.style && page.style.navigationStyle, "custom", `${pagePath} must use custom navigation`);
  }
});

test("all four primary pages reserve the measured status bar safe area", () => {
  for (const page of [
    "pages/today/index.vue",
    "pages/live/overview.vue",
    "pages/clips/index.vue",
    "pages/profile/index.vue",
  ]) {
    const source = readWorkspaceFile(page);
    assert.match(source, /statusBarHeight/, `${page} should keep the measured top inset`);
    assert.match(source, /getWindowInfo/, `${page} should measure the host status bar without deprecated APIs`);
    assert.match(source, /paddingTop/, `${page} should apply the measured top inset`);
  }
});

test("primary header actions stay clear of the WeChat menu capsule", () => {
  for (const page of ["pages/today/index.vue", "pages/clips/index.vue"]) {
    const source = readWorkspaceFile(page);
    assert.match(source, /headerRightInset/);
    assert.match(source, /getMenuButtonBoundingClientRect/);
    assert.match(source, /paddingRight/);
  }
});

test("today page presents real feeding metrics without a demo health score", () => {
  const source = readWorkspaceFile("pages/today/index.vue");

  assert.match(source, /selected-pet-header/);
  assert.match(source, /score-summary/);
  assert.doesNotMatch(source, /health-score-card/);
  assert.match(source, /class="page-title"[\s\S]*class="page-title-line">今天吃得<[\s\S]*class="page-title-line">怎么样</);
  assert.doesNotMatch(source, /今天吃得\\n怎么样/);
  assert.doesNotMatch(source, /score:\s*82|展示占位/);
  assert.match(source, /baseline_building|基线建立中/);
  assert.match(source, /actualEatingSeconds/);
  assert.match(source, /todayEatCount/);
  assert.match(source, /eatMinutes/);
  assert.match(source, /activity-chart/);
  assert.match(source, /foodcast-entry/);
  assert.match(source, /class="empty-foodcast-icon"[^>]*><cat-icon name="foodcast"/);
  assert.doesNotMatch(source, /class="empty-foodcast-icon"[^>]*><cat-icon name="film"/);
  assert.match(source, /feeding-activity-curve\.svg/);
  assert.doesNotMatch(source, /class="chart-bars"|class="chart-bar"/);
});

test("today page loops through cat profiles independently from device state", () => {
  const source = readWorkspaceFile("pages/today/index.vue");

  assert.match(source, /activeDeviceSn/);
  assert.match(source, /activeDevice\(\)/);
  assert.match(source, /activeCatDashboard\s*\?\s*\[activeCatDashboard\]/);
  assert.match(source, /catProfiles/);
  assert.match(source, /activeCatId/);
  assert.match(source, /activeCat\(\)/);
  assert.match(source, /activeCatIndex\(\)/);
  assert.match(source, /activeCatDashboard\(\)/);
  assert.match(source, /catIdentityPlaceholder/);
  assert.match(source, /摄像头统计，暂未区分猫咪/);
  assert.match(source, /暂未关联摄像头/);
  assert.match(source, /class="pet-switcher"[\s\S]*circular/);
  assert.match(source, /<swiper-item\s+v-for="cat in catProfiles"/);
  assert.match(source, /@change="onCatSwipe"/);
  assert.match(source, /onCatSwipe/);
  assert.match(source, /lastViewedCatId/);
  assert.match(source, /readCatProfiles/);
  assert.match(source, /resolveActiveCat/);
  assert.match(source, /loadCatProfiles/);
  assert.match(source, /this\.loadCatProfiles\(\)/);
  assert.match(source, /removeStorageSync\('lastViewedCatId'\)/);
  assert.doesNotMatch(source, /id:\s*['"]tuanzi['"]/);
  assert.doesNotMatch(source, /activeCatId:\s*['"]guagua['"]/);
  assert.match(source, /Promise\.allSettled\(this\.deviceCards\.map/);
  assert.doesNotMatch(source, /page-eyebrow|bell-btn|refresh-btn/);
  assert.doesNotMatch(source, /handlePetHeader|onDeviceSwipe|cycleDevice/);
  assert.ok(source.indexOf('class="pet-switcher"') < source.indexOf('class="page-header"'));
});

test("bobbo live detail defaults to alerts, keeps replay inline, and includes fullscreen controls", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const template = source.match(/<template>([\s\S]*?)<\/template>/);
  const style = extractStyleBlock(source, "pages/live/index.vue");

  assert.ok(template, "live page should include a template");
  assert.match(template[1], /@click="showAlertPanel"/);
  assert.match(template[1], /@click="handleReplayAction"/);
  assert.match(source, /handleReplayAction\(\)[\s\S]*returnToLive\(\)[\s\S]*showReplayPanel\(\)/);
  assert.match(template[1], /class="action-label">移动警报</);
  assert.match(template[1], /viewerMode === 'replay' \? '返回实时' : '回放'/);
  assert.doesNotMatch(template[1], /抓拍|云台|展开|showPTZ|ptz-popup|quality-btn|status-panel|connection-panel/i);
  assert.equal((template[1].match(/class="action-btn"/g) || []).length, 2);
  assert.match(template[1], /:id="videoPlayerId"/);
  assert.match(template[1], /:data-player-generation="videoPlayerGeneration"/);
  assert.match(template[1], /@fullscreenchange="onFullscreenChange"/);
  assert.match(template[1], /@waiting="onVideoWaiting"/);
  assert.match(template[1], /@timeupdate="onVideoTimeUpdate"/);
  assert.doesNotMatch(template[1], /class="landscape-buffering"|class="landscape-spinner"|正在缓冲/);
  assert.doesNotMatch(style, /\.landscape-buffering|\.landscape-spinner/);
  assert.match(template[1], /:controls="!isAnyCustomFullscreen"/);
  assert.match(template[1], /:show-play-btn="!isAnyCustomFullscreen"/);
  assert.match(template[1], /:show-center-play-btn="!isAnyCustomFullscreen"/);
  assert.match(template[1], /show-fullscreen-btn="viewerMode === 'live'/);
  assert.match(template[1], /v-show="isLandscapeFullscreen"/);
  assert.doesNotMatch(template[1], /v-if="isLandscapeFullscreen"/);
  assert.doesNotMatch(template[1], /class="camera-top"/);
  assert.match(template[1], />声音</);
  assert.match(template[1], />截图</);
  assert.match(template[1], /@tap="toggleLiveRecording"/);
  assert.match(template[1], /\{\{\s*recordingControlLabel\s*\}\}/);
  assert.match(template[1], />通话</);
  assert.doesNotMatch(template[1], />保存</);
  assert.match(source, /createLiveMediaControl/);
  assert.match(source, /openMicrophoneSettings/);
  assert.match(source, /MICROPHONE_PERMISSION_DENIED/);
  assert.doesNotMatch(source, /fullScreen\s*\?\s*['"]horizontal['"]/);
  assert.match(source, /isRecordingActive/);
  assert.match(source, /toggleLiveRecording/);
  assert.match(source, /captureLiveImage/);
  assert.match(source, /saveRemoteImage/);
  assert.doesNotMatch(source, /\/live-snapshot/);
  assert.match(source, /saveRemoteVideo/);
  assert.match(source, /teardownLiveMedia/);
  assert.match(style, /\.live-page\s*\{[^}]*background:\s*#FBFBFA/i);
  assert.match(style, /\.video-area\s*\{[^}]*width:\s*100%[^}]*background:\s*#000000/i);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i);
  assert.match(style, /\.landscape-controls\s*\{/);
  assert.match(style, /\.landscape-controls\s*\{[^}]*top:\s*0[^}]*right:\s*0[^}]*bottom:\s*0[^}]*left:\s*0/i);
  assert.doesNotMatch(style, /\.landscape-controls\s*\{[^}]*\binset\s*:/i);
  assert.doesNotMatch(style, /\.landscape-(?:top-left|top-right|sound-control|center-controls)\s*\{[^}]*(?:max\(|clamp\(|env\()/i);
  assert.match(source, /\[live\] media control failed/);
  assert.match(source, /\[live\] fullscreen change/);
  assert.match(source, /\[live\] landscape controls layout/);
  assert.match(source, /\[live\] video waiting/);
  assert.doesNotMatch(source, /scheduleVideoStallRecovery|videoStallTimer|\[live\] stalled video reload/);
  const waitingHandler = source.match(/onVideoWaiting\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tonVideoTimeUpdate/);
  assert.ok(waitingHandler, "live page should keep a waiting handler for diagnostics");
  assert.doesNotMatch(waitingHandler[1], /closeCurrentStream|runPlaybackFlow|requestLiveUrl/);
  assert.match(waitingHandler[1], /\[live\] video waiting/);
  assert.match(source, /onVideoTimeUpdate\(event\)[\s\S]*lastVideoProgressAt\s*=\s*Date\.now\(\)/);
  const dataBlock = source.match(/data\(\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/);
  assert.ok(dataBlock, "live page should expose a data block");
  assert.doesNotMatch(dataBlock[1], /liveMediaControl|liveMediaConnectPromise/);
  assert.match(source, /Object\.defineProperty\(this,\s*'liveMediaControl'/);
  assert.match(source, /Object\.defineProperty\(this,\s*'liveMediaConnectPromise'/);
  assert.match(source, /onShow\(\)\s*\{[\s\S]*?this\.refreshDeviceMetadata\(\)/);
  assert.match(source, /refreshDeviceMetadata\(\)[\s\S]*?callBackend\('\/api\/devices'\)[\s\S]*?upsertOwnedDevice/);
  assert.match(style, /\.landscape-round-button\s*\{[^}]*width:\s*40px[^}]*height:\s*40px/i);
  assert.match(style, /\.record-button/);
  assert.match(style, /\.record-dot/);
  assert.match(source, /isRecordingActive\(\)/);
  assert.match(source, /isTalkActive\(\)\s*\{\s*return\s*\['starting',\s*'talking'\]\.includes/);
  assert.match(style, /\.camera-glyph::before/);
  assertUsesOnlyBobboHexColors(style, "pages/live/index.vue");
});

test("native live-player experiment is absent from the shipped mini program", () => {
  const liveSource = readWorkspaceFile("pages/live/index.vue");
  const pages = JSON.parse(readWorkspaceFile("pages.json"));

  assert.equal(pages.pages.some((page) => page.path === "pages/live/native-player"), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../pages/live/native-player.vue")), false);
  assert.doesNotMatch(liveSource, /shouldExposeLivePlayerExperiment|showLivePlayerExperiment|goLivePlayerExperiment/);
  assert.doesNotMatch(liveSource, /试用微信原生直播组件|\/pages\/live\/native-player/);
});

test("bobbo replay uses neutral chrome around a dark media stage", () => {
  const file = "pages/live/replay.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);

  assert.match(style, /\.replay-page\s*\{[^}]*background:\s*#FBFBFA/i);
  assert.match(style, /\.video-area\s*\{[^}]*background:\s*#000000/i);
  assert.match(source, /activeColor="#2FA35C"/);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i);
  assertUsesOnlyBobboHexColors(style, file);
});

test("pages/today/index.vue keeps a readable minimal cat header", () => {
  const source = readWorkspaceFile("pages/today/index.vue");
  const template = source.match(/<template>([\s\S]*?)<\/template>/);

  assert.ok(template, "today page should include a template");
  assert.match(template[1], /class="pet-switcher"/);
  assert.match(template[1], /class="pet-name"/);
  assert.doesNotMatch(template[1], /pet-switch-hint|点击切换猫咪/);
  assert.match(template[1], /class="cat-dots"/);
  assert.match(template[1], /@click\.stop="advanceCat"/);
  assert.doesNotMatch(template[1], /pet-switch-button/);
  assert.doesNotMatch(template[1], /pet-switch-arrow/);
});

test("live overview uses real device cards and keeps shortcuts honest", () => {
  const source = readWorkspaceFile("pages/live/overview.vue");

  assert.match(source, /buildOwnedDeviceCards/);
  assert.match(source, /\/api\/devices/);
  assert.match(source, /getDeviceCovers/);
  assert.match(source, /coversBySn/);
  assert.doesNotMatch(source, /live-thumb\.svg/);
  assert.match(source, /goNotifications/);
  assert.match(source, /goDeviceList/);
  assert.doesNotMatch(source, /OPMachine/);
  assert.doesNotMatch(source, /hero-status|deviceStatusDescription|正在确认设备状态，也可以直接进入实时画面/);
});

test("bobbo live overview is a flat full-width device band with compact controls", () => {
  const file = "pages/live/overview.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);
  const heroRules = extractCssRules(style, ".recent-device-hero", file);

  assert.match(source, /class="page-title">实时</);
  assert.match(source, /class="online-summary"/);
  assert.match(source, /paddingRight:\s*headerRightInset\s*\+\s*['"]px['"]/);
  assert.match(source, /getSystemInfoSync/);
  assert.match(source, /getMenuButtonBoundingClientRect/);
  assert.match(source, /windowWidth\s*-\s*menuLeft\s*\+\s*8/);
  assert.match(source, /class="live-badge"/);
  assert.match(source, /class="quality-badge"/);
  assert.match(source, /class="hero-action"/);
  assert.match(source, /class="device-row"/);
  assert.match(source, /class="quick-pills"/);
  assert.equal(readCssDeclarations(heroRules, "border-radius").length, 0);
  assert.match(style, /\.recent-device-hero\s*\{[^}]*width:\s*100%[^}]*height:\s*574rpx/i);
  assert.match(style, /\.quick-pills\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/i);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i);
  assert.doesNotMatch(source, /more-device-card|device-scroll|quick-grid/);
  assertUsesOnlyBobboHexColors(style, file);
});

test("device management keeps its behavior", () => {
  const source = readWorkspaceFile("pages/device/index.vue");

  assert.match(source, /fetchOwnedDevicesFromBackend/);
  assert.match(source, /refreshDeviceStatuses/);
  assert.match(source, /showActionSheet/);
  assert.match(source, /factoryResetDevice/);
  assert.match(source, /unbindDevice/);
  assert.match(source, /callSdkWithToken\(['"]unbindDevice['"]/);
  assert.match(source, /method:\s*['"]DELETE['"]/);
  assert.match(source, /goAddDevice/);
});

test("bobbo device management features the first real device and keeps controls separate", () => {
  const file = "pages/device/index.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const route = pages.pages.find((item) => item.path === "pages/device/index");

  assert.equal(route.style.navigationStyle, "custom");
  assert.match(source, /bobbo-nav-bar[^>]*:title="navTitle"/);
  assert.doesNotMatch(source, /slot="right"|nav-add-button|nav-add-icon/);
  assert.match(source, /devices\.length[\s\S]*?台/);
  assert.match(source, /class="featured-device"[\s\S]*?devices\[0\]/);
  assert.match(source, /class="compact-device"[\s\S]*?additionalDevices/);
  const tapDeviceBody = source.match(/tapDevice\(item\)\s*\{([\s\S]*?)showActionSheet/);
  assert.ok(tapDeviceBody, "device management must keep a dedicated detail navigation method");
  assert.match(tapDeviceBody[1], /setStorageSync\(DEVICE_DETAIL_PREVIEW_KEY/);
  assert.match(tapDeviceBody[1], /\/pages\/device\/detail\?sn=/);
  assert.doesNotMatch(tapDeviceBody[1], /token|username|password|credential/i);
  assert.doesNotMatch(tapDeviceBody[1], /\?device=/);
  assert.match(source, /@click\.stop="showActionSheet/);
  assert.match(source, /@longpress="showActionSheet/);
  assert.match(source, /itemList:\s*\['修改设备名称',\s*'恢复出厂设置',\s*'解绑设备'\]/);
  assert.doesNotMatch(source, /修改本地名称|已更新本地名称/);
  const renameBody = source.match(/async saveDeviceNickname\(item, idx, nickname\)\s*\{([\s\S]*?)\r?\n\s*\},\r?\n\s*confirmFactoryReset/);
  assert.ok(renameBody, "device management must persist nickname changes through the backend");
  assert.match(renameBody[1], /callBackend\('\/api\/devices\/'/);
  assert.match(renameBody[1], /encodeURIComponent\(item\.sn\) \+ '\/nickname'/);
  assert.match(renameBody[1], /method:\s*'PUT'/);
  assert.match(renameBody[1], /syncSource:\s*'device-manager'/);
  assert.match(renameBody[1], /replaceOwnedDevices\(this\.devices, uni\)/);
  assert.match(renameBody[1], /名称保存失败/);
  assert.match(source, /class="add-device-row"[\s\S]*?goAddDevice/);
  assert.match(style, /\.featured-device\s*\{[^}]*border:\s*2rpx solid #EDEDEB[^}]*border-radius:\s*36rpx/i);
  assert.match(style, /\.featured-preview\s*\{[^}]*height:\s*224rpx/i);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i);
  assertUsesOnlyBobboHexColors(style, file);
});

test("bobbo device detail exposes real navigation and labels unavailable settings honestly", () => {
  const file = "pages/device/detail.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);

  assert.match(source, /bobbo-nav-bar[^>]*:title="deviceTitle"/);
  assert.match(source, /slot="right"[\s\S]*?detail-more-button/);
  assert.match(source, /onLoad\(options\)/);
  assert.match(source, /decodeURIComponent/);
  assert.match(source, /DEVICE_DETAIL_PREVIEW_KEY/);
  assert.match(source, /getStorageSync\(DEVICE_DETAIL_PREVIEW_KEY\)/);
  assert.match(source, /preview\.sn\s*!==\s*sn/);
  assert.match(source, /onShow\(\)\s*\{\s*this\.refreshDeviceMetadata\(\)/);
  assert.match(source, /refreshDeviceMetadata\(\)[\s\S]*?callBackend\('\/api\/devices'\)/);
  assert.match(source, /设备状态暂未载入/);
  assert.match(source, /class="detail-preview"/);
  assert.match(source, /查看实时/);
  assert.match(source, /\/pages\/live\/index\?device=/);
  const goLiveBody = source.match(/goLive\(\)\s*\{([\s\S]*?)\r?\n\s*\},\r?\n\s*goShare/);
  assert.ok(goLiveBody, "device detail must keep a dedicated live navigation method");
  assert.match(goLiveBody[1], /const liveDevice\s*=\s*\{[\s\S]*?sn:[\s\S]*?nickname:[\s\S]*?status:[\s\S]*?online:/);
  assert.doesNotMatch(goLiveBody[1], /coverUrl|location|token|username|password|credential/i);
  assert.match(source, /\/pages\/profile\/share-device/);
  assert.match(source, /名称/);
  assert.match(source, /位置/);
  assert.match(source, /画质/);
  assert.match(source, /存储/);
  assert.match(source, /固件/);
  assert.match(source, /通知/);
  assert.match(source, /共享/);
  assert.match(source, /暂未接入/);
  assert.match(source, /演示数据/);
  assert.match(source, /移除设备[\s\S]*?暂未接入/);
  assert.doesNotMatch(source, /removeDevice|deleteDevice|unbindDevice/);
  assert.doesNotMatch(style, /\.setting-list\s*\{[^}]*(?:background|border(?:-radius)?|padding)\s*:/i);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i);
  assertUsesOnlyBobboHexColors(style, file);
});

test("foodcast page reads automatic outputs and navigates to customization", () => {
  const file = "pages/clips/index.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);

  assert.match(source, /class="title">吃播/);
  assert.match(source, /class="custom"/);
  assert.match(source, /\/pages\/clips\/customize/);
  assert.match(source, /class="featured"/);
  assert.match(source, /class="meal-list"/);
  assert.match(source, /class="date"/);
  assert.match(source, /素材整理中/);
  assert.match(source, /callBackend\(['"]\/api\/foodcasts\/daily/);
  assert.match(source, /callBackend\(['"]\/api\/foodcasts\/materials/);
  assert.match(source, /loadFoodcastCatalogForDevices/);
  assert.match(source, /saveFoodcastVideo/);
  assert.match(source, /保存到相册/);
  assert.match(source, /@click\.stop="saveVideo\(heroMaterial\)"/);
  assert.match(source, /clips:all-devices:/);
  assert.doesNotMatch(source, /clips:\$\{this\.selectedDate\}:\$\{String\(uni\.getStorageSync\('lastViewedDeviceSn'/);
  assert.doesNotMatch(source, /customize-panel/);
  assert.doesNotMatch(source, /date-scroll|date-chip|featured-footer|timeline-actions|meal-action/);
  assert.doesNotMatch(source, /识别到猫咪进食后，会自动保存每顿片段并生成贴脸精选/);
  assert.doesNotMatch(source, /进食识别完成后，每一顿都会出现在这里/);
  assert.doesNotMatch(source, /class="empty-copy"/);
  assert.match(style, /\.featured\{[^}]*height:412rpx/is);
  assert.match(style, /\.meal-row\{[^}]*height:124rpx/is);
  assert.match(style, /\.meal-cover[^}]*width:152rpx[^}]*height:92rpx/is);
  assert.doesNotMatch(style, /linear-gradient|box-shadow/);
  assertUsesOnlyBobboHexColors(style, file);
});

test("foodcast customization follows the automatic material editor contract", () => {
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const route = pages.pages.find((item) => item.path === "pages/clips/customize");
  const source = readWorkspaceFile("pages/clips/customize.vue");
  const style = extractStyleBlock(source, "pages/clips/customize.vue");
  const clipsSource = readWorkspaceFile("pages/clips/index.vue");

  assert.ok(route);
  assert.equal(route.style.navigationStyle, "custom");
  assert.match(source, /快速自定义/);
  assert.match(source, /成片顺序/);
  assert.match(source, /拖动排序/);
  assert.match(source, /已选/);
  assert.match(source, /每顿视频/);
  assert.match(source, /精选片段/);
  assert.match(source, /音乐/);
  assert.match(source, /文字/);
  assert.match(source, /画面/);
  assert.match(source, /特效/);
  assert.match(source, /\/api\/foodcasts\/materials/);
  assert.match(source, /\/api\/foodcasts\/bgm/);
  assert.match(source, /\/api\/foodcasts\/custom/);
  assert.match(source, /beginDrag/);
  assert.match(source, /finishDrag/);
  assert.match(source, /bgmVolume/);
  assert.doesNotMatch(source, /不添加音乐|随机音乐|演示素材/);
  assert.doesNotMatch(style, /linear-gradient|box-shadow/);
  assertUsesOnlyBobboHexColors(style, "pages/clips/customize.vue");

  assert.match(clipsSource, /\/api\/foodcasts\/daily/);
  assert.match(clipsSource, /\/api\/foodcasts\/materials/);
  assert.doesNotMatch(clipsSource, /generateFoodcast\(['"]day['"]\)/);
});

test("profile page combines real account and device actions with shared cat profiles", () => {
  const source = readWorkspaceFile("pages/profile/index.vue");

  assert.match(source, /family-identity/);
  assert.match(source, /paddingRight:\s*headerRightInset \+ 'px'/);
  assert.match(source, /minHeight:\s*headerHeight \+ 'px'/);
  assert.match(source, /getSystemInfoSync/);
  assert.match(source, /getMenuButtonBoundingClientRect/);
  assert.doesNotMatch(source, /与 1 位成员共享/);
  assert.doesNotMatch(source, /与第 \{\{ coCreatorNo \}\} 位成员共享/);
  assert.match(source, /\bcats\b/);
  assert.doesNotMatch(source, /demoCats/);
  assert.match(source, /catProfiles\.js/);
  assert.match(source, /readCatProfiles/);
  assert.match(source, /goCatArchive/);
  assert.match(source, /\/pages\/profile\/cats/);
  assert.doesNotMatch(source, /演示数据|<text class="stat-value">12<\/text>/);
  assert.match(source, /foodcastCountDisplay/);
  assert.match(source, /callBackend\(['"]\/api\/foodcasts\/stats/);
  assert.match(source, /goFoodcast/);
  assert.match(source, /uni\.reLaunch\(\{\s*url:\s*['"]\/pages\/clips\/index\?library=1['"]/);
  assert.match(source, /goDeviceList/);
  assert.match(source, /goNotificationSettings/);
  assert.match(source, /foodcastPreferences/);
  assert.match(source, /shareDevice/);
  assert.match(source, /goSettings/);
  assert.match(source, /\/pages\/profile\/settings/);
  assert.match(source, /\/pages\/profile\/foodcast-preferences/);
  assert.match(source, /\/pages\/profile\/share-device/);
  assert.doesNotMatch(source, /placeholder-tag/);
  assert.doesNotMatch(source, /goFeedback/);
  assert.doesNotMatch(source, /family-meta|stat-note|setting-meta/);
  assert.doesNotMatch(source, /画面、时长与音乐|邀请家人共同查看|个人资料、家庭与应用设置/);
});

test("profile moves account settings into the same row list as the other account actions", () => {
  const source = readWorkspaceFile("pages/profile/index.vue");
  const style = extractStyleBlock(source, "pages/profile/index.vue");
  const icons = readWorkspaceFile("components/cat-icon/cat-icon.vue");

  assert.doesNotMatch(source, /class="settings-button"/);
  assert.match(source, /class="setting-row account-settings-row"[^>]*@click="goSettings"/);
  for (const icon of [
    "settings-devices",
    "settings-notifications",
    "settings-tune",
    "settings-share",
    "settings-account",
  ]) {
    assert.match(source, new RegExp(`name="${icon}"[^>]*color="#141414"`));
    assert.match(icons, new RegExp(`['"]${icon}['"]:`));
  }
  assert.equal((source.match(/name="chevron-right"/g) || []).length, 5);
  assert.match(style, /\.setting-icon-wrap\s*\{[^}]*flex:\s*0 0 44rpx[^}]*width:\s*44rpx[^}]*height:\s*44rpx/is);
  assert.match(style, /\.row-chevron\s*\{/);
  assert.doesNotMatch(source, /<cat-icon name="(?:camera|bell|film|share|profile)" :size="38"/);
  assert.doesNotMatch(source, /class="row-arrow"/);
  assert.match(source, /账号设置/);
  assert.doesNotMatch(source, /个人资料、家庭与应用设置/);
  assert.ok(
    source.indexOf("account-settings-row") > source.indexOf('@click="shareDevice"'),
    "account settings should be the final row in the profile action list",
  );
  assert.doesNotMatch(style, /\.settings-button\s*\{/);
});

test("account settings follows the prototype hierarchy while preserving real destinations", () => {
  const file = "pages/profile/settings.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);

  assert.match(source, /class="account-summary"/);
  assert.match(source, /class="account-avatar"/);
  assert.match(source, /familyName/);
  assert.match(source, /画面与录制/);
  assert.match(source, /基本设置/);
  assert.match(source, /存储管理/);
  assert.match(source, /录像设置/);
  assert.match(source, /吃播剪辑偏好/);
  assert.match(source, /提醒与识别/);
  assert.match(source, /智能提醒/);
  assert.match(source, /猫脸识别与档案/);
  assert.match(source, /网络设置/);
  assert.match(source, /helloiip/);
  assert.match(source, /仅 Wi-Fi 下上传/);
  assert.match(source, /蜂窝网络下暂存在设备/);
  assert.match(source, /class="wifi-upload-switch"/);
  assert.match(source, /bobbo_wifi_only_upload/);
  assert.match(source, /账号与设备/);
  assert.match(source, /设备管理/);
  assert.match(source, /3 台 · 2 在线/);
  assert.match(source, /成员共享/);
  assert.match(source, /2 人 · 权限相同/);
  assert.match(source, /高级设置/);
  assert.match(source, /画质 自动/);
  assert.match(source, /添加到桌面/);
  assert.match(source, /关于 bobbo/);
  assert.match(source, /v1\.4\.0 · 已是最新/);
  assert.match(source, /\/pages\/profile\/foodcast-preferences/);
  assert.match(source, /\/pages\/profile\/notifications/);
  assert.match(source, /\/pages\/profile\/cats/);
  assert.match(source, /\/pages\/profile\/share-device/);
  assert.match(source, /\/pages\/device\/index/);
	assert.match(source, /\/pages\/profile\/device-storage\?mode=picture/);
	assert.match(source, /\/pages\/profile\/device-storage\?mode=storage/);
	assert.match(source, /\/pages\/profile\/device-storage\?mode=recording/);
  assert.match(source, /showUnavailable/);
  const reminderIndex = source.indexOf("智能提醒");
  const catIndex = source.indexOf("猫脸识别与档案");
  const networkIndex = source.indexOf("网络设置");
  const wifiIndex = source.indexOf("仅 Wi-Fi 下上传");
  const accountSectionIndex = source.indexOf("账号与设备");
  const deviceIndex = source.indexOf("设备管理");
  const sharingIndex = source.indexOf('class="row-title">成员共享');
  const advancedIndex = source.indexOf("高级设置");
  const desktopIndex = source.indexOf("添加到桌面");
  const aboutIndex = source.indexOf("关于 bobbo");
  assert.ok(reminderIndex < catIndex && catIndex < networkIndex && networkIndex < wifiIndex);
  assert.ok(wifiIndex < accountSectionIndex && accountSectionIndex < deviceIndex);
  assert.ok(deviceIndex < sharingIndex && sharingIndex < advancedIndex && advancedIndex < desktopIndex && desktopIndex < aboutIndex);
  assert.match(style, /\.settings-content\s*\{[^}]*padding:\s*32rpx 48rpx/is);
  assert.match(style, /\.settings-row\s*\{[^}]*min-height:\s*112rpx/is);
  assert.doesNotMatch(style, /linear-gradient|box-shadow/i);
});

test("device storage and recording settings use real backend summaries", () => {
	const file = "pages/profile/device-storage.vue";
	const source = readWorkspaceFile(file);
	const pages = JSON.parse(readWorkspaceFile("pages.json"));
	const settings = readWorkspaceFile("pages/profile/settings.vue");
	const style = extractStyleBlock(source, file);

	assert.ok(pages.pages.some((page) => page.path === "pages/profile/device-storage"));
	assert.match(settings, /device-storage\?mode=picture/);
	assert.match(settings, /device-storage\?mode=storage/);
	assert.match(settings, /device-storage\?mode=recording/);
	assert.match(source, /settings-summary/);
	assert.match(source, /\/api\/app\/foreground-sync/);
	assert.match(source, /bobbo_device_settings_summary_/);
	assert.match(source, /本地存储/);
	assert.match(source, /持续录像/);
	assert.match(source, /警报截图/);
	assert.match(source, />编码</);
	assert.doesNotMatch(source, /暂未接入|演示数据/);
	assertUsesOnlyBobboHexColors(style, file);
});

test("device management uses the prototype spacing and a flat honest empty state", () => {
  const file = "pages/device/index.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);

  assert.match(source, /class="empty-state"[^>]*v-else-if="!isLoading"/);
  assert.match(source, /还没有设备/);
  assert.match(source, /添加摄像头后，即可在这里查看设备状态/);
  assert.match(source, /class="add-device-row"[^>]*@click="goAddDevice"/);
  assert.match(source, /扫码或输入编号，也可接受分享/);
  assert.match(source, /设备只会出现在已授权的家庭账号中/);
  assert.match(style, /\.device-content\s*\{[^}]*padding:\s*32rpx 48rpx 0/is);
  assert.match(style, /\.empty-state,\s*\.loading-state\s*\{[^}]*margin:\s*32rpx 48rpx 0/is);
  assert.doesNotMatch(style, /\.empty-state,\s*\.loading-state\s*\{[^}]*border:/is);
  assert.match(style, /\.add-device-row\s*\{[^}]*margin:\s*0 48rpx/is);
  assert.match(style, /\.add-device-row\s*\{[^}]*border-top:\s*2rpx solid #E8E8E5/is);
  assert.doesNotMatch(style, /linear-gradient|box-shadow/i);
});

test("cat archive syncs family profiles with avatar upload and read-only member controls", () => {
  const file = "pages/profile/cats.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);
  const pageRules = extractCssRules(style, ".cats-page", file);

  assert.match(source, /bobbo-nav-bar title="猫咪档案"/);
  assert.match(source, /catProfiles\.js/);
  assert.match(source, /readCatProfiles/);
  assert.match(source, /refreshCatProfiles/);
  assert.match(source, /添加猫咪/);
  assert.match(source, /openEditor/);
  assert.match(source, /saveCat/);
  assert.match(source, /猫咪照片/);
  assert.match(source, /uni\.chooseImage/);
  assert.match(source, /uploadCatAvatar/);
	assert.match(source, /\/api\/cats\//);
	assert.match(source, /primary-cat/);
	assert.match(source, /:data-profile-key="catKey\(cat\)"/);
	assert.match(source, /class="cat-card" @click="openExistingCat"/);
	assert.match(source, /<view class="add-row" @click="openNewCat"/);
	assert.match(source, /event\.currentTarget\.dataset\.profileKey/);
	assert.match(source, /findCatProfileByKey/);
	assert.doesNotMatch(source, /@click="openEditor\(cat\)"/);
	assert.match(source, /自己的档案可编辑，共享档案由设备主人维护/);
	assert.match(source, /v-if="editingTarget && !editorReadOnly"/);
	assert.match(source, /createCatEditorTarget/);
	assert.match(source, /const existing = this\.editingTarget \? this\.editingTarget\.profile : null/);
	assert.match(source, /catProfileKey\(item\) !== target\.key/);
	assert.doesNotMatch(source, /this\.cats\.find\(\(cat\) => \(cat\.catRef \|\| cat\.id\) === this\.editingId\)/);
	assert.match(source, /source === 'shared'/);
  assert.match(source, /draft\.avatar \|\| defaultAvatar/);
  assert.match(source, /请上传猫咪照片/);
  assert.match(source, /疾病 \/ 健康情况/);
  assert.match(source, /birthdayPickerValue/);
  assert.match(source, /mode="date"/);
  assert.match(source, /formatCatAge/);
  assert.match(source, /sexOptions/);
  assert.match(source, /mode="selector"/);
  assert.match(source, /onPickerChange/);
  assert.doesNotMatch(source, /v-model="draft\.age"/);
  assert.match(source, /v-model="draft\.breed"/);
  assert.doesNotMatch(source, /v-model="draft\.sex"/);
  assert.match(source, /confirmDeleteCat/);
  assert.match(source, /uni\.showModal/);
  assert.match(source, /removeUnusedAvatar/);
  assert.doesNotMatch(source, /<label class="field-label">备注<\/label>/);
  assert.doesNotMatch(source, /class="nav-add"/);
  assert.doesNotMatch(source, /class="local-note"/);
  assert.match(source, /writeCatProfiles/);
  assertUniqueExactDeclaration(pageRules, "background", ["#FBFBFA"], `${file} must use the Bobbo neutral surface`);
  assertUniqueExactDeclaration(pageRules, "color", ["#141414"], `${file} must use the Bobbo ink color`);
  assert.doesNotMatch(style, /box-shadow|linear-gradient/i);
  assertUsesOnlyBobboHexColors(style, file);
});

test("profile keeps legacy default avatar migration behavior", () => {
  const source = readWorkspaceFile("pages/profile/index.vue");

  assert.match(source, /DEFAULT_CAT_AVATAR/);
  assert.match(source, /readCatProfiles/);
  assert.match(source, /LEGACY_DEFAULT_AVATARS/);
});

test("foodcast page is registered and implements asynchronous generation, recovery, preview, and saving", () => {
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const paths = pages.pages.map((item) => item.path);
  const source = readWorkspaceFile("pages/clips/foodcast.vue");

  assert.ok(paths.includes("pages/clips/foodcast"));
  assert.match(source, /<video/);
  assert.match(source, /\/api\/foodcasts\/latest/);
  assert.match(source, /callBackend\(['"]\/api\/foodcasts['"]/);
  assert.match(source, /\/api\/foodcasts\/['"]?\s*\+\s*this\.job\.id/);
  assert.match(source, /setInterval\([\s\S]*2000/);
  assert.match(source, /saveFoodcastVideo/);
  assert.match(source, /object-fit="contain"/);
  assert.match(source, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.doesNotMatch(source, /(?:1080\s*×\s*1920|1920\s*×\s*1080)/);
  assert.doesNotMatch(source, /class="foodcast-video"[\s\S]{0,200}object-fit="cover"/);
  assert.match(source, /重新生成/);
  assert.match(source, /保存到相册/);
  assert.match(source, /自然吃播/);
  assert.match(source, /萌点快剪/);
  assert.match(source, /mode:\s*this\.mode/);
  assert.match(source, /frameMode:\s*this\.frameMode/);
  assert.match(source, /:class="\{square:\s*frameMode\s*===\s*'center_crop'\}"/);
  assert.match(source, /保留原画/);
  assert.match(source, /中心方形/);
  assert.match(source, /quick_cut/);
});

test("foodcast job page uses flat Bobbo navigation, stages, and controls", () => {
  const file = "pages/clips/foodcast.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);

  assert.match(source, /bobbo-nav-bar/);
  assert.match(source, /status-view/);
  assert.match(source, /video-shell/);
  assert.match(source, /mode-switch/);
  assert.match(source, /frame-switch/);
  assert.doesNotMatch(source, /page-nav|back-button|nav-spacer/);
  assert.doesNotMatch(style, /linear-gradient|box-shadow/);
  assertUsesOnlyBobboHexColors(style, file);
});

test("mini program defaults new foodcasts to quick cut while keeping natural mode selectable", () => {
  const clipsSource = readWorkspaceFile("pages/clips/index.vue");
  const foodcastSource = readWorkspaceFile("pages/clips/foodcast.vue");

  assert.match(foodcastSource, /mode:\s*'quick_cut'/);
  assert.match(
    foodcastSource,
    /this\.mode\s*=\s*options\.mode\s*===\s*'natural'\s*\?\s*'natural'\s*:\s*'quick_cut'/
  );
  assert.match(foodcastSource, /selectMode\(['"]natural['"]\)/);
  assert.match(foodcastSource, /mode:\s*this\.mode/);
});

test("clips page reads automatic day and meal outputs instead of starting generation", () => {
  const source = readWorkspaceFile("pages/clips/index.vue");

  assert.match(source, /\/api\/foodcasts\/daily/);
  assert.match(source, /\/api\/foodcasts\/materials/);
  assert.match(source, /class="player"[\s\S]*:src="playingUrl"/);
  assert.doesNotMatch(source, /generateFoodcast|generateMealFoodcast|buildFoodcast/);
});

test("pages/device/index.vue keeps factory reset available before re-pairing", () => {
  const source = readWorkspaceFile("pages/device/index.vue");
  const resetStart = source.indexOf("async factoryResetDevice(item) {");
  const resetEnd = source.indexOf("goAddDevice() {", resetStart);
  const resetBody = source.slice(resetStart, resetEnd);

  assert.match(source, /恢复出厂设置/);
  assert.match(source, /OPDefaultConfig/);
  assert.match(source, /factoryResetDevice/);
  assert.match(source, /async resolveDeviceToken\(item\)/);
  assert.match(resetBody, /await this\.resolveDeviceToken\(item\)/);
  assert.match(resetBody, /callSdkWithToken\(['"]opdev['"],\s*this\.buildFactoryResetPayload\(\),\s*token\)/);
  assert.doesNotMatch(resetBody, /if \(!item\.token\)/);
});

test("pages/profile/index.vue links to the dedicated feeding notification settings page", () => {
  const source = readWorkspaceFile("pages/profile/index.vue");

  assert.match(source, /通知设置/);
  assert.match(source, /feedingDetectionEnabled/);
  assert.match(source, /goNotificationSettings/);
  assert.match(source, /\/pages\/profile\/notifications/);
  assert.match(source, /callBackend\(['"]\/api\/feed-analysis\/status['"]\)/);
  assert.match(source, /notificationProvider/);
  assert.match(source, /pushPlusConfigured/);
  assert.doesNotMatch(source, /<switch[^>]+toggleFeedingDetection/);
});

test("pages/profile/notifications.vue provides one-time WxPusher binding, delivery receipts, and per-device switches", () => {
  const source = readWorkspaceFile("pages/profile/notifications.vue");

  assert.match(source, /连续进食提醒/);
  assert.match(source, /<switch/);
  assert.match(source, /v-for="device in devices"/);
  assert.match(source, /家人分享给我的设备/);
	assert.match(source, /requestSubscribeDeviceMessage/);
	assert.match(source, /wechat-device-subscription-ticket/);
	assert.match(source, /wechat-device-subscription\/test/);
	assert.match(source, /notifications\/subscription-result/);
	assert.match(source, /开启长期提醒/);
	assert.match(source, /wxpusher-binding-challenge/);
	assert.match(source, /\/api\/notifications\/wxpusher-binding/);
	assert.doesNotMatch(source, /pushplus-binding-challenge/);
	assert.match(source, /deliveryReady/);
	assert.match(source, /\/api\/notifications\/deliveries\//);
	assert.match(source, /waitForNotificationDelivery/);
	assert.match(source, /微信已送达/);
	assert.match(source, /notifications\/test/);
	assert.match(source, /wxpusher-clawbot/);
	assert.match(source, /clawbot-qrcode-canvas/);
	assert.match(source, /:style="clawBotQrCanvasStyle"/);
	assert.match(source, /CLAWBOT_QR_SIZE_PX/);
	assert.match(source, /CLAWBOT_QR_MARGIN_PX/);
	assert.match(source, /previewClawBotQr/);
	assert.match(source, /previewWxPusherBindingQr/);
	assert.match(source, /previewQrForRecognition/);
	assert.match(source, /点开二维码直接识别/);
	assert.match(source, /识别图中二维码/);
	assert.match(source, /无需保存图片/);
	assert.doesNotMatch(source, /copyClawBotActivationUrl/);
	assert.match(source, /WxPusher App 内绑定/);
	assert.match(source, /我的 → 推送渠道/);
	assert.match(source, /copyClawBotAppUrl/);
	assert.match(source, /暂不支持浏览/);
	assert.match(source, /无法绕过微信资格限制/);
	assert.doesNotMatch(source, /第二个动态二维码/);
	assert.match(source, /clawbot-qr/);
	assert.match(source, /我收到了/);
	assert.match(source, /未确认，不会标记为微信直达/);
	assert.doesNotMatch(source, /hidden-canvas[^}]*220rpx/);
	assert.doesNotMatch(source, /\/api\/need-login\/device\/ilink|openId.*WxPusher|wxpusher.*session/i);
	assert.match(source, /persistentEnabled/);
	assert.match(source, /小程序内显示移动记录/);
	assert.match(source, /只控制小程序内是否显示；摄像头侦测与进食分析始终开启/);
	assert.match(source, /motionAlerts/);
	assert.match(source, /motion-alerts\/preference/);
	assert.match(source, /侦测与进食分析始终开启/);
	assert.match(source, /临时领取下一次提醒/);
	assert.match(source, /callBackend\(['"]\/api\/devices['"]\)/);
  assert.match(source, /\/notifications['"]/);
	assert.doesNotMatch(source, /pushplus-binding-challenge|requirePushPlusBinding/);
  assert.doesNotMatch(source, /getOpenid\(\)/);
  assert.doesNotMatch(source, /callDemoData\(['"]saveNotificationSetting['"]/);
});

test("Bobbo notification settings use a neutral per-device hierarchy", () => {
  const file = "pages/profile/notifications.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);
	const pages = JSON.parse(readWorkspaceFile("pages.json"));
	const route = pages.pages.find((page) => page.path === "pages/profile/notifications");

  assert.match(source, /<bobbo-nav-bar[^>]*title="通知设置"/);
	assert.equal(route && route.style && route.style.navigationStyle, "custom");
  assert.match(source, /每台摄像头，只需开启一次/);
  assert.match(source, /class="device-card"/);
  assert.match(source, /class="quota-row"/);
  assert.match(source, /<switch[^>]*color="#141414"/);
  assert.match(source, /为什么不需要每次领取/);
  assert.match(source, /临时领取下一次提醒/);
  assert.match(style, /\.notification-page\s*\{[^}]*background:\s*#FBFBFA/is);
  assert.match(style, /\.state-card, \.review-card, \.device-card, \.explain-card\s*\{[^}]*background:\s*#FFFFFF/is);
  assert.match(source, /开始进食/);
  assert.match(source, /结束进食/);
  assert.doesNotMatch(source, /连续异常|设备离线/);
  assert.doesNotMatch(style, /linear-gradient|box-shadow|#2F7FE8|#4D7FD1/i);
  assertUsesOnlyBobboHexColors(style, file);
});

test("Bobbo foodcast preferences expose edit modes and flexible duration with a left-aligned title", () => {
  const file = "pages/profile/foodcast-preferences.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);
  const navSource = readWorkspaceFile("components/bobbo-nav-bar/bobbo-nav-bar.vue");

  assert.match(source, /<bobbo-nav-bar[^>]*title="吃播偏好"[^>]*title-align="left"/);
  assert.match(navSource, /titleAlign:\s*\{\s*type:\s*String,\s*default:\s*['"]center['"]\s*\}/);
  assert.match(navSource, /titleAlign\s*===\s*['"]left['"]/);
  assert.match(navSource, /bobbo-nav-title-left/);
  assert.match(navSource, /\.bobbo-nav-title-left\s*\{[^}]*left:\s*112rpx\s*!important[^}]*justify-content:\s*flex-start/is);
  assert.match(navSource, /\.bobbo-nav-side\s*\{[^}]*z-index:\s*2/is);
  assert.doesNotMatch(source, /slot="right"|done-action|>完成<|finish\(\)/);
  assert.match(source, /萌脸快剪/);
  assert.match(source, /自然慢剪/);
  assert.match(source, /quick_cut/);
  assert.match(source, /natural/);
  assert.match(source, /bobbo_foodcast_ui_preferences/);
  assert.match(source, /callBackend\('\/api\/foodcasts\/preferences'/);
  assert.match(source, /method:\s*'PUT'/);
  assert.match(source, /保存失败，请重试/);
  assert.match(source, /mode:\s*this\.mode/);
  assert.match(source, /durationMode:\s*this\.durationMode/);
  assert.match(source, /随素材变化/);
  assert.match(source, /30 秒内/);
  assert.match(source, /60 秒内/);
  assert.match(source, /120 秒内/);
  assert.match(source, /class="duration-copy"/);
  assert.match(source, /durationMode === option\.value[^>]*class="selected-mark"/);
  assert.match(style, /\.duration-grid\s*\{[^}]*flex-direction:\s*column/is);
  assert.match(style, /\.duration-option\s*\{[^}]*width:\s*100%/is);
  assert.match(source, /uni\.setStorageSync/);
  assert.doesNotMatch(source, /暂未接入|shell-placeholder|可爱表情优先|完整进食过程|每一顿均衡出现|少剪辑/);
  assert.match(style, /\.preferences-page\s*\{[^}]*background:\s*#FBFBFA/is);
  assert.match(style, /\.preference-card\s*\{[^}]*background:\s*#FFFFFF[^}]*border-radius:\s*36rpx/is);
  assert.doesNotMatch(style, /linear-gradient|box-shadow|#2F7FE8|#4D7FD1/i);
  assertUsesOnlyBobboHexColors(style, file);
});

test("all Bobbo secondary page titles sit to the right of the back button", () => {
  const files = [
    "pages/bind/addDevice.vue",
    "pages/bind/bluetooth.vue",
    "pages/bind/qrcode.vue",
    "pages/bind/repairing.vue",
    "pages/clips/foodcast.vue",
    "pages/device/detail.vue",
    "pages/device/index.vue",
    "pages/live/index.vue",
    "pages/live/replay.vue",
    "pages/profile/cats.vue",
    "pages/profile/feedback.vue",
    "pages/profile/foodcast-preferences.vue",
    "pages/profile/notifications.vue",
    "pages/profile/settings.vue",
		"pages/profile/device-storage.vue",
    "pages/profile/share-device.vue",
    "pages/today/detail.vue",
  ];

  for (const file of files) {
    const source = readWorkspaceFile(file);
    assert.match(
      source,
      /<bobbo-nav-bar\b(?=[^>]*\btitle-align="left")[^>]*>/,
      `${file} should left-align its title after the back button`,
    );
  }
  const customize = readWorkspaceFile("pages/clips/customize.vue");
  assert.match(customize, /class="back"[\s\S]*class="nav-title">快速自定义/);
});

test("Bobbo foodcast page owns the supported target-duration control", () => {
  const source = readWorkspaceFile("pages/clips/foodcast.vue");

  assert.match(source, /targetDurationSec:\s*60/);
  assert.match(source, /targetDurationOptions:\s*\[20,\s*30,\s*60\]/);
  assert.doesNotMatch(source, /targetDurationOptions:[^\n]*120/);
  assert.match(source, /targetDurationSec:\s*this\.targetDurationSec/);
  assert.match(source, /selectTargetDuration\(duration\)/);
  assert.match(source, /20 秒|\{\{duration\}\}\s*秒/);
});

test("Bobbo family sharing page uses real invitation and member APIs", () => {
  const file = "pages/profile/share-device.vue";
  const source = readWorkspaceFile(file);
  const style = extractStyleBlock(source, file);
  assert.match(source, /<bobbo-nav-bar[^>]*title="共享设备"/);
  assert.match(source, /\/api\/devices/);
  assert.match(source, /share-invites/);
  assert.match(source, /\/sharing/);
  assert.match(source, /requestQrImage/);
  assert.match(source, /revokeMember|leaveDevice/);
  assert.match(source, /onShow\(\)\s*\{\s*this\.loadDevices\(\)/);
  assert.match(style, /\.share-page\s*\{[^}]*background:\s*#FBFBFA/is);
  assert.doesNotMatch(style, /linear-gradient|box-shadow|#2F7FE8|#4D7FD1/i);
  assertUsesOnlyBobboHexColors(style, file);

  const settingsFile = "pages/profile/settings.vue";
  const settings = readWorkspaceFile(settingsFile);
  const settingsStyle = extractStyleBlock(settings, settingsFile);
  assert.match(settings, /<bobbo-nav-bar[^>]*title="设置"/);
  assert.match(settings, /showUnavailable/);
  assert.match(settings, /暂未接入/);
  assert.match(settings, /clearAppSession/);
  assert.match(settings, /uni\.reLaunch\(\{\s*url:\s*['"]\/pages\/login\/index['"]/);
  assert.doesNotMatch(settings, /<input|通知偏好|隐私设置|家庭管理/);
  assert.match(settingsStyle, /\.logout-button\s*\{[^}]*color:\s*#9A4A40/is);
  assert.doesNotMatch(settingsStyle, /linear-gradient|box-shadow|#2F7FE8|#4D7FD1/i);
  assertUsesOnlyBobboHexColors(settingsStyle, settingsFile);
});

test("pages/bind/bluetooth.vue resets the bluetooth session between scans", () => {
  const source = readWorkspaceFile("pages/bind/bluetooth.vue");

  assert.match(source, /resetBluetoothSession/);
  assert.match(source, /closeBluetoothAdapter/);
  assert.match(source, /cleanupBluetoothAfterPairing/);
});

test("pages/bind/bluetooth.vue uses one entry for pairing and already-configured binding", () => {
  const source = readWorkspaceFile("pages/bind/bluetooth.vue");

  assert.match(source, /tryBindPendingDevice/);
  assert.match(source, /startConfiguredDeviceDiscovery/);
  assert.match(source, /udpSendMulticastData/);
  assert.match(source, /bindManualDevice/);
  assert.match(source, /manualSn/);
  assert.match(source, /adminToken/);
  assert.match(source, /ip:\s*draft\.ip\s*\|\|\s*['"]['"]/);
  assert.match(source, /port:\s*draft\.port\s*\|\|\s*['"]['"]/);
});

test("pages/bind/bluetooth.vue recovers an idempotent bind for a device already owned by the current account", () => {
  const source = readWorkspaceFile("pages/bind/bluetooth.vue");

  assert.match(source, /readOwnedDevices/);
  assert.match(source, /recoverExistingOwnedDevice/);
  assert.match(source, /callBackend\(['"]\/api\/devices['"]\)/);
  assert.match(source, /existing owned device recovered after bind failure/);
  assert.match(source, /设备已在当前账号，配网已更新/);
  assert.match(source, /设备已联网，但账号同步失败/);
  assert.match(source, /diagnosticId/);
  assert.match(source, /诊断编号/);
  assert.match(source, /syncSource:\s*options\.source/);
});

test("password-based Bluetooth pairing waits for an explicit device selection", () => {
  const source = readWorkspaceFile("pages/bind/bluetooth.vue");
  const searchStart = source.indexOf("\t\t\tsearchBleDevice() {");
  const searchEnd = source.indexOf("\n\t\t\ttryBindPendingDevice() {", searchStart);
  const searchFlow = source.slice(searchStart, searchEnd);
  const noPasswordBranch = searchFlow.indexOf("if (!this.wifiPassword)");
  const pendingBind = searchFlow.indexOf("this.tryBindPendingDevice()");
  const configuredDiscovery = searchFlow.indexOf("this.startConfiguredDeviceDiscovery()");
  const clearPending = searchFlow.indexOf("clearPendingDeviceBind()");
  const bluetoothScan = searchFlow.indexOf("this.resetBluetoothSession('before-scan')");

  assert.notEqual(searchStart, -1);
  assert.notEqual(searchEnd, -1);
  assert.ok(noPasswordBranch >= 0);
  assert.ok(pendingBind > noPasswordBranch);
  assert.ok(configuredDiscovery > noPasswordBranch);
  assert.ok(clearPending > configuredDiscovery);
  assert.ok(bluetoothScan > clearPending);
  assert.equal((searchFlow.match(/this\.tryBindPendingDevice\(\)/g) || []).length, 1);
  assert.equal((searchFlow.match(/this\.startConfiguredDeviceDiscovery\(\)/g) || []).length, 1);
});

test("pages/bind/qrcode.vue forwards SDK-compatible binding network fields", () => {
  const source = readWorkspaceFile("pages/bind/qrcode.vue");

  assert.match(source, /ip:\s*draft\.ip\s*\|\|\s*['"]['"]/);
  assert.match(source, /port:\s*draft\.port\s*\|\|\s*['"]['"]/);
});

test("pages/bind/bluetooth.vue only shows manual SN fallback after search failure", () => {
  const source = readWorkspaceFile("pages/bind/bluetooth.vue");

  assert.match(source, /manual-card" v-if="showManualBind"/);
  assert.match(source, /showManualBind:\s*false/);
  assert.match(source, /this\.showManualBind = true/);
  assert.match(source, /scan-timeout/);
});

test("bind pages start the WeChat WiFi module before reading connected WiFi", () => {
  const hotspotSource = readWorkspaceFile("utils/hotspot.js");
  const checkStart = hotspotSource.indexOf("function checkConnected()");
  const checkEnd = hotspotSource.indexOf("function openWifiSettings()", checkStart);
  assert.notEqual(checkStart, -1, "utils/hotspot.js should expose checkConnected");
  assert.notEqual(checkEnd, -1, "utils/hotspot.js should keep openWifiSettings after checkConnected");
  const checkConnected = hotspotSource.slice(checkStart, checkEnd);
  assert.ok(
    checkConnected.indexOf("wx.startWifi") < checkConnected.indexOf("wx.getConnectedWifi"),
    "checkConnected should call wx.startWifi before wx.getConnectedWifi"
  );

  for (const page of ["pages/bind/bluetooth.vue", "pages/bind/qrcode.vue"]) {
    const source = readWorkspaceFile(page);
    assert.match(source, /hotspot\.checkConnected\(\)/, `${page} should use hotspot.checkConnected()`);
    assert.doesNotMatch(source, /wx\.getConnectedWifi/, `${page} should not call wx.getConnectedWifi directly`);
  }
});

test("pages/device/index.vue refreshes backend ownership and keeps SDK state available from cache", () => {
  const source = readWorkspaceFile("pages/device/index.vue");

  assert.match(source, /callBackend\(['"]\/api\/devices['"]/);
  assert.match(source, /refreshOwnedDevices/);
  assert.match(source, /backend device refresh failed, using cache/);
  assert.doesNotMatch(source, /getDeviceList/);
  assert.match(source, /getDeviceToken/);
  assert.match(source, /getNewDeviceStatus/);
  assert.match(source, /getDeviceCovers/);
  assert.match(source, /buildOwnedDeviceCards/);
  assert.doesNotMatch(source, /password:\s*item\.password/);
  assert.doesNotMatch(source, /adminToken:\s*item\.adminToken/);
});

test("pages/today/index.vue loads every owned device and controls the selected device independently", () => {
  const source = readWorkspaceFile("pages/today/index.vue");

  assert.match(source, /activeCatDashboard\s*\?\s*\[activeCatDashboard\]/);
  assert.match(source, /:key="item\.id"/);
  assert.match(source, /refreshTodayDiary\(item\)/);
  assert.match(source, /goLive\(item\)/);
  assert.match(source, /playFeatured\(item\)/);
  assert.match(source, /switchToClips\(item\)/);
  assert.match(source, /getDeviceToken/);
  assert.match(source, /getNewDeviceStatus/);
  assert.match(source, /buildOwnedDeviceCards/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /activeCatIndex/);
  assert.doesNotMatch(source, /password:\s*(?:item|dev|device)\.password/);
  assert.doesNotMatch(source, /adminToken:\s*(?:item|dev|device)\.adminToken/);
});

test("pages/today/index.vue keeps the cat dashboard layout stable while devices load", () => {
  const source = readWorkspaceFile("pages/today/index.vue");
  const loadMatch = source.match(/async loadAllDevices\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync syncDiary/);

  assert.ok(loadMatch, "today page should define loadAllDevices before syncDiary");
  assert.doesNotMatch(source, /class="loading-state"/);
  assert.doesNotMatch(source, /class="empty-state"/);
  assert.doesNotMatch(source, /设备加载失败/);
  assert.doesNotMatch(source, /还没有绑定摄像头/);
  assert.match(source, /reconcileTodayDeviceCards/);
  assert.match(source, /diaryLoading:\s*!force && !item\.diary/);
  assert.match(source, /if \(!force\) \{[\s\S]*callDemoData\('getDiary'/);
  assert.doesNotMatch(source, /cached[\s\S]{0,300}this\.activeDeviceSn[\s\S]{0,80}return\s*\n/);
  assert.doesNotMatch(loadMatch[1], /this\.deviceCards\s*=\s*\[\]/);
});

test("pages/clips/index.vue follows the device selected on the today page", () => {
  const source = readWorkspaceFile("pages/clips/index.vue");

  assert.match(source, /getStorageSync\(['"]lastViewedDeviceSn['"]\)/);
  assert.match(source, /selectDeviceBySn/);
  assert.match(source, /callBackend\(['"]\/api\/foodcasts\/daily['"]/);
  assert.match(source, /callBackend\(['"]\/api\/foodcasts\/materials['"]/);
  assert.doesNotMatch(source, /this\.normalizeDevice\(devices\[0\]\)/);
  assert.doesNotMatch(source, /password:\s*dev\.password/);
});

test("demoData cloud sync forwards the selected device SN to the backend", () => {
  const source = readWorkspaceFile("cloudfunctions/demoData/index.js");

  assert.match(
    source,
    /httpRequestJson\("POST",\s*`\$\{serverBaseUrl\}\/api\/feed-analysis\/sync`,\s*\{\s*deviceSn,\s*date,/
  );
});

test("pages/live/index.vue uses SDK playback first and keeps backend recording separate", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const flowMatch = source.match(/async runPlaybackFlow\(reason = ['"]manual['"], options = \{\}\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tshowModalAsync/);

  assert.match(source, /async requestBackendLiveUrl\(requestId\)[\s\S]*callBackend\(['"]\/api\/devices\/['"]\s*\+\s*encodeURIComponent\(this\.device\.sn\)\s*\+\s*['"]\/livestream['"]/);
  assert.match(source, /playbackSource:\s*true/, "backend playback must remain fallback-only");
  assert.doesNotMatch(source, /sharedSource:\s*true/, "normal playback must not allocate the experimental shared source");
  assert.match(source, /async ensureRecordingHlsSession\(\)[\s\S]*callBackend\(['"]\/api\/devices\/['"]\s*\+\s*encodeURIComponent\(this\.device\.sn\)\s*\+\s*['"]\/livestream['"]/);
  assert.match(source, /recordingSource:\s*true/, "an explicit recording start must request a session-backed backend source");
  assert.doesNotMatch(source, /videoFilter:/, "live viewing and recording must not request a realtime video filter");
  assert.match(source, /deviceLogin/);
  assert.match(source, /livestream/);
  assert.match(source, /closeLivestream/);
  assert.match(source, /requestingPrimaryStream/);
  assert.match(source, /requestingFallbackStream/);
  assert.match(source, /requestingBackendStream/);
  assert.match(source, /switchingQuality/);
  assert.ok(flowMatch, "runPlaybackFlow should be present");
  const backendIndex = flowMatch[1].indexOf("requestBackendLiveUrl(requestId)");
  const sdkIndex = flowMatch[1].indexOf("requestLiveUrl(requestId)");
  assert.notEqual(sdkIndex, -1);
  assert.notEqual(backendIndex, -1);
  const loginIndex = flowMatch[1].indexOf("loginDevice(requestId");
  assert.notEqual(loginIndex, -1);
  assert.ok(loginIndex < sdkIndex, "device login and keepalive must start before SDK livestream acquisition");
  assert.ok(sdkIndex < backendIndex, "normal playback must try the known-good SDK stream before backend fallback");
  assert.match(flowMatch[1], /startKeepAlive|loginDevice/);
  assert.match(flowMatch[1], /source === ['"]backend['"]\) this\.clearKeepAlive\(\{ invalidateLogin: true \}\)/);
});

test("shared live viewing gets an access-gated token then reuses the owner phone SDK path", () => {
  const liveSource = readWorkspaceFile("pages/live/index.vue");
  const overviewSource = readWorkspaceFile("pages/live/overview.vue");
  const todaySource = readWorkspaceFile("pages/today/index.vue");
  const deviceSource = readWorkspaceFile("pages/device/index.vue");
  const flowMatch = liveSource.match(/async executePlaybackFlow\(reason = ['"]manual['"], options = \{\}\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tshowModalAsync/);

  assert.ok(flowMatch, "shared playback flow should be present");
  assert.match(liveSource, /async resolveSharedLiveToken\(requestId\)[\s\S]*ensureSharedLiveAccess/);
  assert.match(liveSource, /require\(['"]@\/utils\/sharedLiveAccess\.js['"]\)/);
  assert.match(liveSource, /payload\s*&&\s*payload\.deviceToken/);
  assert.doesNotMatch(liveSource, /callSdk\(['"]getDeviceToken['"]/);
  assert.match(flowMatch[1], /this\.device\.role === ['"]member['"][\s\S]*resolveSharedLiveToken\(requestId\)/);
  assert.match(flowMatch[1], /loginDevice\(requestId[\s\S]*requestLiveUrl\(requestId\)/);
  assert.match(flowMatch[1], /buildRouteOrder[\s\S]*route === ['"]sdk['"][\s\S]*requestBackendLiveUrl\(requestId\)/);
  assert.doesNotMatch(liveSource, /teardownPlayback\(\)[\s\S]*this\.device\.role === ['"]member['"][\s\S]*deviceToken:\s*['"]/);
  assert.doesNotMatch(overviewSource, /token:\s*item\.token \|\| item\.deviceToken/);
  assert.doesNotMatch(todaySource, /token:\s*item\.token \|\| item\.deviceToken/);
  assert.match(overviewSource, /prewarmSharedAccess/);
  assert.doesNotMatch(overviewSource, /callSdk\(['"]getDeviceToken['"]/);
  for (const source of [todaySource, deviceSource]) {
    assert.match(source, /selectDirectLiveSdkDevices/);
  }
});

test("targeted live diagnostics survive device caching and every live-page entry", () => {
  const cacheSource = readWorkspaceFile("utils/ownedDeviceCache.js");
  const liveSource = readWorkspaceFile("pages/live/index.vue");
  const entrySources = [
    readWorkspaceFile("pages/live/overview.vue"),
    readWorkspaceFile("pages/today/index.vue"),
    readWorkspaceFile("pages/device/detail.vue"),
  ];

  assert.match(cacheSource, /liveDiagnosticsEnabled:\s*device\.liveDiagnosticsEnabled === true/);
  for (const source of entrySources) {
    assert.match(source, /liveDiagnosticsEnabled:\s*(?:item|this\.device)\.liveDiagnosticsEnabled === true/);
  }
  assert.match(liveSource, /createLivePlaybackDiagnostics\(\{ enabled: false \}\)/);
  assert.match(liveSource, /\/live-playback-events/);
  assert.match(liveSource, /onVideoPlay\(\)[\s\S]*reportLivePlaybackEvent\(['"]video_play['"]/);
  assert.match(liveSource, /onVideoTimeUpdate\(event\)[\s\S]*livePlaybackDiagnostics\.progress/);
});

test("pages/live/index.vue nests landscape controls inside the native video fullscreen layer", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const videoOpen = source.indexOf("<video");
  const videoClose = source.indexOf("</video>", videoOpen);
  const controls = source.indexOf('<cover-view class="landscape-controls"', videoOpen);

  assert.ok(videoOpen >= 0, "live page must render a video component");
  assert.ok(videoClose > videoOpen, "video must wrap its native fullscreen cover views");
  assert.ok(controls > videoOpen && controls < videoClose, "landscape controls must be children of video");
  assert.match(source.slice(controls, videoClose), /v-show="isLandscapeFullscreen"/, "controls must already exist when native fullscreen takes over the video layer");
});

test("pages/live/index.vue prewarms only recording control and starts the video source after an explicit tap", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const fullscreenHandler = source.match(/onFullscreenChange\(event\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\ttraceLandscapeControlsLayout/);
  const recordingHandler = source.match(/async toggleLiveRecording\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync saveCompletedRecording/);
  const talkHandler = source.match(/async toggleTalkback\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tfailPlayback/);

  assert.match(source, /@tap="toggleLiveRecording"/);
  assert.match(source, /class="record-button"/);
  assert.match(source, /class="record-dot"/);
  assert.equal((source.match(/class="sound-wave/g) || []).length, 4, "live and replay fullscreen speaker icons each need two visible sound waves");
  assert.match(source, /@tap="captureLiveImage"/);
  assert.match(source, /callSdkWithToken\(['"]capture['"]/);
  assert.match(source, /\[live\] screenshot failure detail/);
  assert.doesNotMatch(source, /\/live-snapshot/);
  assert.match(source, /@tap="toggleTalkback"/);
  assert.match(source, /createMediaActionGuard/, "recording and talk operations need bounded timeout recovery");
  assert.ok(fullscreenHandler);
  assert.match(fullscreenHandler[1], /warmupLiveRecording/, "entering fullscreen should prepare recording control early");
  assert.doesNotMatch(fullscreenHandler[1], /startRecording/, "prewarming must never start recording without a tap");
  const warmupHandler = source.match(/warmupLiveRecording\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync releaseAuxiliaryRecordingSession/);
  assert.ok(warmupHandler);
  assert.match(warmupHandler[1], /ensureLiveMediaControl/);
  assert.doesNotMatch(warmupHandler[1], /prepareLiveRecording|ensureRecordingHlsSession/, "watching live video must not allocate a second camera stream");
  assert.match(source, /prepareLiveRecording\(\)[\s\S]*ensureLiveMediaControl[\s\S]*ensureRecordingHlsSession/);
  assert.ok(recordingHandler);
  assert.match(recordingHandler[1], /prepareLiveRecording/);
  assert.match(recordingHandler[1], /startRecording/);
  assert.match(recordingHandler[1], /stopRecording/);
  assert.match(source, /saveRemoteVideo/);
  assert.match(source, /\/api\/live-recordings\//);
  assert.ok(talkHandler);
  assert.match(talkHandler[1], /ensureLiveMediaControl/, "talkback should still connect on demand");
});

test("pages/live/index.vue refreshes the backend session before media-control websocket authorization", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const handler = source.match(/async ensureLiveMediaControl\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tonLiveMediaEvent/);

  assert.ok(handler, "live media control setup must exist");
  assert.match(source, /refreshBackendSession/);
  assert.match(handler[1], /await refreshBackendSession/);
  assert.ok(
    handler[1].indexOf("await refreshBackendSession") < handler[1].indexOf("createLiveMediaControl"),
    "session renewal must finish before websocket control is created"
  );
});

test("pages/live/index.vue does not start another recording while MP4 finalization is pending", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const handler = source.match(/async toggleRecording\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync pollRecordingResult/);

  assert.ok(handler, "recording toggle handler must exist");
  assert.match(handler[1], /\['stopping', 'finalizing'\]\.includes\(this\.mediaState\.record\)/);
  assert.ok(
    handler[1].indexOf("'finalizing'") < handler[1].indexOf("startRecording()"),
    "the finalizing guard must run before record.start is sent"
  );
});

test("pages/live/index.vue keeps polling an active recording when fullscreen teardown closes media control", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
	const handler = source.match(/teardownLiveMedia\(\{ finalizeRecording = true(?:, recordingWasPending = false)? \} = \{\}\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync ensureRecordingHlsSession/);

  assert.ok(handler, "media teardown handler must exist");
  assert.match(handler[1], /this\.mediaState\.recording/);
  assert.match(handler[1], /this\.pollRecordingResult/);
  assert.ok(
    handler[1].indexOf("this.pollRecordingResult") < handler[1].indexOf("control.close"),
    "result polling must start before the websocket is closed"
  );
});

test("pages/live/index.vue explains that an independent recording connection failure does not stop live viewing", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /RECORDING_SOURCE_FAILED:\s*['"]录屏连接失败，主直播不受影响['"]/);
});

test("pages/live/index.vue saves a ready recording immediately without waiting for fullscreen exit", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const handler = source.match(/async pollRecordingResult\(recordingId, attempt\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync flushPendingRecordingSave/);

  assert.ok(handler, "recording result polling handler must exist");
  assert.match(handler[1], /this\.pendingRecordingVideoUrl = recording\.videoUrl[\s\S]*?this\.flushPendingRecordingSave\(\)/);
  assert.doesNotMatch(handler[1], /if \(!this\.isLandscapeFullscreen\) this\.flushPendingRecordingSave\(\)/);
});

test("pages/live/index.vue replaces an unauthorized media controller before recording retry", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const handler = source.match(/async ensureLiveMediaControl\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tonLiveMediaEvent/);

  assert.ok(handler, "live media setup handler must exist");
  assert.match(handler[1], /this\.liveMediaControl\.isAuthorized\(\)/);
  assert.match(handler[1], /control\.close\(\)/);
  assert.ok(
    handler[1].indexOf("isAuthorized()") < handler[1].indexOf("createLiveMediaControl"),
    "an unauthorized controller must be discarded before a new one is created"
  );
});

test("pages/live/index.vue captures device images without opening another stream", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const captureMethod = source.match(/async captureDeviceImage\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync saveCapturedDeviceCover/);

  assert.match(source, /captureDeviceCoverOnce/);
  assert.match(source, /extractCoverCandidate/);
  assert.match(source, /persistDeviceCover/);
  assert.match(source, /buildDeviceCapturePayload/);
  assert.match(source, /callSdkWithToken\(['"]capture['"]/);
  assert.doesNotMatch(source, /\/live-snapshot/);
  assert.ok(captureMethod, "captureDeviceImage should be present");
  assert.doesNotMatch(captureMethod[1], /requestBackendLiveUrl|\/livestream/);
});

test("primary pages render account-owned cache and refresh authoritative backend ownership", () => {
  const overview = readWorkspaceFile("pages/live/overview.vue");
  const today = readWorkspaceFile("pages/today/index.vue");
  const device = readWorkspaceFile("pages/device/index.vue");

  assert.match(overview, /readOwnedDevices\(uni\)/);
  assert.match(overview, /restoreCachedDevices\(\)[\s\S]*this\.loadDevices\(\)/);
  assert.match(overview, /refreshOwnedDevices\(async \(\) =>/);
  assert.match(today, /refreshOwnedDevices\(async \(\) =>/);
  assert.match(device, /restoreCachedDevices\(\)[\s\S]*this\.loadDevices\(\)/);
  assert.match(device, /const cachedBySn = readOwnedDevices\(uni\)/);
});

test("pages/live/index.vue captures a fresh device cover only after playback is stable", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const playStart = source.indexOf("onVideoPlay() {");
  const playEnd = source.indexOf("onVideoWaiting()", playStart);
  const playHandler = source.slice(playStart, playEnd);

  assert.match(source, /COVER_CAPTURE_DELAY_MS\s*=\s*12000/);
  assert.match(playHandler, /coverCaptureTimer\s*=\s*setTimeout/);
  assert.match(playHandler, /captureDeviceCoverOnce\(\)/);
  assert.doesNotMatch(playHandler, /checkDeviceTimeAfterFirstFrame\(\)/);
  const warmupTimerStart = playHandler.indexOf("this.firstFrameTimer = setTimeout");
  const coverTimerStart = playHandler.indexOf("this.coverCaptureTimer = setTimeout");
  assert.ok(warmupTimerStart >= 0 && coverTimerStart > warmupTimerStart);
  assert.doesNotMatch(playHandler.slice(warmupTimerStart, coverTimerStart), /captureDeviceCoverOnce\(\)/);
  assert.match(source, /captureDeviceCoverOnce\(\)[\s\S]*playbackHealthTracker\.snapshot/);
  assert.match(source, /health\.stalled|lastAdvanceAgoMs/);
  assert.match(source, /JSON\.stringify\(error\.captureSummary\)/);
  assert.match(source, /downloadJson:\s*JSON\.stringify\(downloadSummary\)/);
  assert.match(source, /upsertOwnedDevice/);
  assert.match(source, /async saveCapturedDeviceCover\([\s\S]*coverUpdatedAt[\s\S]*upsertOwnedDevice\(/);
});

test("pages/live/index.vue can leave live view even when teardownPlayback is unavailable", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const start = source.indexOf("goBack() {");
  const end = source.indexOf("goReplay()", start);
  const body = source.slice(start, end);

  assert.match(body, /typeof this\.teardownPlayback === ['"]function['"]/);
  assert.match(body, /typeof this\.teardownLiveMedia === ['"]function['"]/);
  assert.match(body, /this\.closeCurrentStream\(\{ clearUrl: true \}\)/);
  assert.match(body, /uni\.navigateBack\(\)/);
});

test("pages/live/index.vue guards optional teardown methods in every lifecycle entry", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  for (const entry of ["onHide() {", "onUnload() {", "onFullscreenChange(event) {", "goBack() {"]) {
    const start = source.indexOf(entry);
    assert.notEqual(start, -1, `${entry} should exist`);
    const body = source.slice(start, source.indexOf("\n\t\t\t},", start) + 6);
    assert.match(body, /typeof this\.teardownLiveMedia === ['"]function['"]/, `${entry} should guard media teardown`);
  }
});

test("pages/live/index.vue resumes playback after returning from replay", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /pendingReplayNavigation/);
  assert.match(source, /resumePlaybackOnShow/);
  assert.match(source, /resumePlaybackReason/);
  assert.match(source, /onShow\(\)/);
  assert.match(source, /resumePlaybackReason\s*=\s*['"]resume-from-replay['"]/);
  assert.match(source, /runPlaybackFlow\(reason\)/);
});

test("pages/live/index.vue resumes playback after mini program backgrounding", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /resumePlaybackReason:\s*['"]/);
  assert.match(source, /leavingLivePage:\s*false/);
  assert.match(source, /resume-from-background/);
  assert.match(source, /this\.resumePlaybackReason\s*\|\|\s*['"]resume-from-background['"]/);
  assert.match(source, /onHide\(\)[\s\S]*this\.resumePlaybackOnShow\s*=\s*true/);
  assert.match(source, /goBack\(\)[\s\S]*this\.leavingLivePage\s*=\s*true/);
});

test("pages/live/index.vue tries each healthy live route at most once", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /async loginDevice\([\s\S]*?catch \(error\)[\s\S]*?return false/);
  assert.match(source, /async requestLiveUrl\([\s\S]*?catch \(error\)[\s\S]*?livestream candidate failed/);
  assert.match(source, /isTransientLivestreamFailure\(result\)/);
  assert.match(source, /await delay\(LIVESTREAM_RETRY_DELAY_MS\)/);
  assert.match(source, /retryLivestreamCandidate/);
  assert.match(source, /requestBackendLiveUrl\(requestId\)/);
  assert.match(source, /backend livestream fallback failed/);
  const flow = source.match(/async executePlaybackFlow\(reason = ['"]manual['"], options = \{\}\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tshowModalAsync/);
  assert.ok(flow);
  assert.match(flow[1], /buildRouteOrder/);
  assert.match(flow[1], /attemptedPlaybackRoutes\.has\(route\)/);
  assert.match(flow[1], /requestLiveUrl\(requestId\)/);
  assert.match(flow[1], /requestBackendLiveUrl\(requestId\)/);
  assert.match(source, /async fallbackToSdkAfterVideoError\(/);
  assert.match(source, /shouldFallbackToSdkLive\(/);
  assert.match(source, /sdkFallbackInProgress/);
  assert.match(source, /onVideoError\([\s\S]*fallbackToSdkAfterVideoError/);
});

test("pages/live/index.vue does not churn between live sources on waiting events", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.doesNotMatch(source, /VIDEO_STALL_FALLBACK_MS/);
  assert.doesNotMatch(source, /playbackStallTimer/);
  assert.doesNotMatch(source, /schedulePlaybackStallFallback/);
  const waiting = source.match(/onVideoWaiting\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tonVideoTimeUpdate/);
  assert.ok(waiting);
  assert.doesNotMatch(waiting[1], /fallback|runPlaybackFlow|requestLiveUrl|requestBackendLiveUrl/);
});

test("pages/live/index.vue claims backend live priority and emits measured playback health", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /createPlaybackHealthTracker/);
  assert.match(source, /\/live-priority/);
  assert.match(source, /startLivePriority/);
  assert.match(source, /clearLivePriority/);
  assert.match(source, /\[live\] playback health/);
  assert.match(source, /\[live\] playback recovered/);
  assert.match(source, /onVideoTimeUpdate\(event\)/);
  assert.match(source, /event[\s\S]*detail[\s\S]*currentTime/);
});

test("pages/live/index.vue switches a stalled SDK stream once to the stable backend route", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /PLAYBACK_RECOVERY_STALL_MS\s*=\s*8000/);
  assert.match(source, /PLAYBACK_RECOVERY_COOLDOWN_MS\s*=\s*12000/);
  assert.match(source, /PLAYBACK_RECOVERY_MAX_ATTEMPTS\s*=\s*1/);
  assert.match(source, /recoverStalledSdkPlayback/);
  assert.match(source, /\[live\] measured stall recovery/);
  assert.match(source, /health\.activeStallMs\s*<\s*PLAYBACK_RECOVERY_STALL_MS/);
  assert.match(source, /source\s*!==\s*['"]sdk['"]/);
  assert.match(source, /isRecordingBusy|isTalkActive/);
  assert.match(source, /attemptedPlaybackRoutes\.has\(['"]backend['"]\)/);
  assert.match(source, /requestBackendLiveUrl\(guardRequestId\)/);
  assert.doesNotMatch(source, /runPlaybackFlow\(['"]measured-stall-recovery['"]/);
});

test("pages/live/index.vue expands replay cards inline and replaces the top player only after selection", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const pages = JSON.parse(readWorkspaceFile("pages.json"));
  const livePage = pages.pages.find((page) => page.path === "pages/live/index");
  assert.match(source, /class="inline-replay"/);
  assert.match(source, /<scroll-view class="inline-record-list"[^>]*scroll-y/);
  assert.match(source, /\.live-page\s*\{[^}]*height:\s*100vh[^}]*overflow:\s*hidden/);
  assert.match(source, /\.inline-replay\s*\{[^}]*flex:\s*1[^}]*overflow:\s*hidden/);
  assert.match(source, /thumbnailUrl/);
  assert.match(source, /playInlineRecord/);
  assert.match(source, /stopLiveForInlineReplay/);
  const stopStart = source.indexOf("async stopLiveForInlineReplay()")
  const stopEnd = source.indexOf("async closeInlineReplaySession()", stopStart)
  const stopBody = source.slice(stopStart, stopEnd)
  assert.match(stopBody, /Promise\.race/)
  assert.match(stopBody, /setTimeout\(resolve,\s*600\)/)
  assert.doesNotMatch(stopBody, /invalidateLogin:\s*true/)
  assert.doesNotMatch(stopBody, /clearUrl:\s*true/)
  assert.match(source, /this\.inlineReplayKey === nextReplayKey/)
  assert.match(source, /录像播放中断，请重试/)
  assert.doesNotMatch(source, /录像加载失败，请选择其他片段/)
  assert.match(source, /returnToLive/);
  assert.equal(livePage.style.disableScroll, true);
  assert.doesNotMatch(source, /uni\.navigateTo\(\{[\s\S]{0,120}\/pages\/live\/replay\?device=/);
});

test("pages/live/index.vue removes the loading mask as soon as native playback starts", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const start = source.indexOf("onVideoPlay() {");
  const end = source.indexOf("onVideoWaiting()", start);
  const body = source.slice(start, end);
  assert.match(body, /setPlaybackState\(['"]playing['"],\s*['"]['"]\)/);
  assert.doesNotMatch(body, /setPlaybackState\(['"]waitingForMedia['"]/);
});

test("pages/live/index.vue uses direct HLS inline and only recovers legacy relay sessions", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  assert.match(source, /REPLAY_STALL_RECOVERY_MS\s*=\s*5000/);
  assert.match(source, /recoverReplayPlayback/);
  assert.match(source, /\/api\/replay-sessions\/['"]\s*\+\s*encodeURIComponent\(sessionId\)\s*\+\s*['"]\/status/);
  assert.match(source, /status\.state\s*===\s*['"]recovering['"]/);
  assert.match(source, /status\.playUrl\s*!==\s*this\.liveUrl/);
  assert.match(source, /this\.replayBaseSec\s*\+\s*this\.replayMediaTime/);
  const hideBody = source.slice(source.indexOf("onHide() {"), source.indexOf("onUnload() {"));
  assert.doesNotMatch(hideBody, /closeInlineReplaySession/);
  assert.doesNotMatch(hideBody, /this\.liveUrl\s*=\s*['"]['"]/);
  const fullscreenBody = source.slice(source.indexOf("onFullscreenChange(event) {"), source.indexOf("traceLandscapeControlsLayout()"));
  assert.match(fullscreenBody, /this\.viewerMode\s*===\s*['"]replay['"]/);
  const replayFullscreenBody = source.slice(source.indexOf("enterReplayFullscreen() {"), source.indexOf("exitReplayFullscreen()", source.indexOf("enterReplayFullscreen() {")));
  assert.match(replayFullscreenBody, /this\.applyReplayPlaybackRate\(\)/);
  assert.match(source, /isLandscapeFullscreen\(\)\s*\{[\s\S]*this\.viewerMode\s*===\s*['"]live['"]/);
  const replayStart = source.indexOf("async playInlineRecord(item)");
  const replayEnd = source.indexOf("async returnToLive()", replayStart);
  const replayBody = source.slice(replayStart, replayEnd);
  assert.match(replayBody, /mediaType:\s*['"]hls['"]/);
  assert.match(replayBody, /protocol:\s*['"]hls['"]/);
  assert.match(replayBody, /preferDirectHls:\s*true/);
  assert.match(source, /inlineReplayManifestSessionId:\s*['"]['"]/);
  assert.match(replayBody, /this\.inlineReplayManifestSessionId\s*=\s*result\.manifestSessionId\s*\|\|\s*['"]['"]/);
  assert.match(source, /new Set\(\[\s*this\.inlineReplaySessionId,\s*this\.inlineReplayManifestSessionId/);
  assert.doesNotMatch(replayBody, /protocol:\s*['"]ts['"]/);
  const waitingStart = source.indexOf("onVideoWaiting() {");
  const waitingEnd = source.indexOf("onVideoEnded()", waitingStart);
  assert.match(source.slice(waitingStart, waitingEnd), /if \(this\.inlineReplaySessionId\) this\.scheduleReplayRecovery/);
  assert.match(source, /showVideoMask\(\)[\s\S]*if \(this\.liveUrl && this\.replayHasStarted\) return false/);
});

test("pages/live/index.vue isolates replay source switches from stale player events", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const replayStart = source.indexOf("async playInlineRecord(item)");
  const replayEnd = source.indexOf("async returnToLive()", replayStart);
  const replayBody = source.slice(replayStart, replayEnd);

  assert.match(source, /:key="viewerMode \+ ':' \+ inlineReplayKey \+ ':' \+ videoPlayerGeneration"/);
  assert.match(source, /rotateVideoPlayer\(\)[\s\S]*this\.videoPlayerGeneration \+= 1/);
  assert.match(source, /isCurrentVideoEvent\(event\)/);
  assert.match(replayBody, /this\.replaySourceSwitching\s*=\s*true/);
  assert.match(replayBody, /this\.videoContext[\s\S]*?\.pause\(\)[\s\S]*?this\.liveUrl\s*=\s*['"]['"]/);
  assert.match(replayBody, /this\.armReplaySourceSwitchTimeout\(\)/);
  assert.match(source, /onVideoError\(error\)[\s\S]*?if \(this\.replaySourceSwitching\) return/);
  assert.match(source, /onVideoPlay\(\)[\s\S]*?this\.completeReplaySourceSwitch\(\)/);
});

test("pages/live/replay.vue releases direct HLS manifest sessions on exit", () => {
  const source = readWorkspaceFile("pages/live/replay.vue");
  assert.match(source, /manifestSessionId:\s*['"]['"]/);
  assert.match(source, /this\.manifestSessionId\s*=\s*result\.manifestSessionId\s*\|\|\s*['"]['"]/);
  assert.match(source, /new Set\(\[\s*this\.sessionId,\s*this\.manifestSessionId/);
  assert.match(source, /this\.manifestSessionId\s*=\s*['"]['"]/);
  assert.match(source, /for \(const sessionId of closingSessionIds\)/);
});

test("pages/live/index.vue gives historical playback fullscreen controls, speed, and clip export", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  assert.match(source, /class="replay-fullscreen-controls"\s+v-show="isReplayFullscreen && replayControlsVisible"/);
  assert.match(source, /class="video-area"\s+:class="\{ 'is-replay-portrait-fullscreen': isReplayFullscreen \}"/);
  assert.match(source, /class="video-player"\s+:class="\{ 'is-replay-portrait-video': isReplayFullscreen \}"/);
  assert.doesNotMatch(source, /requestFullScreen\(\{ direction: 0 \}\)/);
  assert.match(source, /\.video-area\.is-replay-portrait-fullscreen\s*\{[^}]*position:\s*fixed/i);
  assert.match(source, /\.video-player\.is-replay-portrait-video\s*\{[^}]*rotate\(90deg\)/i);
  assert.match(source, /replaySafeTopPx/);
  assert.match(source, /openDirectReplayAtSec\(target, previous\)/);
  const seekableStart = source.indexOf("async openDirectReplayAtSec(target, previous)");
  const seekableEnd = source.indexOf("handleReplayAction()", seekableStart);
  const seekableBody = source.slice(seekableStart, seekableEnd);
  assert.match(seekableBody, /mediaType:\s*['"]hls['"]/);
  assert.match(seekableBody, /protocol:\s*['"]hls['"]/);
  assert.match(seekableBody, /preferDirectHls:\s*true/);
  assert.match(seekableBody, /forceSeekableHls:\s*false/);
  assert.doesNotMatch(seekableBody, /REPLAY_SEEK_SESSION_MISSING/);
  assert.match(seekableBody, /this\.replayBaseSec\s*=\s*target[\s\S]*this\.replayPendingSeekSec\s*=\s*target/);
  assert.doesNotMatch(seekableBody, /this\.liveUrl\s*=\s*['"]['"]/);
  assert.match(seekableBody, /this\.replayHasStarted\s*=\s*previousPlayback\.hasStarted[\s\S]*this\.liveUrl\s*=\s*nextUrl/);
  assert.match(source, /onVideoError\(error\)\s*\{[\s\S]*if \(this\.replaySeekInProgress\) return/);
  assert.match(source, /refreshReplayProgressRect\(\)/);
  assert.match(source, /targetSecFromTrack\(/);
  assert.match(source, /targetSec:\s*target/);
  assert.doesNotMatch(source, /videoContext\.seek/);
  assert.match(source, /class="replay-speed-overlay"/);
  assert.match(source, /class="landscape-sound-control"/);
  assert.match(source, /class="landscape-center-controls replay-center-controls"/);
  assert.doesNotMatch(source, /class="replay-bottom-console"/);
  assert.match(source, /v-for="rate in replayPlaybackRates"/);
  assert.match(source, /@tap\.stop="setReplayPlaybackRate\(rate\)"/);
  assert.match(source, /playbackRate\(this\.replayPlaybackRate\)/);
  assert.match(source, /@tap\.stop="toggleReplayClipRecording"/);
  assert.match(source, /\/api\/devices\/['"]\s*\+\s*encodeURIComponent\(this\.device\.sn\)\s*\+\s*['"]\/replay-clips/);
  assert.match(source, /this\.pollRecordingResult\(recording\.id,\s*0\)/);
  assert.match(source, /@ended="onVideoEnded"/);
});

test("pages/live/index.vue previews replay progress while dragging and commits only on release", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const start = source.indexOf("onReplayProgressTouchStart(event) {");
  const move = source.indexOf("onReplayProgressTouchMove(event) {", start);
  const startBody = source.slice(start, move);
  const moveEnd = source.indexOf("onReplayProgressTouchEnd(event) {", move);
  const moveBody = source.slice(move, moveEnd);
  const cancelStart = source.indexOf("onReplayProgressTouchCancel()", moveEnd);
  const cancelEnd = source.indexOf("async commitReplayProgressGesture(", cancelStart);
  const cancelBody = source.slice(cancelStart, cancelEnd);
  const commitStart = source.indexOf("async commitReplayProgressGesture(");
  const seekStart = source.indexOf("async seekReplayToSec(", commitStart);
  const commitBody = source.slice(commitStart, seekStart);

  assert.match(source, /@touchcancel\.stop="onReplayProgressTouchCancel"/);
  assert.ok(start >= 0, "replay progress touchstart handler should exist");
  assert.match(startBody, /this\.replayProgressDragging\s*=\s*true/);
  assert.doesNotMatch(startBody, /await\s+this\.refreshReplayProgressRect\(\)/);
  assert.doesNotMatch(startBody, /seekReplayToSec|commitReplayProgressGesture|scheduleReplayProgressCommit/);
  assert.doesNotMatch(moveBody, /seekReplayToSec|commitReplayProgressGesture|scheduleReplayProgressCommit/);
  assert.doesNotMatch(source, /REPLAY_PROGRESS_COMMIT_DELAY_MS|scheduleReplayProgressCommit/);
  assert.match(cancelBody, /this\.replayPendingSeekSec\s*=\s*this\.replayProgressBeforeDragSec/);
  assert.doesNotMatch(cancelBody, /seekReplayToSec|commitReplayProgressGesture/);
  assert.match(commitBody, /gestureId\s*===\s*this\.replayProgressCommittedGestureId/);
  assert.match(commitBody, /this\.replayProgressCommittedGestureId\s*=\s*gestureId/);
  assert.match(commitBody, /await\s+this\.seekReplayToSec\(targetSec\)/);
  assert.match(source, /cancelReplayProgressGesture\(\)\s*\{[\s\S]*this\.replayProgressDragging\s*=\s*false/);
});

test("pages/live/index.vue renders replay analysis as one continuous absolute-time color band", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  assert.match(source, /class="day-timeline-band"/);
  assert.match(source, /class="day-timeline-segment"/);
  assert.match(source, /replayDayTimelineSegments/);
  assert.match(source, /buildDayTimelineGeometry\(this\.replayRecords,\s*this\.replayDayMarkers,\s*this\.replayDayMeals\)/);
  assert.match(source, /\/api\/devices\/' \+ encodeURIComponent\(this\.device\.sn\) \+ '\/timeline'/);
  assert.match(source, /since:\s*this\.timelineRevision/);
  assert.match(source, /scheduleTimelineRefresh/);
  assert.match(source, /Keep the last good timeline during transient tunnel\/server failures/);
  assert.match(source, /\.day-timeline-band\s*\{[^}]*top:\s*10rpx[^}]*bottom:\s*26rpx[^}]*width:\s*18rpx/i);
  assert.doesNotMatch(source, /v-for="item in replayRecords"[\s\S]{0,300}class="timeline-band"/);
  assert.doesNotMatch(source, /class="timeline-line"|class="timeline-dot"/);
});

test("pages/live/index.vue avoids stale close callbacks clearing a replacement stream", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /closingCurrentPayload/);
  assert.match(source, /if \(clearUrl && closingCurrentPayload\) this\.liveUrl = ''/);
  assert.doesNotMatch(source, /finally \{[\s\S]*?if \(clearUrl\) this\.liveUrl = ''/);
});

test("pages/live/index.vue checks device time after first frame and can sync it with SDK or backend", () => {
  const source = readWorkspaceFile("pages/live/index.vue");

  assert.match(source, /OPTimeQuery/);
  assert.match(source, /shouldPromptTimeSync/);
  assert.match(source, /buildTimeSyncPayload/);
  assert.match(source, /OPTimeSetting|OPUTCTimeSetting/);
  assert.match(source, /\/time['"]/);
  assert.match(source, /\/time-sync['"]/);
  assert.match(source, /120/);
});

test("pages/live/index.vue keeps the old stream alive until a quality switch succeeds", () => {
  const source = readWorkspaceFile("pages/live/index.vue");
  const match = source.match(/async toggleQuality\(\) \{([\s\S]*?)\r?\n\t\t\t\},\r?\n\t\t\tasync fallbackToSdkAfterVideoError\(/);

  assert.ok(match, "toggleQuality method should be present");
  const body = match[1];
  const requestIndex = body.indexOf("runPlaybackFlow('quality-switch'");
  const closeIndex = body.indexOf("closeCurrentStream({ payload: previousPayload");

  assert.notEqual(requestIndex, -1);
  assert.notEqual(closeIndex, -1);
  assert.ok(
    requestIndex < closeIndex,
    "old stream should be closed only after the replacement stream is ready"
  );
});

test("pages/live/replay.vue defaults replay playback to video-compatible HLS", () => {
  const source = readWorkspaceFile("pages/live/replay.vue");
  const filterRequests = source.match(/videoFilter:\s*['"]cute-v1['"]/g) || [];

  assert.match(source, /<live-player[\s\S]*:src="streamUrl"/);
  assert.match(source, /\/replay-sessions['"]/);
  assert.match(source, /\/seek['"]/);
  assert.match(source, /DELETE/);
  assert.match(source, /playbackType:\s*['"]relay['"]/);
  assert.match(source, /progressDragging/);
  assert.match(source, /livePlayerUnavailable/);
  assert.match(source, /hlsFallbackInFlight/);
  assert.match(source, /Number\(e\.detail\.errno\)\s*===\s*102/);
  assert.match(source, /closeReplaySessionById/);
  assert.match(source, /lanHost:\s*this\.device\.ip/);
  assert.match(source, /rtsp-hls-relay/);
  assert.match(source, /mediaType:\s*['"]hls['"]/);
  assert.match(source, /protocol:\s*['"]hls['"]/);
  assert.match(source, /preferDirectHls:\s*true/);
  assert.equal(filterRequests.length, 0, "interactive replay should not force the server-side cute filter");
  assert.match(source, /mode\s*=\s*['"]playlist['"][\s\S]*playRecord\(this\.recordList\[0\],\s*0\)/);
  assert.match(source, /mode\s*===\s*['"]playlist['"][\s\S]*playRecord\(this\.recordList\[nextIndex\],\s*nextIndex\)/);
  assert.match(source, /targetSec:\s*Number\(params\.targetSec\s*\|\|\s*0\)/);
  assert.match(source, /result\.playbackType\s*===\s*['"]hls['"]/);
  assert.match(source, /result\.playUrl\s*\|\|\s*result\.url\s*\|\|\s*result\.streamUrl/);
  assert.match(source, /<video[\s\S]*v-if="playbackType === 'hls' && !playbackEnded && !playbackFailed"/);
  assert.match(source, /direction="90"/);
  assert.match(source, /:show-fullscreen-btn="true"/);
  assert.match(source, /:show-progress="false"/);
  assert.match(source, /:show-play-btn="true"/);
  assert.match(source, /:show-center-play-btn="false"/);
  assert.match(source, /:enable-progress-gesture="false"/);
  assert.match(source, /@fullscreenchange="onVideoFullscreenChange"/);
  assert.match(source, /class="fullscreen-speed-overlay"/);
  assert.match(source, /v-for="rate in playbackRates"/);
  assert.match(source, /@tap\.stop="setPlaybackRate\(rate\)"/);
  assert.match(source, /playbackRates:\s*REPLAY_PLAYBACK_RATES/);
  assert.match(source, /playbackRate:\s*1/);
  assert.match(source, /context\.playbackRate\(this\.playbackRate\)/);
  assert.match(source, /this\.displayCurrentSec \+ this\.playbackRate/);
  assert.match(source, /<cover-view class="fullscreen-progress-overlay" :class="\{ 'is-visible': videoFullscreen && currentRecord \}"/);
  assert.match(source, /class="fullscreen-progress-row"[\s\S]*@touchstart\.stop="onFullscreenProgressTouchStart"[\s\S]*@touchmove\.stop="onFullscreenProgressTouchMove"[\s\S]*@touchend\.stop="onFullscreenProgressTouchEnd"/);
  assert.match(source, /fullscreen-progress-rail/);
  assert.match(source, /progress-marker-layer/);
  assert.match(source, /progress-marker-segment/);
  assert.match(source, /progress-marker-arrow/);
  assert.match(source, /fullscreen-marker-layer/);
  assert.match(source, /fullscreen-marker-segment/);
  assert.match(source, /fullscreen-marker-arrow/);
  assert.match(source, /markerSegments\(\)/);
  assert.match(source, /markerArrows\(\)/);
  assert.match(source, /:style="segment\.style"/);
  assert.match(source, /:style="marker\.style"/);
  assert.match(source, /:class="'is-' \+ segment\.target"/);
  assert.match(source, /:class="'is-' \+ marker\.target"/);
  assert.match(source, /target:\s*segment\.target/);
  assert.match(source, /progress-marker-segment\.is-feeding/);
  assert.match(source, /fullscreen-marker-segment\.is-feeding/);
  assert.doesNotMatch(source, /:style="segmentStyle\(segment\)"/);
  assert.doesNotMatch(source, /:style="markerStyle\(marker\)"/);
  assert.doesNotMatch(source, /:key="['"][^'"]*['"]\s*\+/);
  assert.doesNotMatch(source, /fs-marker/);
  assert.match(source, /seekToMarker\(markerIndex\)/);
  assert.doesNotMatch(source, /seekToMarker\(marker\)/);
  assert.match(source, /REPLAY_MARKER_CONTEXT_SEC\s*=\s*1/);
  const displayOffsetMatch = source.match(/function markerDisplayOffsetSec\(marker, durationSec\) \{([\s\S]*?)\n\t\}/);
  assert.ok(displayOffsetMatch, "replay page should display enter markers before and leave markers after the raw detection time");
  assert.match(displayOffsetMatch[1], /const rawOffsetSec = markerOffsetSec\(marker\)/);
  assert.match(displayOffsetMatch[1], /rawOffsetSec \+ REPLAY_MARKER_CONTEXT_SEC/);
  assert.match(displayOffsetMatch[1], /rawOffsetSec - REPLAY_MARKER_CONTEXT_SEC/);
  assert.match(displayOffsetMatch[1], /return clampDisplayOffsetSec\(displayOffsetSec, durationSec\)/);
  assert.match(source, /function markerSegmentDisplay\(segment, durationSec\)/);
  const segmentDisplayMatch = source.match(/function markerSegmentDisplay\(segment, durationSec\) \{([\s\S]*?)\n\t\}/);
  assert.ok(segmentDisplayMatch, "replay page should align highlighted marker segments with displayed marker arrows");
  assert.match(segmentDisplayMatch[1], /const displayStartSec = clampDisplayOffsetSec\(rawStartSec - REPLAY_MARKER_CONTEXT_SEC,\s*durationSec\)/);
  assert.match(segmentDisplayMatch[1], /const displayEndSec = Math\.max\(displayStartSec,\s*clampDisplayOffsetSec\(rawEndSec \+ REPLAY_MARKER_CONTEXT_SEC,\s*durationSec\)\)/);
  assert.match(segmentDisplayMatch[1], /progressPercentFromOffset\(displayEndSec,\s*durationSec\)/);
  assert.doesNotMatch(segmentDisplayMatch[1], /progressPercentFromOffset\(rawEndSec,\s*durationSec\)/);
  assert.match(source, /displayStartSec/);
  assert.match(source, /displayEndSec/);
  assert.match(source, /this\.markerSegments\.flatMap/);
  assert.match(source, /seekSec:\s*segment\.displayStartSec/);
  assert.match(source, /seekSec:\s*segment\.displayEndSec/);
  assert.match(source, /seekToSec\(Number\(marker\.seekSec\)\)/);
  assert.doesNotMatch(source, /shouldShowMarkerArrow/);
  assert.doesNotMatch(source, /seekToSec\(markerDisplayOffsetSec\(marker,\s*this\.playbackDurationSec\)\)/);
  assert.doesNotMatch(source, /seekToSec\(markerOffsetSec\(marker\)\)/);
  assert.doesNotMatch(source, /markerOffsetSec\(marker\)\s*-\s*2/);
  assert.doesNotMatch(source, /callBackend\(['"]\/api\/feed-analysis\/sync['"]/);
  assert.doesNotMatch(source, /force:\s*true/);
  assert.match(source, /callBackend\(['"]\/api\/feed-analysis\/markers['"]/);
  assert.match(source, /attachReplayMarkers\(this\.recordList,\s*res\.markers\s*\|\|\s*\[\],\s*res\.analysisStatus\s*\|\|\s*\[\]\)/);
  assert.match(source, /v-if="item\.analysisLabel"/);
  assert.match(source, /'is-'\s*\+\s*item\.analysisTone/);
  assert.match(source, /analysis-status-pill/);
  assert.match(source, /analysis-status-dot/);
  assert.doesNotMatch(source, /callDemoData\(['"]syncFeedAnalysis['"]/);
  assert.doesNotMatch(source, /callDemoData\(['"]getReplayMarkers['"]/);
  assert.doesNotMatch(source, /fullscreen-progress-overlay" v-if/);
  assert.doesNotMatch(source, /fullscreen-control|toggleReplayPause/);
  assert.match(source, /videoFullscreen/);
  assert.match(source, /onVideoFullscreenChange\(e\)/);
  assert.match(source, /this\.videoFullscreen[\s\S]*this\.applyPlaybackRate\(\)/);
  assert.match(source, /updateFullscreenProgressFromTouch\(e\)/);
  assert.match(source, /seekToSec\(targetSec, rollbackSec\)/);
  assert.doesNotMatch(source, /replayFullscreen|is-page-fullscreen|toggleReplayFullscreen/);
  assert.match(source, /@play="onVideoPlay"/);
  assert.match(source, /@pause="onVideoPause"/);
  const playMatch = source.match(/onVideoPlay\(\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(playMatch, "replay page should define onVideoPlay");
  assert.match(playMatch[1], /startProgressTicker/);
  const waitingMatch = source.match(/onVideoWaiting\(\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(waitingMatch, "replay page should define onVideoWaiting");
  assert.match(waitingMatch[1], /HLS can keep rendering frames while still reporting waiting/);
  assert.doesNotMatch(waitingMatch[1], /this\.hlsPlaying\s*=\s*false/);
  assert.doesNotMatch(waitingMatch[1], /this\.stopProgressTicker\(\)/);
  assert.doesNotMatch(waitingMatch[1], /setTimeout|HLS_WAITING_CONFIRM_MS|confirmHlsWaiting/);
  assert.match(source, /@timeupdate="onVideoTimeUpdate"/);
  const timeUpdateMatch = source.match(/onVideoTimeUpdate\(e\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(timeUpdateMatch, "replay page should define onVideoTimeUpdate");
  assert.match(timeUpdateMatch[1], /this\.hlsPlaying\s*=\s*true/);
  assert.match(timeUpdateMatch[1], /if \(!this\.progressTimer\) this\.startProgressTicker\(\)/);
  assert.match(timeUpdateMatch[1], /if \(currentTime > 0\)/);
  assert.match(timeUpdateMatch[1], /this\.displayCurrentSec\s*=\s*Math\.min\(this\.playbackDurationSec,\s*this\.hlsBaseSec\s*\+\s*currentTime\)/);
  assert.doesNotMatch(source, /confirmHlsWaiting|HLS_WAITING_CONFIRM_MS|hlsWaitingTimer|lastHlsMediaSec|lastHlsMediaAtMs/);
  assert.match(source, /<text class="record-time">时长: \{\{displayDuration\(item\)\}\}<\/text>/);
  assert.doesNotMatch(source, /displayDuration\(item\)\}\}\s*分钟/);
  assert.match(source, /formatDurationLabel/);
  assert.match(source, /displayDuration\(item\) \{[\s\S]*return formatDurationLabel\(this\.calcDurationSec\(item\)\)/);
  assert.doesNotMatch(source, /calcDurationSec\(item\)\)\s*\+\s*['"]秒['"]/);
  assert.match(source, /hlsBaseSec/);
  assert.match(source, /hlsPlaying/);
  assert.match(source, /playbackEnded/);
  assert.match(source, /playbackFailed/);
  assert.match(source, /replayCurrentRecord/);
  assert.match(source, /retryCurrentRecord/);
  assert.match(source, /<video[\s\S]*v-if="playbackType === 'hls' && !playbackEnded && !playbackFailed"/);
  assert.match(source, /<\/video>\s*[\r\n]+\s*<view class="replay-ended-screen" v-if="playbackEnded && currentRecord" @click="replayCurrentRecord">/);
  assert.match(source, /<view class="replay-ended-screen" v-if="playbackFailed && currentRecord" @click="retryCurrentRecord">/);
  assert.match(source, /<view class="replay-ended-button">重试<\/view>/);
  assert.doesNotMatch(source, /<cover-view class="replay-ended-overlay"/);
  assert.match(source, /startHlsFallback\(item, params = \{\}, options = \{\}\)/);
  assert.match(source, /lanHost:\s*this\.device\.ip\s*\|\|\s*this\.device\.devIp\s*\|\|\s*this\.device\.ipAddress\s*\|\|\s*['"]['"]/);
  assert.match(source, /if \(!options\.keepCurrentVideo\) this\.playUrl = ''/);
  assert.match(source, /pauseReplayVideo\(\)/);
  assert.doesNotMatch(source, /buffer-spinner|video-buffer-mask/);
  const endedMatch = source.match(/onVideoEnded\(\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(endedMatch, "replay page should define onVideoEnded");
  assert.match(endedMatch[1], /this\.playUrl\s*=\s*''/);
  assert.match(endedMatch[1], /this\.streamUrl\s*=\s*''/);
  const videoErrorMatch = source.match(/onVideoError\(e\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(videoErrorMatch, "replay page should define onVideoError");
  assert.match(videoErrorMatch[1], /this\.playbackFailed\s*=\s*true/);
  assert.match(videoErrorMatch[1], /this\.playUrl\s*=\s*''/);
  assert.match(videoErrorMatch[1], /this\.streamUrl\s*=\s*''/);
  assert.match(source, /async onVideoError\(e\)/);
  const hlsFallbackMatch = source.match(/async startHlsFallback\(item, params = \{\}, options = \{\}\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(hlsFallbackMatch, "replay page should define startHlsFallback");
  assert.match(hlsFallbackMatch[1], /catch \(error\) \{[\s\S]*this\.playbackFailed\s*=\s*true/);
  assert.match(hlsFallbackMatch[1], /catch \(error\) \{[\s\S]*this\.playUrl\s*=\s*''/);
  assert.match(hlsFallbackMatch[1], /catch \(error\) \{[\s\S]*this\.streamUrl\s*=\s*''/);
  const seekMatch = source.match(/async seekToSec\(targetSec, rollbackSec = this\.displayCurrentSec\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(seekMatch, "replay page should define seekToSec");
  assert.match(seekMatch[1], /\/api\/replay-sessions\/['"]\s*\+\s*encodeURIComponent\(this\.sessionId\)\s*\+\s*['"]\/seek/);
  assert.match(seekMatch[1], /result\.playUrl/);
  assert.match(seekMatch[1], /this\.hlsSeekRequestId/);
  assert.doesNotMatch(seekMatch[1], /closeReplaySession\(\)/);
  assert.doesNotMatch(seekMatch[1], /startHlsFallback\(/);
  assert.match(seekMatch[1], /catch \(error\) \{[\s\S]*this\.displayCurrentSec\s*=\s*previousSec/);
  assert.match(seekMatch[1], /catch \(error\) \{[\s\S]*targetSec:\s*previousSec/);
  assert.match(seekMatch[1], /catch \(error\) \{[\s\S]*this\.playReplayVideo\(\)/);
  assert.match(source, /if \(!this\.progressDragging\) this\.progressBeforeDragSec = this\.displayCurrentSec/);
  assert.match(source, /await this\.seekToSec\(targetSec, rollbackSec\)/);
  assert.match(source, /<cover-view class="seek-loading-overlay" v-if="hlsSeeking">/);
  assert.match(source, /<cover-view class="seek-loading-plate">[\s\S]*<cover-view class="seek-loading-rotor" :style="seekSpinnerStyle">[\s\S]*<cover-image class="seek-loading-spinner" src="\/static\/images\/replay-loading-spinner\.png"><\/cover-image>/);
  const seekSpinnerAsset = path.join(__dirname, "..", "static", "images", "replay-loading-spinner.png");
  assert.equal(fs.existsSync(seekSpinnerAsset), true, "replay seek spinner PNG should be packaged");
  assert.equal(fs.readFileSync(seekSpinnerAsset).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.match(source, /\.seek-loading-plate\s*\{[\s\S]*width:\s*58px[\s\S]*background:\s*rgba\(0\s*,\s*0\s*,\s*0\s*,\s*(?:0?\.58)\)/);
  assert.doesNotMatch(source, /@keyframes seek-loading-spin|animation:\s*seek-loading-spin/);
  assert.match(source, /seekSpinnerStyle\(\)\s*\{[\s\S]*transform 900ms linear/);
  assert.match(source, /hlsSeeking\(active\)\s*\{[\s\S]*startSeekSpinner\(\)[\s\S]*stopSeekSpinner\(\)/);
  assert.match(source, /setInterval\([\s\S]*seekSpinnerRotationDeg\s*\+=\s*360[\s\S]*850\)/);
  assert.match(source, /onUnload\(\)\s*\{[\s\S]*stopSeekSpinner\(\)/);
  const seekSpinnerStyle = source.match(/\.seek-loading-spinner\s*\{([^}]*)\}/);
  assert.ok(seekSpinnerStyle, "replay page should style the seek loading spinner");
  assert.match(seekSpinnerStyle[1], /width:\s*50px/);
  assert.doesNotMatch(seekSpinnerStyle[1], /animation:/);
  assert.doesNotMatch(seekSpinnerStyle[1], /conic-gradient|-webkit-mask|radial-gradient/);
  assert.doesNotMatch(seekSpinnerStyle[1], /border:/);
  assert.doesNotMatch(seekSpinnerStyle[1], /#10b981/);
  const videoPlayMatch = source.match(/onVideoPlay\(\) \{([\s\S]*?)\n\t\t\t\},/);
  assert.ok(videoPlayMatch, "replay page should define onVideoPlay");
  assert.match(videoPlayMatch[1], /this\.hlsSeeking\s*=\s*false/);
  assert.match(source, /<view class="video-area" v-if="streamUrl \|\| playUrl \|\| playbackEnded \|\| playbackFailed">/);
  assert.match(source, /\.video-area \{[\s\S]*position:\s*sticky/);
  assert.match(source, /\.video-area \{[\s\S]*top:\s*0/);
  assert.match(source, /\.video-area \{[\s\S]*z-index:\s*10/);
  assert.match(source, /replay-ended-screen[\s\S]*height:\s*420rpx[\s\S]*background:\s*#000/);
  assert.doesNotMatch(source, /startProgressTicker\(\) \{[\s\S]*if \(this\.playbackType === 'hls'\) return/);
  assert.match(source, /startProgressTicker\(\) \{[\s\S]*this\.playbackType === 'hls' && \(!this\.hlsPlaying \|\| this\.hlsSeeking \|\| this\.playbackEnded \|\| this\.playbackFailed\)/);
  assert.doesNotMatch(source, /password:\s*this\.device\.password|adminToken:\s*this\.device\.adminToken/);
});

test("pages/live/replay.vue keeps marker arrows easier to tap than the progress thumb", () => {
  const source = readWorkspaceFile("pages/live/replay.vue");

  assert.match(source, /block-color="transparent"/);
  assert.match(source, /block-size="8"/);
  assert.match(source, /progress-marker-arrow-head/);
  assert.match(source, /fullscreen-marker-arrow-head/);
  assert.match(source, /\.progress-marker-layer\s*\{[^}]*left:\s*0;[^}]*right:\s*0;/);
  assert.match(source, /class="progress-marker-arrow"[\s\S]*@tap\.stop="seekToMarker\(markerIndex\)"/);
  assert.match(source, /\.progress-marker-arrow\s*\{[^}]*width:\s*72rpx;[^}]*height:\s*72rpx;/);
  assert.match(source, /\.progress-marker-arrow-head\s*\{[^}]*border-left:\s*16rpx solid transparent;[^}]*border-right:\s*16rpx solid transparent;[^}]*border-top:\s*28rpx solid #E8734A;/);
  assert.match(source, /\.fullscreen-marker-arrow\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/);
  assert.match(source, /\.fullscreen-marker-arrow-head\s*\{[^}]*border-left:\s*9px solid transparent;[^}]*border-right:\s*9px solid transparent;[^}]*border-top:\s*15px solid #E8734A;/);
  assert.match(source, /\.fullscreen-progress-thumb\s*\{[^}]*width:\s*3px;[^}]*height:\s*3px;/);
});
