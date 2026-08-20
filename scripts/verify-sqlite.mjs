import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("usage: node verify-sqlite.mjs <database.sqlite>");
  process.exit(2);
}

const databasePath = path.resolve(input);
let database;
try {
  database = new DatabaseSync(databasePath, { readOnly: true });
  const integrity = database.prepare("PRAGMA integrity_check").get();
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (integrity.integrity_check !== "ok" || foreignKeys.length > 0) {
    console.error("failed");
    process.exitCode = 1;
  } else {
    console.log("ok");
  }
} catch {
  console.error("failed");
  process.exitCode = 1;
} finally {
  database?.close();
}
