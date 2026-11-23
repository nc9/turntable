import { Database } from "bun:sqlite";
import { applyMigrations, type Migration } from "../../src/db/migrate";

// Child of migration-concurrent.test.ts: opens the file, waits for the shared start time so both
// children hit the migration lock together, applies, and prints the tags it applied as JSON.
const [path, startAt, count] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4])];
const list: Migration[] = Array.from({ length: count }, (_, i) => ({
  tag: `${String(i).padStart(4, "0")}_t${i}`,
  when: i + 1,
  statements: [`CREATE TABLE t${i} (id INTEGER)`],
}));
const db = new Database(path, { create: true, strict: true });
db.run("PRAGMA busy_timeout = 30000");
while (Date.now() < startAt) {}
console.log(JSON.stringify(applyMigrations(db, list)));
db.close();
