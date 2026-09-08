const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WechatDeviceMessageService,
  normalizeMiniProgramState,
} = require("./wechatDeviceMessageService");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("WeChat device message service caches stable tokens and uses the documented payloads", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body || "{}") });
    if (String(url).endsWith("/cgi-bin/stable_token")) {
      return response({ access_token: "stable-token", expires_in: 7200 });
    }
    if (String(url).includes("/wxa/getsnticket")) {
      return response({ errcode: 0, errmsg: "ok", sn_ticket: "ticket-1" });
    }
    return response({ errcode: 0, errmsg: "ok" });
  };
  const service = new WechatDeviceMessageService({
    appId: "wx-test",
    appSecret: "secret-test",
    modelId: "model-1",
    startTemplateId: "tmpl-start",
    endTemplateId: "tmpl-end",
    miniProgramState: "trial",
    fetchImpl,
    now: () => 1_000_000,
  });

  assert.equal(service.isConfigured(), true);
  assert.deepEqual(service.getTemplateIds(), ["tmpl-start", "tmpl-end"]);
  assert.deepEqual(await service.getSnTicket("SN_001"), {
    sn: "SN_001",
    snTicket: "ticket-1",
    modelId: "model-1",
    tmplIds: ["tmpl-start", "tmpl-end"],
    expiresAt: 1_300_000,
  });
  await service.send({
    openid: "openid-owner",
    sn: "SN_001",
    templateId: "tmpl-start",
    page: "pages/today/index?deviceSn=SN_001",
    data: { status1: { value: "开始进食" } },
  });

  assert.equal(calls.filter((call) => call.url.endsWith("/cgi-bin/stable_token")).length, 1);
  assert.deepEqual(calls[1].body, { sn: "SN_001", model_id: "model-1" });
  assert.deepEqual(calls[2].body, {
    to_openid_list: ["openid-owner"],
    sn: "SN_001",
    template_id: "tmpl-start",
    page: "pages/today/index?deviceSn=SN_001",
    miniprogram_state: "trial",
    modelId: "model-1",
    data: { status1: { value: "开始进食" } },
    lang: "zh_CN",
  });
});

test("WeChat device message service refreshes an invalid access token once", async () => {
  let tokenCalls = 0;
  let sendCalls = 0;
  const service = new WechatDeviceMessageService({
    appId: "wx-test",
    appSecret: "secret-test",
    modelId: "model-1",
    startTemplateId: "tmpl-start",
    endTemplateId: "tmpl-end",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/cgi-bin/stable_token")) {
        tokenCalls += 1;
        return response({ access_token: `token-${tokenCalls}`, expires_in: 7200 });
      }
      sendCalls += 1;
      return response(sendCalls === 1
        ? { errcode: 40001, errmsg: "invalid credential" }
        : { errcode: 0, errmsg: "ok" });
    },
  });

  const result = await service.send({
    openid: "openid-owner",
    sn: "SN001",
    templateId: "tmpl-start",
    data: {},
  });

  assert.equal(result.ok, true);
  assert.equal(tokenCalls, 2);
  assert.equal(sendCalls, 2);
});

test("mini program state uses the hardware-message names", () => {
  assert.equal(normalizeMiniProgramState("develop"), "developer");
  assert.equal(normalizeMiniProgramState("release"), "formal");
  assert.equal(normalizeMiniProgramState("trial"), "trial");
  assert.equal(normalizeMiniProgramState("unknown"), "formal");
});

test("hardware notifications are configured only after both feeding templates exist", () => {
  const base = {
    appId: "appid",
    appSecret: "secret",
    modelId: "model-1",
    startTemplateId: "tmpl-start",
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  };
  assert.equal(new WechatDeviceMessageService(base).isConfigured(), false);
  assert.equal(new WechatDeviceMessageService({ ...base, endTemplateId: "tmpl-end" }).isConfigured(), true);
});
