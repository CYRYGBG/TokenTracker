// Keep the upstream reader/normalization/dedup pipeline. Only its SQL payload
// changes: never copy message bodies into the sort or a child-process pipe.
const FIELDS = [
  "id", "messageID", "messageId", "sessionID", "sessionId", "session_id",
  "role", "modelID", "modelId", "model", "providerID", "providerId", "provider",
  "tokens", "time", "path",
];
function usageMetadataSql(column) {
  if (!["data", "sm.data"].includes(column)) throw new Error("Invalid metadata column");
  return `json_object(${FIELDS.map((key) => `'${key}', json_extract(${column}, '$.${key}')`).join(", ")})`;
}
function legacyBeforeSql(column, beforeMs) {
  if (!["time_updated", "sm.time_updated"].includes(column)) throw new Error("Invalid timestamp column");
  if (!Number.isSafeInteger(beforeMs) || beforeMs <= 0) return "";
  // Push down only numeric timestamps; unusual text encodings remain for the
  // upstream JS coerce/filter. Both second and millisecond epochs are valid.
  return ` AND (typeof(${column}) NOT IN ('integer','real') OR ` +
    `(CASE WHEN ${column} < 1000000000000 THEN ${column} * 1000 ELSE ${column} END) < ${beforeMs})`;
}
module.exports = { usageMetadataSql, legacyBeforeSql };
