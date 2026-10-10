import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import type { State } from "./model.js";
import { migrateV1ToV2, rollbackV2Migration, type MigrationOptions } from "./migrations/v1-to-v2.js";
const empty = (): State => ({ users: {}, runs: {}, localMemories: {} });
export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private pool?: pg.Pool;
  constructor(
    private file: string,
    databaseUrl?: string,
  ) {
    if (databaseUrl) this.pool = new pg.Pool({ connectionString: databaseUrl });
  }
  async init() {
    if (this.pool)
      await this.pool.query(
        "CREATE TABLE IF NOT EXISTS dfm_state (id integer PRIMARY KEY CHECK(id=1), body jsonb NOT NULL)",
      );
  }
  async transact<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
    const action = this.tail.then(async () => {
      if (this.pool) {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(8798001)");
          const result = await client.query(
            "SELECT body FROM dfm_state WHERE id=1",
          );
          const state: State = result.rows[0]?.body ?? empty();
          const answer = await fn(state);
          await client.query(
            "INSERT INTO dfm_state VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET body=$1",
            [JSON.stringify(state)],
          );
          await client.query("COMMIT");
          return answer;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      let state: State;
      try {
        state = JSON.parse(await readFile(this.file, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        state = empty();
      }
      const answer = await fn(state);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + ".tmp", JSON.stringify(state));
      await rename(this.file + ".tmp", this.file);
      return answer;
    });
    this.tail = action.catch(() => {});
    return action;
  }
  async close() {
    await this.tail;
    await this.pool?.end();
  }
  /** Explicit opt-in only; init and imports do not migrate persisted state. */
  async migrateToV2(options: MigrationOptions = {}) {
    return this.transact(state => {
      const migrated = migrateV1ToV2(state, options);
      state.memoryV2 = migrated.memoryV2;
      return migrated.memoryV2!;
    });
  }
  async rollbackV2() {
    return this.transact(state => {
      const original = rollbackV2Migration(state);
      for (const key of Object.keys(state)) delete (state as unknown as Record<string,unknown>)[key];
      Object.assign(state, original);
    });
  }
}
