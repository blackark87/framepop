import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
export const id = () => randomUUID();
export class Store {
  constructor(dir) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(dir, "framepop.sqlite"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT,data TEXT);`,
    );
  }
  get(kind, id) {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  list(kind) {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((r) => JSON.parse(r.data));
  }
  put(kind, id, data) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(data));
    return data;
  }
  remove(kind, id) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  event(job, data) {
    const record = { ...data, at: new Date().toISOString() };
    const r = this.db
      .prepare("INSERT INTO events(job,data) VALUES(?,?)")
      .run(job, JSON.stringify(record));
    return { seq: Number(r.lastInsertRowid), ...record };
  }
  events(job, after = 0) {
    return this.db
      .prepare(
        "SELECT seq,data FROM events WHERE job=? AND seq>? ORDER BY seq LIMIT 1000",
      )
      .all(job, after)
      .map((r) => ({ seq: r.seq, ...JSON.parse(r.data) }));
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
export const defaults = () => ({
  connections: [],
  primary: null,
  assignmentMode: "auto",
  roles: {},
  enhancementInstruction: "",
  comfy: {
    connectionId: null,
    model: null,
    loras: [],
    imageLoras: [],
    textEncoder: null,
    vae: null,
    audioVae: null,
  },
  qc: {
    minSimilarity: 0.363,
    minSharpness: 35,
    maxBadFraction: 0.03,
    allowNoFace: false,
  },
  revision: 1,
});
