const crypto = require("crypto");

function deviceDocumentId(sn) {
  return `device_${crypto.createHash("sha256").update(String(sn || "")).digest("hex")}`;
}

const SHARING_DOCUMENT_ID = "device_sharing_state";

function cleanDocument(document = {}) {
  const source = (
    !document.sn &&
    document.data &&
    typeof document.data === "object" &&
    !Array.isArray(document.data)
  ) ? document.data : document;
  const copy = { ...source };
  delete copy._id;
  return copy;
}

class CloudDeviceRegistryStore {
  constructor({ database, collectionName = "cat_device_registry" } = {}) {
    if (!database) throw new Error("CLOUDBASE_DATABASE_REQUIRED");
    this.collection = database.collection(collectionName);
  }

  async load() {
    const result = await this.collection.get();
    const documents = Array.isArray(result && result.data) ? result.data : [];
    const cleanedDocuments = documents.map(cleanDocument);
    const devices = cleanedDocuments.filter((item) => item && item.sn);
    const sharingIndex = documents.findIndex((item) => item && item._id === SHARING_DOCUMENT_ID);
    const sharing = sharingIndex >= 0 ? cleanedDocuments[sharingIndex] : {};
    const activeByOwner = {};
    for (const profile of devices) {
      if (profile.ownerOpenid && profile.active) activeByOwner[profile.ownerOpenid] = profile.sn;
    }
    return {
      version: 3,
      activeByOwner: { ...activeByOwner, ...(sharing.activeByOwner || {}) },
      devices,
      membersBySn: sharing.membersBySn || {},
      shareInvites: Array.isArray(sharing.shareInvites) ? sharing.shareInvites : [],
      cats: Array.isArray(sharing.cats) ? sharing.cats : [],
    };
  }

  async save(state = {}) {
    const devices = Array.isArray(state.devices) ? state.devices : [];
    const activeByOwner = state.activeByOwner || {};
    for (const profile of devices) {
      const id = deviceDocumentId(profile.sn);
      const existingResult = await this.collection.doc(id).get();
      const existing = Array.isArray(existingResult && existingResult.data)
        ? cleanDocument(existingResult.data[0])
        : null;
      if (
        existing &&
        existing.ownerOpenid &&
        existing.ownerOpenid !== profile.ownerOpenid
      ) {
        throw new Error("DEVICE_ALREADY_OWNED");
      }
      await this.collection.doc(id).set({
        ...cleanDocument(profile),
        active: activeByOwner[profile.ownerOpenid] === profile.sn,
      });
    }
    await this.collection.doc(SHARING_DOCUMENT_ID).set({
      data: {
        version: 3,
        activeByOwner,
        membersBySn: state.membersBySn || {},
        shareInvites: Array.isArray(state.shareInvites) ? state.shareInvites : [],
        cats: Array.isArray(state.cats) ? state.cats : [],
      },
    });
  }
}

function buildCloudbaseInitOptions({ envId, secretId, secretKey } = {}) {
  return {
    ...(envId ? { env: envId } : {}),
    ...(secretId && secretKey ? { secretId, secretKey } : {}),
  };
}

function createCloudDeviceRegistryStore({ envId, collectionName, secretId, secretKey } = {}) {
  const cloudbase = require("@cloudbase/node-sdk");
  const app = cloudbase.init(buildCloudbaseInitOptions({ envId, secretId, secretKey }));
  return new CloudDeviceRegistryStore({ database: app.database(), collectionName });
}

module.exports = {
  CloudDeviceRegistryStore,
  buildCloudbaseInitOptions,
  createCloudDeviceRegistryStore,
  deviceDocumentId,
};
