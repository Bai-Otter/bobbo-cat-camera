const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LOCAL_LEGACY_OWNER = "__legacy_local__";
const DEFAULT_MAX_MEMBERS = 5;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function pickText(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function normalizeProfile(profile = {}, fallback = {}, ownerOpenid = "") {
  const sn = cleanText(profile.sn || fallback.sn, 128);
  if (!sn) return null;
  const createdAt = Number(profile.createdAt || fallback.createdAt) || Date.now();
  return {
    sn,
    ownerOpenid: cleanText(profile.ownerOpenid || fallback.ownerOpenid || ownerOpenid, 128),
    nickname: cleanText(profile.nickname || fallback.nickname || "Cat camera", 80),
    username: cleanText(profile.username || profile.userName || fallback.username || "admin", 80),
    password: pickText(profile.password ?? profile.passWord ?? profile.devicePassword, fallback.password || ""),
    ip: cleanText(profile.ip || profile.devIp || profile.ipAddress || fallback.ip || "", 128),
    port: cleanText(profile.port || profile.devicePort || fallback.port || "", 32),
    primaryCatId: cleanText(profile.primaryCatId || fallback.primaryCatId, 128),
    createdAt,
    updatedAt: Date.now(),
  };
}

function cloneProfile(profile) {
  return profile ? { ...profile } : null;
}

function cleanOwner(value) {
  return cleanText(value, 128);
}

function buildCatRef(ownerOpenidValue, catIdValue) {
  const ownerOpenid = cleanOwner(ownerOpenidValue);
  const catId = cleanText(catIdValue, 128);
  if (!ownerOpenid || !catId) return "";
  return `cat_${crypto.createHash("sha256").update(`${ownerOpenid}:${catId}`).digest("hex").slice(0, 24)}`;
}

function normalizeMember(member = {}) {
  const openid = cleanOwner(member.openid);
  return openid ? { openid, joinedAt: Number(member.joinedAt) || Date.now() } : null;
}

function normalizeInvite(invite = {}) {
  const id = cleanText(invite.id, 128);
  const deviceSn = cleanText(invite.deviceSn, 128);
  const ownerOpenid = cleanOwner(invite.ownerOpenid);
  const tokenHash = cleanText(invite.tokenHash, 128);
  if (!id || !deviceSn || !ownerOpenid || !tokenHash) return null;
  return {
    id,
    deviceSn,
    ownerOpenid,
    tokenHash,
    createdAt: Number(invite.createdAt) || Date.now(),
    expiresAt: Number(invite.expiresAt) || 0,
    usedAt: Number(invite.usedAt) || 0,
    usedBy: cleanOwner(invite.usedBy),
    cancelledAt: Number(invite.cancelledAt) || 0,
  };
}

function normalizeCatProfile(cat = {}, ownerOpenidValue = "") {
  const id = cleanText(cat.id, 128);
  const ownerOpenid = cleanOwner(cat.ownerOpenid || ownerOpenidValue);
  const name = cleanText(cat.name, 40);
  if (!id || !ownerOpenid || !name) return null;
  return {
    id,
    ownerOpenid,
    name,
    birthday: cleanText(cat.birthday, 16),
    age: cleanText(cat.age, 40),
    breed: cleanText(cat.breed, 80),
    sex: cleanText(cat.sex, 20),
    health: cleanText(cat.health, 240),
    avatar: cleanText(cat.avatar, 2048),
    createdAt: Number(cat.createdAt) || Date.now(),
    updatedAt: Number(cat.updatedAt) || Date.now(),
  };
}

class DeviceRegistry {
  constructor(options = {}) {
    this.filePath = options.filePath || "";
    this.store = options.store || null;
    this.legacyOwnerOpenid = cleanOwner(options.legacyOwnerOpenid);
    this.requireLegacyOwner = !!options.requireLegacyOwner;
    this.maxMembersPerDevice = Math.max(1, Number(options.maxMembersPerDevice) || DEFAULT_MAX_MEMBERS);
    this.defaultProfile = normalizeProfile(
      options.defaultProfile,
      {},
      this.legacyOwnerOpenid
    );
    this.state = this.loadFileState();
    this.initialized = false;
  }

  defaultState() {
    const devices = this.defaultProfile ? [cloneProfile(this.defaultProfile)] : [];
    const owner = this.defaultProfile && this.defaultProfile.ownerOpenid;
    return {
      version: 3,
      activeByOwner: owner ? { [owner]: this.defaultProfile.sn } : {},
      activeSn: this.defaultProfile ? this.defaultProfile.sn : "",
      devices,
      membersBySn: {},
      shareInvites: [],
      cats: [],
    };
  }

  normalizeState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const devices = Array.isArray(source.devices)
      ? source.devices.map((item) => normalizeProfile(item, {}, this.legacyOwnerOpenid)).filter(Boolean)
      : [];
    const state = {
      version: 3,
      activeByOwner: source.activeByOwner && typeof source.activeByOwner === "object"
        ? { ...source.activeByOwner }
        : {},
      activeSn: cleanText(source.activeSn, 128),
      devices,
      membersBySn: {},
      shareInvites: Array.isArray(source.shareInvites)
        ? source.shareInvites.map(normalizeInvite).filter(Boolean)
        : [],
      cats: Array.isArray(source.cats)
        ? source.cats.map((cat) => normalizeCatProfile(cat)).filter(Boolean)
        : [],
    };
    const rawMembers = source.membersBySn && typeof source.membersBySn === "object"
      ? source.membersBySn
      : {};
    for (const [snValue, members] of Object.entries(rawMembers)) {
      const sn = cleanText(snValue, 128);
      if (!sn || !Array.isArray(members)) continue;
      const seen = new Set();
      state.membersBySn[sn] = members
        .map(normalizeMember)
        .filter((member) => member && !seen.has(member.openid) && seen.add(member.openid));
    }

    // The environment profile is a first-install seed only. Once a registry file
    // exists, its device list is authoritative; otherwise an intentionally
    // removed legacy camera would be resurrected on every backend restart.
    for (const profile of state.devices) {
      if (
        this.legacyOwnerOpenid &&
        (!profile.ownerOpenid || profile.ownerOpenid === LOCAL_LEGACY_OWNER)
      ) {
        profile.ownerOpenid = this.legacyOwnerOpenid;
      }
    }
    if (state.activeSn && this.legacyOwnerOpenid && !state.activeByOwner[this.legacyOwnerOpenid]) {
      state.activeByOwner[this.legacyOwnerOpenid] = state.activeSn;
    }
    if (this.legacyOwnerOpenid) delete state.activeByOwner[LOCAL_LEGACY_OWNER];
    for (const profile of state.devices) {
      if (profile.ownerOpenid && !state.activeByOwner[profile.ownerOpenid]) {
        state.activeByOwner[profile.ownerOpenid] = profile.sn;
      }
      for (const member of state.membersBySn[profile.sn] || []) {
        if (!state.activeByOwner[member.openid]) state.activeByOwner[member.openid] = profile.sn;
      }
    }
    if (!state.activeSn || !state.devices.some((item) => item.sn === state.activeSn)) {
      state.activeSn = state.devices[0] ? state.devices[0].sn : "";
    }
    return state;
  }

  loadFileState() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        return this.normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      } catch (error) {
        return this.defaultState();
      }
    }
    return this.defaultState();
  }

  assertLegacyOwnership() {
    if (
      this.requireLegacyOwner &&
      !this.legacyOwnerOpenid &&
      this.state.devices.some((item) => !item.ownerOpenid)
    ) {
      throw new Error("LEGACY_DEVICE_OWNER_REQUIRED");
    }
  }

  async initialize() {
    if (this.store) {
      const stored = await this.store.load();
      if (stored && Array.isArray(stored.devices) && stored.devices.length) {
        this.state = this.normalizeState(stored);
      }
    }
    this.assertLegacyOwnership();
    if (!this.requireLegacyOwner) {
      for (const profile of this.state.devices) {
        if (!profile.ownerOpenid) profile.ownerOpenid = this.legacyOwnerOpenid || LOCAL_LEGACY_OWNER;
      }
      if (this.state.activeSn && !this.state.activeByOwner[LOCAL_LEGACY_OWNER] && !this.legacyOwnerOpenid) {
        this.state.activeByOwner[LOCAL_LEGACY_OWNER] = this.state.activeSn;
      }
    }
    await this.saveAsync();
    this.initialized = true;
    return this;
  }

  save() {
    if (!this.filePath || this.store) return;
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  async saveAsync() {
    if (this.store) {
      await this.store.save(this.state);
      return;
    }
    this.save();
  }

  reload() {
    this.state = this.loadFileState();
  }

  resetForTests({ clearStore = false } = {}) {
    if (clearStore && this.filePath && fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    this.reload();
  }

  has(sn) {
    const target = cleanText(sn, 128);
    return !!target && this.state.devices.some((item) => item.sn === target);
  }

  getActiveSn() {
    return this.state.activeSn;
  }

  get(sn = this.state.activeSn) {
    const target = cleanText(sn, 128);
    return cloneProfile(this.state.devices.find((item) => item.sn === target));
  }

  list() {
    const activeSn = this.state.activeSn;
    return this.state.devices
      .slice()
      .sort((a, b) => {
        if (a.sn === activeSn) return -1;
        if (b.sn === activeSn) return 1;
        return Number(a.createdAt || 0) - Number(b.createdAt || 0);
      })
      .map(cloneProfile);
  }

  upsert(profile, { active = false } = {}) {
    const existing = this.get(profile && profile.sn);
    const ownerOpenid = existing && existing.ownerOpenid || this.legacyOwnerOpenid || LOCAL_LEGACY_OWNER;
    const normalized = normalizeProfile(profile, existing || {}, ownerOpenid);
    if (!normalized) throw new Error("DEVICE_SN_REQUIRED");
    if (existing) normalized.createdAt = existing.createdAt;
    this.state.devices = this.state.devices.filter((item) => item.sn !== normalized.sn);
    this.state.devices.push(normalized);
    if (active) {
      this.state.activeSn = normalized.sn;
      this.state.activeByOwner[ownerOpenid] = normalized.sn;
    }
    if (!this.state.activeSn) this.state.activeSn = normalized.sn;
    this.save();
    return cloneProfile(normalized);
  }

  async listForOwner(ownerOpenid) {
    const owner = cleanOwner(ownerOpenid);
    const activeSn = this.state.activeByOwner[owner] || "";
    return this.state.devices
      .filter((item) => item.ownerOpenid === owner)
      .sort((a, b) => {
        if (a.sn === activeSn) return -1;
        if (b.sn === activeSn) return 1;
        return Number(a.createdAt || 0) - Number(b.createdAt || 0);
      })
      .map(cloneProfile);
  }

  resolvePrimaryCatId(profile) {
    const explicit = cleanText(profile && profile.primaryCatId, 128);
    if (explicit && this.state.cats.some((cat) => (
      cat.ownerOpenid === profile.ownerOpenid && cat.id === explicit
    ))) return explicit;
    const fallback = this.state.cats.find((cat) => cat.ownerOpenid === profile.ownerOpenid);
    return fallback ? fallback.id : "";
  }

  async listAccessible(openidValue) {
    const openid = cleanOwner(openidValue);
    const activeSn = this.state.activeByOwner[openid] || "";
    return this.state.devices
      .map((profile) => {
        const primaryCatId = this.resolvePrimaryCatId(profile);
        if (profile.ownerOpenid === openid) {
          return {
            ...cloneProfile(profile),
            role: "owner",
            primaryCatId,
            primaryCatRef: buildCatRef(profile.ownerOpenid, primaryCatId),
          };
        }
        const member = (this.state.membersBySn[profile.sn] || []).find((item) => item.openid === openid);
        return member ? {
          ...cloneProfile(profile),
          role: "member",
          joinedAt: member.joinedAt,
          primaryCatId,
          primaryCatRef: buildCatRef(profile.ownerOpenid, primaryCatId),
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.sn === activeSn) return -1;
        if (b.sn === activeSn) return 1;
        return Number(a.createdAt || a.joinedAt || 0) - Number(b.createdAt || b.joinedAt || 0);
      });
  }

  async listAll() {
    return this.state.devices.map(cloneProfile);
  }

  async getForOwner(sn, ownerOpenid) {
    const profile = this.get(sn);
    return profile && profile.ownerOpenid === cleanOwner(ownerOpenid) ? profile : null;
  }

  async getAccessible(sn, openidValue) {
    const profile = this.get(sn);
    const openid = cleanOwner(openidValue);
    if (!profile || !openid) return null;
    const primaryCatId = this.resolvePrimaryCatId(profile);
    if (profile.ownerOpenid === openid) {
      return {
        ...profile,
        role: "owner",
        primaryCatId,
        primaryCatRef: buildCatRef(profile.ownerOpenid, primaryCatId),
      };
    }
    const member = (this.state.membersBySn[profile.sn] || []).find((item) => item.openid === openid);
    return member ? {
      ...profile,
      role: "member",
      joinedAt: member.joinedAt,
      primaryCatId,
      primaryCatRef: buildCatRef(profile.ownerOpenid, primaryCatId),
    } : null;
  }

  async listCatsForUser(openidValue) {
    const openid = cleanOwner(openidValue);
    const owned = this.state.cats
      .filter((cat) => cat.ownerOpenid === openid)
      .map((cat) => ({
        ...cat,
        catRef: buildCatRef(cat.ownerOpenid, cat.id),
        readOnly: false,
        source: "owned",
        sourceDeviceSns: [],
      }));
    const sharedByRef = new Map();
    for (const profile of await this.listAccessible(openid)) {
      const primaryCatId = this.resolvePrimaryCatId(profile);
      if (profile.role !== "member" || !primaryCatId) continue;
      const cat = this.state.cats.find((item) => (
        item.ownerOpenid === profile.ownerOpenid && item.id === primaryCatId
      ));
      if (!cat) continue;
      const catRef = buildCatRef(cat.ownerOpenid, cat.id);
      const current = sharedByRef.get(catRef) || {
        ...cat,
        catRef,
        readOnly: true,
        source: "shared",
        sourceDeviceSns: [],
      };
      if (!current.sourceDeviceSns.includes(profile.sn)) current.sourceDeviceSns.push(profile.sn);
      sharedByRef.set(catRef, current);
    }
    return owned.concat([...sharedByRef.values()]);
  }

  async upsertCatForOwner(ownerOpenidValue, input = {}) {
    const ownerOpenid = cleanOwner(ownerOpenidValue);
    const requestedId = cleanText(input.id, 128);
    const existing = this.state.cats.find((cat) => cat.id === requestedId && cat.ownerOpenid === ownerOpenid);
    const now = Date.now();
    const normalized = normalizeCatProfile({
      ...(existing || {}),
      ...input,
      id: requestedId || `cat_${now}`,
      ownerOpenid,
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
    }, ownerOpenid);
    if (!normalized) throw new Error("CAT_PROFILE_INVALID");
    this.state.cats = this.state.cats.filter((cat) => !(cat.id === normalized.id && cat.ownerOpenid === ownerOpenid));
    this.state.cats.push(normalized);
    await this.saveAsync();
    return { ...normalized, readOnly: false };
  }

  async deleteCatForOwner(ownerOpenidValue, catIdValue) {
    const ownerOpenid = cleanOwner(ownerOpenidValue);
    const catId = cleanText(catIdValue, 128);
    const existing = this.state.cats.find((cat) => cat.id === catId && cat.ownerOpenid === ownerOpenid);
    if (!existing) return null;
    this.state.cats = this.state.cats.filter((cat) => !(cat.id === catId && cat.ownerOpenid === ownerOpenid));
    for (const profile of this.state.devices) {
      if (profile.ownerOpenid === ownerOpenid && profile.primaryCatId === catId) profile.primaryCatId = "";
    }
    await this.saveAsync();
    return { ...existing };
  }

  async assignPrimaryCat(snValue, ownerOpenidValue, catIdValue) {
    const sn = cleanText(snValue, 128);
    const ownerOpenid = cleanOwner(ownerOpenidValue);
    const catId = cleanText(catIdValue, 128);
    const profile = this.state.devices.find((item) => item.sn === sn && item.ownerOpenid === ownerOpenid);
    if (!profile) throw new Error("DEVICE_NOT_FOUND");
    if (catId && !this.state.cats.some((cat) => cat.id === catId && cat.ownerOpenid === ownerOpenid)) {
      throw new Error("CAT_PROFILE_NOT_FOUND");
    }
    profile.primaryCatId = catId;
    profile.updatedAt = Date.now();
    await this.saveAsync();
    return cloneProfile(profile);
  }

  async getBySn(sn) {
    return this.get(sn);
  }

  async getActiveSnForOwner(ownerOpenid) {
    return this.state.activeByOwner[cleanOwner(ownerOpenid)] || "";
  }

  async getActiveSnForUser(openidValue) {
    const openid = cleanOwner(openidValue);
    const activeSn = this.state.activeByOwner[openid] || "";
    if (activeSn && await this.getAccessible(activeSn, openid)) return activeSn;
    const first = (await this.listAccessible(openid))[0];
    return first ? first.sn : "";
  }

  async createShareInvite(snValue, ownerOpenidValue, input = {}) {
    const sn = cleanText(snValue, 128);
    const ownerOpenid = cleanOwner(ownerOpenidValue);
    if (!await this.getForOwner(sn, ownerOpenid)) throw new Error("DEVICE_NOT_FOUND");
    const tokenHash = cleanText(input.tokenHash, 128);
    if (!tokenHash) throw new Error("SHARE_INVITE_TOKEN_REQUIRED");
    const now = Number(input.now) || Date.now();
    const expiresAt = Number(input.expiresAt) || 0;
    if (expiresAt <= now) throw new Error("SHARE_INVITE_EXPIRY_INVALID");
    const invite = normalizeInvite({
      id: input.id || `invite_${tokenHash.slice(0, 24)}`,
      deviceSn: sn,
      ownerOpenid,
      tokenHash,
      createdAt: now,
      expiresAt,
    });
    this.state.shareInvites = this.state.shareInvites.filter((item) => item.id !== invite.id);
    this.state.shareInvites.push(invite);
    await this.saveAsync();
    return { ...invite };
  }

  async redeemShareInvite(tokenHashValue, openidValue, input = {}) {
    const tokenHash = cleanText(tokenHashValue, 128);
    const openid = cleanOwner(openidValue);
    const now = Number(input.now) || Date.now();
    const invite = this.state.shareInvites.find((item) => item.tokenHash === tokenHash);
    if (!invite) throw new Error("SHARE_INVITE_NOT_FOUND");
    if (invite.cancelledAt) throw new Error("SHARE_INVITE_CANCELLED");
    if (invite.usedAt) {
      const existingAccess = invite.usedBy === openid
        ? await this.getAccessible(invite.deviceSn, openid)
        : null;
      if (existingAccess && existingAccess.role === "member") return existingAccess;
      throw new Error("SHARE_INVITE_USED");
    }
    if (!invite.expiresAt || invite.expiresAt < now) throw new Error("SHARE_INVITE_EXPIRED");
    if (invite.ownerOpenid === openid) throw new Error("SHARE_INVITE_OWNER_CANNOT_REDEEM");
    const members = this.state.membersBySn[invite.deviceSn] || [];
    if (!members.some((member) => member.openid === openid)) {
      if (members.length >= this.maxMembersPerDevice) throw new Error("DEVICE_MEMBER_LIMIT_REACHED");
      members.push({ openid, joinedAt: now });
      this.state.membersBySn[invite.deviceSn] = members;
    }
    invite.usedAt = now;
    invite.usedBy = openid;
    if (!this.state.activeByOwner[openid]) this.state.activeByOwner[openid] = invite.deviceSn;
    await this.saveAsync();
    return this.getAccessible(invite.deviceSn, openid);
  }

  async listMembers(snValue, ownerOpenidValue) {
    const sn = cleanText(snValue, 128);
    if (!await this.getForOwner(sn, ownerOpenidValue)) throw new Error("DEVICE_NOT_FOUND");
    return (this.state.membersBySn[sn] || []).map((member) => ({ ...member }));
  }

  async listShareInvites(snValue, ownerOpenidValue, nowValue = Date.now()) {
    const sn = cleanText(snValue, 128);
    if (!await this.getForOwner(sn, ownerOpenidValue)) throw new Error("DEVICE_NOT_FOUND");
    const now = Number(nowValue) || Date.now();
    return this.state.shareInvites
      .filter((invite) => invite.deviceSn === sn && !invite.usedAt && !invite.cancelledAt && invite.expiresAt >= now)
      .map((invite) => ({ ...invite }));
  }

  async cancelShareInvite(inviteIdValue, ownerOpenidValue, nowValue = Date.now()) {
    const inviteId = cleanText(inviteIdValue, 128);
    const ownerOpenid = cleanOwner(ownerOpenidValue);
    const invite = this.state.shareInvites.find((item) => item.id === inviteId && item.ownerOpenid === ownerOpenid);
    if (!invite) return null;
    if (!invite.usedAt) invite.cancelledAt = Number(nowValue) || Date.now();
    await this.saveAsync();
    return { ...invite };
  }

  async revokeMember(snValue, ownerOpenidValue, memberOpenidValue) {
    const sn = cleanText(snValue, 128);
    const memberOpenid = cleanOwner(memberOpenidValue);
    if (!await this.getForOwner(sn, ownerOpenidValue)) throw new Error("DEVICE_NOT_FOUND");
    const members = this.state.membersBySn[sn] || [];
    const existing = members.find((member) => member.openid === memberOpenid);
    if (!existing) return null;
    this.state.membersBySn[sn] = members.filter((member) => member.openid !== memberOpenid);
    if (this.state.activeByOwner[memberOpenid] === sn) delete this.state.activeByOwner[memberOpenid];
    await this.saveAsync();
    return { ...existing };
  }

  async leaveSharedDevice(snValue, memberOpenidValue) {
    const sn = cleanText(snValue, 128);
    const memberOpenid = cleanOwner(memberOpenidValue);
    const profile = this.get(sn);
    if (!profile || profile.ownerOpenid === memberOpenid) return null;
    const members = this.state.membersBySn[sn] || [];
    const existing = members.find((member) => member.openid === memberOpenid);
    if (!existing) return null;
    this.state.membersBySn[sn] = members.filter((member) => member.openid !== memberOpenid);
    if (this.state.activeByOwner[memberOpenid] === sn) delete this.state.activeByOwner[memberOpenid];
    await this.saveAsync();
    return { ...existing };
  }

  async upsertForOwner(profile, ownerOpenid, { active = false } = {}) {
    const owner = cleanOwner(ownerOpenid);
    if (!owner) throw new Error("DEVICE_OWNER_REQUIRED");
    const existing = this.get(profile && profile.sn);
    if (existing && existing.ownerOpenid && existing.ownerOpenid !== owner) {
      throw new Error("DEVICE_ALREADY_OWNED");
    }
    const normalized = normalizeProfile(profile, existing || {}, owner);
    if (!normalized) throw new Error("DEVICE_SN_REQUIRED");
    normalized.ownerOpenid = owner;
    if (existing) normalized.createdAt = existing.createdAt;
    this.state.devices = this.state.devices.filter((item) => item.sn !== normalized.sn);
    this.state.devices.push(normalized);
    if (active || !this.state.activeByOwner[owner]) this.state.activeByOwner[owner] = normalized.sn;
    this.state.activeSn = this.state.activeByOwner[owner];
    await this.saveAsync();
    return cloneProfile(normalized);
  }

  async renameForOwner(snValue, ownerOpenidValue, nicknameValue) {
    const sn = cleanText(snValue, 128);
    const ownerOpenid = cleanOwner(ownerOpenidValue);
    const nickname = String(nicknameValue || "").trim();
    if (!nickname) throw new Error("DEVICE_NICKNAME_REQUIRED");
    if (nickname.length > 80) throw new Error("DEVICE_NICKNAME_TOO_LONG");
    const existing = this.state.devices.find(
      (item) => item.sn === sn && item.ownerOpenid === ownerOpenid
    );
    if (!existing) return null;

    const renamed = {
      ...existing,
      nickname,
      updatedAt: Date.now(),
    };
    this.state.devices = this.state.devices.map((item) => (
      item.sn === sn ? renamed : item
    ));
    await this.saveAsync();
    return cloneProfile(renamed);
  }

  async removeForOwner(sn, ownerOpenid) {
    const target = cleanText(sn, 128);
    const owner = cleanOwner(ownerOpenid);
    const existing = this.state.devices.find(
      (item) => item.sn === target && item.ownerOpenid === owner
    );
    if (!existing) return null;

    this.state.devices = this.state.devices.filter((item) => item.sn !== target);
    const removedMembers = this.state.membersBySn[target] || [];
    delete this.state.membersBySn[target];
    this.state.shareInvites = this.state.shareInvites.filter((invite) => invite.deviceSn !== target);
    for (const member of removedMembers) {
      if (this.state.activeByOwner[member.openid] === target) delete this.state.activeByOwner[member.openid];
    }
    const nextOwned = this.state.devices.find((item) => item.ownerOpenid === owner) || null;
    if (this.state.activeByOwner[owner] === target) {
      if (nextOwned) this.state.activeByOwner[owner] = nextOwned.sn;
      else delete this.state.activeByOwner[owner];
    }
    if (
      this.state.activeSn === target ||
      !this.state.devices.some((item) => item.sn === this.state.activeSn)
    ) {
      this.state.activeSn = this.state.activeByOwner[owner]
        || (this.state.devices[0] && this.state.devices[0].sn)
        || "";
    }
    await this.saveAsync();
    return cloneProfile(existing);
  }
}

module.exports = { DeviceRegistry, LOCAL_LEGACY_OWNER, buildCatRef };
