const { test } = require("node:test");
const assert = require("node:assert/strict");
const { usageMetadataSql, legacyBeforeSql } = require("../src/lib/fork-zcode-metadata");
let DatabaseSync; try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
test("metadata SQL preserves counter/dedup inputs without sorting full message bodies", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE message(data TEXT, time_created INTEGER)");
    const data = { id: "m", sessionID: "s", role: "assistant", model: { id: "glm-5", providerID: "custom" },
      tokens: { input: 30, output: 9, reasoning: 2, cache: { read: 10, write: 5 } },
      time: { created: 1790000000000, completed: 1790000000500 }, path: { cwd: "/fixture" },
      parts: [{ text: "private payload".repeat(20000) }], content: "PRIVATE_CONTENT",
    };
    db.prepare("INSERT INTO message VALUES (?, 1)").run(JSON.stringify(data));
    const projected = JSON.parse(db.prepare(`SELECT ${usageMetadataSql("data")} AS data FROM message ORDER BY time_created`).get().data);
    for (const key of ["id", "sessionID", "role", "model", "tokens", "time", "path"]) assert.deepEqual(projected[key], data[key]);
    assert.ok(JSON.stringify(projected).length < 1000);
    assert.equal(JSON.stringify(projected).includes("PRIVATE_CONTENT"), false);
    assert.equal(projected.parts, undefined);
  } finally { db.close(); }
  assert.throws(() => usageMetadataSql("untrusted"));
});
test("legacy cutoff conservatively preserves the upstream timestamp boundary", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE message(id TEXT, time_updated)");
    const before = 1790000000000;
    for (const [id, value] of [["seconds", before / 1000 - 1], ["milliseconds", before - 1],
      ["at-boundary", before], ["newer-seconds", before / 1000 + 1], ["unusual-text", String(before - 1)], ["missing", null]])
      db.prepare("INSERT INTO message VALUES (?, ?)").run(id, value);
    assert.deepEqual(db.prepare(`SELECT id FROM message WHERE 1 ${legacyBeforeSql("time_updated", before)}`).all().map((r) => r.id),
      ["seconds", "milliseconds", "unusual-text", "missing"]);
  } finally { db.close(); }
});
