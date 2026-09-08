function errorText(error) {
  if (!error) return "";
  return [error.code, error.errCode, error.message, error.errMsg]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();
}

function isCollectionMissing(error) {
  const text = errorText(error);
  return (
    text.includes("-502005") ||
    text.includes("database collection not exist") ||
    text.includes("db or table not exist")
  );
}

function isCollectionAlreadyExists(error) {
  const text = errorText(error);
  return (
    text.includes("already exist") ||
    text.includes("collection_already_exist")
  );
}

async function withCollection(database, name, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isCollectionMissing(error)) throw error;
  }

  try {
    await database.createCollection(name);
  } catch (error) {
    if (!isCollectionAlreadyExists(error)) throw error;
  }

  return operation();
}

module.exports = {
  isCollectionMissing,
  withCollection,
};
