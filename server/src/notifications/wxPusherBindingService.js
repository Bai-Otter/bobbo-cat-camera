const crypto = require("node:crypto");

function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function previewUid(uidValue) {
  const uid = cleanText(uidValue, 128);
  return uid.length > 12 ? `${uid.slice(0, 7)}...${uid.slice(-4)}` : uid;
}

class WxPusherBindingService {
  constructor({
    store,
    wxPusherService,
    challengeProvider = () => crypto.randomBytes(24).toString("base64url"),
    now = Date.now,
    challengeTtlSeconds = 1800,
    callbackConfigured = true,
  } = {}) {
    this.store = store;
    this.wxPusherService = wxPusherService;
    this.challengeProvider = challengeProvider;
    this.now = now;
    this.challengeTtlSeconds = Math.max(60, Math.min(30 * 24 * 60 * 60, Number(challengeTtlSeconds) || 1800));
    this.callbackConfigured = callbackConfigured !== false;
  }

  isConfigured() {
    return this.callbackConfigured && !!this.wxPusherService?.isConfigured?.();
  }

  getBindingStatus(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) throw new Error("OPENID_REQUIRED");
    const binding = this.store.getWxPusherBinding(openid);
    return {
      configured: this.isConfigured(),
      bound: !!(binding && binding.status === "active"),
      status: binding && binding.status || "not_bound",
      uidPreview: binding && binding.status === "active" ? previewUid(binding.uid) : "",
      boundAt: Number(binding && binding.boundAt) || 0,
    };
  }

  async createChallenge(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) throw new Error("OPENID_REQUIRED");
    if (!this.isConfigured()) throw new Error("WXPUSHER_NOT_CONFIGURED");
    const challenge = cleanText(this.challengeProvider(), 64);
    if (!challenge) throw new Error("WXPUSHER_CHALLENGE_INVALID");
    const now = Number(this.now()) || Date.now();
    const expiresAt = now + this.challengeTtlSeconds * 1000;
    this.store.saveWxPusherBindingChallenge({ openid, challenge, expiresAt });
    try {
      const qr = await this.wxPusherService.createBindingQrcode(challenge, this.challengeTtlSeconds);
      this.store.saveWxPusherBindingChallenge({
        openid,
        challenge,
        expiresAt,
        qrCodeUrl: qr.qrCodeUrl,
        followUrl: qr.followUrl,
      });
      return {
        configured: true,
        bound: false,
        challenge,
        expiresAt,
        qrCodeUrl: qr.qrCodeUrl,
        followUrl: qr.followUrl,
      };
    } catch (error) {
      this.store.expireWxPusherBindingChallenge(challenge);
      throw error;
    }
  }

  getQrSourceUrl(challengeValue) {
    const challenge = this.store.getActiveWxPusherBindingChallenge(challengeValue, Number(this.now()) || Date.now());
    return cleanText(challenge && challenge.qrCodeUrl, 1024);
  }

  handleCallback(payload = {}) {
    if (payload.action !== "app_subscribe") return { ok: true, ignored: true };
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const appId = cleanText(data.appId, 64);
    const uid = cleanText(data.uid, 128);
    const challenge = cleanText(data.extra, 64);
    if (appId !== cleanText(this.wxPusherService && this.wxPusherService.appId, 64)) {
      return { ok: false, error: "WXPUSHER_APP_ID_INVALID" };
    }
    if (!/^UID_[A-Za-z0-9_-]{4,120}$/.test(uid) || !challenge) {
      return { ok: false, error: "WXPUSHER_CALLBACK_INVALID" };
    }
    const binding = this.store.completeWxPusherBindingChallenge({
      challenge,
      uid,
      now: Number(this.now()) || Date.now(),
    });
    if (!binding) return { ok: false, error: "WXPUSHER_CHALLENGE_INVALID" };
    return { ok: true, binding: { bound: true, status: binding.status } };
  }

  removeBinding(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) throw new Error("OPENID_REQUIRED");
    this.store.disableWxPusherBinding(openid);
    return this.getBindingStatus(openid);
  }
}

module.exports = { WxPusherBindingService, previewUid };
