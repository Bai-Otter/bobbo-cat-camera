const test = require("node:test");
const assert = require("node:assert/strict");

const { PushPlusNotifier } = require("./pushPlusNotifier");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("PushPlusNotifier skips delivery when no server token is configured", async () => {
  let fetchCalled = false;
  const notifier = new PushPlusNotifier({
    token: "",
    fetchImpl: async () => {
      fetchCalled = true;
      return jsonResponse({ code: 200 });
    },
  });

  const result = await notifier.sendFeedingNotification({ eventId: "event-1" });

  assert.deepEqual(result, {
    ok: false,
    skipped: true,
    reason: "PUSHPLUS_NOT_CONFIGURED",
  });
  assert.equal(fetchCalled, false);
  assert.equal(notifier.getStatus().configured, false);
});

test("PushPlusNotifier sends a private text-only feeding notification", async () => {
  const requests = [];
  const notifier = new PushPlusNotifier({
    token: "server-secret-token",
    endpoint: "https://pushplus.example/send",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ code: 200, msg: "accepted", data: "message-123" });
    },
  });

  const result = await notifier.sendFeedingNotification({
    eventId: "alarm-1__feeding_start",
    friendToken: "friend-token-1",
    message: "14:39 \u68c0\u6d4b\u5230\u732b\u54aa\u5f00\u59cb\u8fdb\u98df",
    deviceSn: "SN<001>",
    startTime: "2026-07-15 14:39:10",
    snapshotUrl: "https://private.example/alarm.jpg",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "pending");
  assert.equal(result.messageId, "message-123");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://pushplus.example/send");
  assert.equal(requests[0].options.method, "POST");
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(
    {
      token: payload.token,
      title: payload.title,
      template: payload.template,
      channel: payload.channel,
      to: payload.to,
    },
    {
      token: "server-secret-token",
      title: "\u732b\u54aa\u6765\u5403\u996d\u4e86",
      template: "html",
      channel: "wechat",
      to: "friend-token-1",
    }
  );
  assert.match(payload.content, /14:39/);
  assert.match(payload.content, /SN&lt;001&gt;/);
  assert.doesNotMatch(payload.content, /private\.example|alarm\.jpg/);
  assert.equal(notifier.getStatus().status, "accepted");
});

test("PushPlusNotifier rejects accepted responses without a provider message id", async () => {
  const notifier = new PushPlusNotifier({
    token: "server-secret-token",
    fetchImpl: async () => jsonResponse({ code: 200, msg: "accepted", data: "" }),
  });
  await assert.rejects(
    () => notifier.sendFeedingNotification({ friendToken: "friend-token-1", message: "test" }),
    /PUSHPLUS_MESSAGE_ID_MISSING/
  );
});

test("PushPlusNotifier reports provider rejection without exposing its token", async () => {
  const notifier = new PushPlusNotifier({
    token: "do-not-leak",
    fetchImpl: async () => jsonResponse({ code: 903, msg: "invalid token do-not-leak" }),
  });

  const error = await notifier
    .sendFeedingNotification({ eventId: "event-2" })
    .then(() => null, (caught) => caught);

  assert.match(error.message, /PUSHPLUS_REJECTED: invalid token \[redacted\]/);
  assert.doesNotMatch(error.message, /do-not-leak/);
  const status = notifier.getStatus();
  assert.equal(status.status, "error");
  assert.doesNotMatch(JSON.stringify(status), /do-not-leak/);
});

test("PushPlusNotifier aborts a stalled provider request", async () => {
  const notifier = new PushPlusNotifier({
    token: "configured",
    timeoutMs: 5,
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });

  await assert.rejects(
    notifier.sendFeedingNotification({ eventId: "event-timeout" }),
    /PUSHPLUS_TIMEOUT/
  );
  assert.equal(notifier.getStatus().status, "error");
});
