import type Database from 'better-sqlite3';

export type SchemaMigration = {
  version: number;
  name: string;
  up(db: Database.Database): void;
};

/** Applies numbered schema migrations as one SQLite transaction. */
export function runMigrations(db: Database.Database, migrations: SchemaMigration[]): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  if (ordered.some((migration, index) => index > 0 && migration.version === ordered[index - 1].version)) {
    throw new Error('Schema migration versions must be unique.');
  }

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version));
  const pending = ordered.filter((migration) => !applied.has(migration.version));
  if (!pending.length) return;

  const apply = db.transaction(() => {
    const record = db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)');
    for (const migration of pending) {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    }
  });
  apply();
}

export const legacySchemaMigration: SchemaMigration = {
  version: 1,
  name: 'phase-one-snapshots',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generations (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, node_count INTEGER NOT NULL, edge_count INTEGER NOT NULL, FOREIGN KEY(workspace_id) REFERENCES workspaces(id));
      CREATE TABLE IF NOT EXISTS active_generations (workspace_id TEXT PRIMARY KEY, generation_id INTEGER NOT NULL, FOREIGN KEY(generation_id) REFERENCES generations(id));
      CREATE TABLE IF NOT EXISTS nodes (generation_id INTEGER NOT NULL, id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, properties_json TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(generation_id, id));
      CREATE TABLE IF NOT EXISTS edges (generation_id INTEGER NOT NULL, id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL, properties_json TEXT NOT NULL, PRIMARY KEY(generation_id, id));
      CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT NOT NULL, message TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT);
    `);
  },
};
