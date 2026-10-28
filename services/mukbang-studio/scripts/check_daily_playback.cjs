"use strict";
// Read-only real-browser smoke check. Explicit local runtime paths; no install.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, all) => i % 2 ? rows : [...rows, [value.replace(/^--/, ""), all[i + 1]]], []));
const { chromium } = require(args.playwright);
(async () => {
  const url = new URL(args.url);
  assert.equal(url.hostname, "127.0.0.1", "Only loopback previews may be checked");
  const jobId = url.searchParams.get("job"); assert.match(jobId || "", /^[0-9a-f]{12}$/);
  const output = path.resolve(args.output); fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: args.browser, headless: true });
  const errors = [], writes = [], checks = [];
  try {
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/*", (route) => {
        if (route.request().method() !== "GET") { writes.push(route.request().method()); return route.abort(); }
        return route.continue();
      });
      await page.goto(url.href, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelectorAll("video").length === 2 && Array.from(document.querySelectorAll("video")).every((v) => v.readyState >= 1), undefined, { timeout: 30000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Horizontal overflow");
      assert.equal(await page.locator("#story-output video").count(), 1);
      assert.match(await page.locator("#story-output").innerText(), /原声＋内心独白字幕/);
      await page.screenshot({ path: path.join(output, `daily-${viewport.width}.png`), fullPage: true });
      if (viewport.width === 390) await page.screenshot({ path: path.join(output, "daily-mobile-viewport.png") });
      for (const selector of ["#story-output", "#eating-output"]) {
        await page.locator(`${selector} .play-button`).click();
        await page.waitForFunction((sel) => document.querySelector(`${sel} video`).currentTime > .1, selector);
        const state = await page.locator(`${selector} video`).evaluate((v) => {
          const state = { currentTime: v.currentTime, duration: v.duration, error: v.error?.code || null, fit: getComputedStyle(v).objectFit };
          v.pause(); return state;
        });
        assert.equal(state.error, null); assert.equal(state.fit, "contain");
        checks.push({ width: viewport.width, selector, ...state });
      }
      await page.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ checks, errors, attemptedNonGetRequests: writes, screenshots: output }, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
