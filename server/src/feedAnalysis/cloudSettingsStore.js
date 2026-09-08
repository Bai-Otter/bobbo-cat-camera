function clean(document = {}) {
  const source = (
    !document.deviceSn &&
    !document.openid &&
    document.data &&
    typeof document.data === "object" &&
    !Array.isArray(document.data)
  ) ? document.data : document;
  const value = { ...source };
  delete value._id;
  return value;
}

async function findExisting(collection, field, value) {
  const direct = await collection.where({ [field]: value }).limit(1).get();
  const directItem = Array.isArray(direct?.data) ? direct.data[0] : null;
  if (directItem) return directItem;
  const all = await collection.get();
  return (Array.isArray(all?.data) ? all.data : [])
    .find((item) => clean(item)[field] === value) || null;
}

class CloudFeedAnalysisSettingsStore {
  constructor({
    database,
    collectionName = "feed_analysis_states",
    bindingCollectionName = "pushplus_bindings",
  } = {}) {
    if (!database) throw new Error("CLOUDBASE_DATABASE_REQUIRED");
    this.database = database;
    this.collectionName = collectionName;
    this.collection = database.collection(collectionName);
    this.bindingCollectionName = bindingCollectionName;
    this.bindingCollection = database.collection(bindingCollectionName);
  }

  async initialize() {
    try {
      await this.database.createCollection(this.collectionName);
    } catch (error) {
      if (error?.code !== "DATABASE_COLLECTION_ALREADY_EXIST") throw error;
    }
    try {
      await this.database.createCollection(this.bindingCollectionName);
    } catch (error) {
      if (error?.code !== "DATABASE_COLLECTION_ALREADY_EXIST") throw error;
    }
  }

  async loadAll() {
    const result = await this.collection.get();
    return (Array.isArray(result?.data) ? result.data : [])
      .map(clean)
      .filter((item) => item && item.deviceSn);
  }

  async upsert(settings = {}) {
    const deviceSn = String(settings.deviceSn || "").trim();
    if (!deviceSn) throw new Error("DEVICE_SN_REQUIRED");
    const existing = await findExisting(this.collection, "deviceSn", deviceSn);
    const data = { ...clean(settings), deviceSn, updatedAt: Date.now() };
    if (existing?._id) await this.collection.doc(existing._id).set(data);
    else await this.collection.add(data);
    return data;
  }

  async loadBindings() {
    const result = await this.bindingCollection.get();
    return (Array.isArray(result?.data) ? result.data : [])
      .map(clean)
      .filter((item) => item && item.openid && item.friendToken);
  }

  async upsertBinding(binding = {}) {
    const openid = String(binding.openid || "").trim();
    if (!openid) throw new Error("OPENID_REQUIRED");
    const existing = await findExisting(this.bindingCollection, "openid", openid);
    const data = { ...clean(binding), openid, updatedAt: Date.now() };
    if (existing?._id) await this.bindingCollection.doc(existing._id).set(data);
    else await this.bindingCollection.add(data);
    return data;
  }
}

module.exports = { CloudFeedAnalysisSettingsStore };
