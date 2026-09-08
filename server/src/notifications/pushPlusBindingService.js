const crypto = require("node:crypto");

class PushPlusBindingService {
  constructor({
    store,
    openApi,
    serviceQrUrl = "https://image.pushplus.plus/pc/image/pushplus_mp.jpg",
    codeProvider = () => crypto.randomUUID().replace(/-/g, ""),
    nowProvider = () => Date.now(),
    qrLifetimeSeconds = 2_592_000,
  } = {}) {
    this.store = store;
    this.openApi = openApi;
    this.serviceQrUrl = serviceQrUrl;
    this.codeProvider = codeProvider;
    this.nowProvider = nowProvider;
    this.qrLifetimeSeconds = qrLifetimeSeconds;
    this.qrSources = new Map();
  }

  isConfigured() {
    return !!(this.openApi && this.openApi.isConfigured());
  }

  getFriendToken(openid) {
    const binding = this.store && this.store.getPushPlusBinding(openid);
    return binding && binding.status !== "disabled" && binding.isFollow
      ? String(binding.friendToken || "").trim()
      : "";
  }

  async getBindingStatus(openid) {
    const userId = String(openid || "").trim();
    if (!userId) throw new Error("OPENID_REQUIRED");
    const configured = this.isConfigured();
    const binding = this.store.getPushPlusBinding(userId);
    if (binding && binding.friendToken && binding.status !== "disabled" && binding.isFollow) {
      return { configured, bound: true, isFollow: !!binding.isFollow };
    }
    if (!configured) return { configured: false, bound: false };

    const now = Number(this.nowProvider()) || Date.now();
    let challenge = this.store.getActivePushPlusBindingChallenge(userId, now);
    if (!challenge) {
      const code = String(this.codeProvider() || "").trim();
      const qr = await this.openApi.getFriendQrCode({
        content: code,
        second: this.qrLifetimeSeconds,
        scanCount: 1,
      });
      challenge = this.store.savePushPlusBindingChallenge({
        openid: userId,
        code,
        qrCodeUrl: qr.qrCodeImgUrl,
        expiresAt: now + this.qrLifetimeSeconds * 1000,
      });
    }
    this.qrSources.set(challenge.code, challenge.qrCodeUrl);
    return {
      configured: true,
      bound: false,
      friendQrCode: challenge.code,
      expiresAt: challenge.expiresAt,
    };
  }

  getServiceQrSourceUrl() {
    return this.serviceQrUrl;
  }

  getFriendQrSourceUrl(code) {
    const bindingCode = String(code || "").trim();
    if (this.qrSources.has(bindingCode)) return this.qrSources.get(bindingCode);
    const challenge = this.store && typeof this.store.getPushPlusBindingChallengeByCode === "function"
      ? this.store.getPushPlusBindingChallengeByCode(bindingCode, Number(this.nowProvider()) || Date.now())
      : null;
    return String((challenge && challenge.qrCodeUrl) || "");
  }

  handleCallback(payload = {}) {
    if (payload.event !== "add_friend") return { ok: true, ignored: true };
    const code = String(payload.qrCode || "").trim();
    const friendInfo = payload.friendInfo || {};
    if (!code) return { ok: true, ignored: true };
    if (!friendInfo.token) return { ok: false, error: "INVALID_ADD_FRIEND_CALLBACK" };
    if (Number(friendInfo.isFollow) !== 1) {
      return { ok: false, error: "PUSHPLUS_WECHAT_FOLLOW_REQUIRED" };
    }
    const binding = this.store.completePushPlusBinding(code, friendInfo);
    if (!binding) return { ok: false, error: "PUSHPLUS_BINDING_CODE_INVALID" };
    this.qrSources.delete(code);
    return { ok: true };
  }

  removeBinding(openid) {
    const userId = String(openid || "").trim();
    if (!userId) throw new Error("OPENID_REQUIRED");
    const removed = !!this.store?.disablePushPlusBinding?.(userId);
    return { configured: this.isConfigured(), bound: false, status: removed ? "disabled" : "not_bound" };
  }
}

module.exports = { PushPlusBindingService };
