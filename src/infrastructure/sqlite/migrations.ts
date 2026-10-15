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

  const apply = db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version));
    const pending = ordered.filter((migration) => !applied.has(migration.version));
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

/** Migrates Phase 1 snapshots into analyzer-owned, independently activatable generations. */
export const analyzerOwnedGenerationsMigration: SchemaMigration = {
  version: 2,
  name: 'analyzer-owned-generations',
  up(db) {
    db.exec(`
      CREATE TABLE plugin_installations (
        analyzer_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        api_version TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
      CREATE TABLE analysis_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        analyzer_id TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        status TEXT NOT NULL,
        source_revision TEXT,
        config_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE analysis_generations (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        analyzer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES analysis_runs(id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE active_analysis_generations (
        workspace_id TEXT NOT NULL,
        analyzer_id TEXT NOT NULL,
        generation_id INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, analyzer_id),
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id)
      );
      CREATE TABLE node_contributions (
        generation_id INTEGER NOT NULL,
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        PRIMARY KEY(generation_id, id),
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id)
      );
      CREATE TABLE edge_contributions (
        generation_id INTEGER NOT NULL,
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        PRIMARY KEY(generation_id, id),
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id)
      );
      CREATE TABLE evidence (
        generation_id INTEGER NOT NULL,
        id TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(generation_id, id),
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id)
      );
      CREATE TABLE diagnostics (
        id INTEGER PRIMARY KEY,
        generation_id INTEGER NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id)
      );

      INSERT INTO plugin_installations(analyzer_id,version,api_version,capabilities_json,installed_at)
      SELECT 'builtin.demo', '1.0.0', '1', '["graph","evidence"]', datetime('now')
      WHERE EXISTS (SELECT 1 FROM generations WHERE source = 'demo');
      INSERT INTO plugin_installations(analyzer_id,version,api_version,capabilities_json,installed_at)
      SELECT 'builtin.codegraph', '1.0.0', '1', '["graph","evidence"]', datetime('now')
      WHERE EXISTS (SELECT 1 FROM generations WHERE source <> 'demo');

      INSERT INTO analysis_runs(id,workspace_id,analyzer_id,analyzer_version,status,source_revision,config_json,started_at,completed_at)
      SELECT 'legacy-' || id, workspace_id,
        CASE WHEN source = 'demo' THEN 'builtin.demo' ELSE 'builtin.codegraph' END,
        '1.0.0', 'succeeded', NULL, '{}', created_at, created_at
      FROM generations;
      INSERT INTO analysis_generations(id,run_id,workspace_id,analyzer_id,created_at,node_count,edge_count)
      SELECT id, 'legacy-' || id, workspace_id,
        CASE WHEN source = 'demo' THEN 'builtin.demo' ELSE 'builtin.codegraph' END,
        created_at, node_count, edge_count
      FROM generations;
      INSERT INTO active_analysis_generations(workspace_id,analyzer_id,generation_id)
      SELECT g.workspace_id, CASE WHEN g.source = 'demo' THEN 'builtin.demo' ELSE 'builtin.codegraph' END, g.id
      FROM active_generations a JOIN generations g ON g.id = a.generation_id;
      INSERT INTO node_contributions(generation_id,id,workspace_id,kind,label,properties_json)
      SELECT generation_id,id,workspace_id,kind,label,properties_json FROM nodes;
      INSERT INTO edge_contributions(generation_id,id,workspace_id,source_id,target_id,kind,properties_json)
      SELECT generation_id,id,workspace_id,source_id,target_id,kind,properties_json FROM edges;
      INSERT INTO evidence(id,generation_id,subject_kind,subject_id,level,payload_json)
      SELECT
        'legacy:' || n.generation_id || ':' || n.id || ':' || item.key,
        n.generation_id,
        'node',
        n.id,
        COALESCE(json_extract(item.value, '$.level'), 'DIRECT'),
        item.value
      FROM nodes n
      JOIN json_each(n.evidence_json) AS item
      WHERE json_type(n.evidence_json) = 'array';
    `);
  },
};

/** Adds durable analyzer-run failure diagnostics and enforces one live run per analyzer/workspace. */
export const analyzerRunLifecycleMigration: SchemaMigration = {
  version: 3,
  name: 'analysis-run-lifecycle-diagnostics',
  up(db) {
    db.exec(`
      ALTER TABLE analysis_runs ADD COLUMN api_version TEXT NOT NULL DEFAULT '1';
      ALTER TABLE analysis_runs ADD COLUMN error_code TEXT;
      ALTER TABLE analysis_runs ADD COLUMN error_message TEXT;
      ALTER TABLE analysis_runs ADD COLUMN diagnostic_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE diagnostics RENAME TO diagnostics_legacy;
      CREATE TABLE diagnostics (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        generation_id INTEGER,
        sequence INTEGER NOT NULL,
        code TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        uri TEXT,
        line INTEGER,
        detail_json TEXT,
        FOREIGN KEY(run_id) REFERENCES analysis_runs(id),
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id),
        UNIQUE(run_id, sequence)
      );
      INSERT INTO diagnostics(run_id,generation_id,sequence,code,severity,message,detail_json)
      SELECT g.run_id, d.generation_id, d.id, 'LEGACY_DIAGNOSTIC', d.severity, d.message, d.payload_json
      FROM diagnostics_legacy d JOIN analysis_generations g ON g.id=d.generation_id;
      DROP TABLE diagnostics_legacy;
      CREATE UNIQUE INDEX analysis_runs_one_running_per_analyzer
        ON analysis_runs(workspace_id, analyzer_id) WHERE status='running';
    `);
  },
};

/** Records plugin packages and their analyzer ownership independently of analysis runs. */
export const pluginPackageOwnershipMigration: SchemaMigration = {
  version: 4,
  name: 'plugin-package-ownership',
  up(db) {
    db.exec(`
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        api_version TEXT NOT NULL,
        package_name TEXT NOT NULL UNIQUE,
        package_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        installed_at TEXT NOT NULL
      );
      CREATE TABLE plugin_analyzers (
        plugin_id TEXT NOT NULL,
        analyzer_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(plugin_id, analyzer_id),
        FOREIGN KEY(plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
      );
      DROP TABLE plugin_installations;
    `);
  },
};

/** Binds analyzer runs to a durable plugin installation identity across removal/reinstall cycles. */
export const pluginInstallationIdentityMigration: SchemaMigration = {
  version: 5,
  name: 'plugin-installation-identities',
  up(db) {
    db.exec(`
      ALTER TABLE plugins ADD COLUMN installation_id TEXT;
      ALTER TABLE plugins ADD COLUMN lock_hash TEXT;
      ALTER TABLE plugins ADD COLUMN error_code TEXT;
      ALTER TABLE analysis_runs ADD COLUMN plugin_installation_id TEXT;
    `);
  },
};

/** Stores immutable input-generation dependencies for derived analysis generations. */
export const analysisGenerationInputsMigration: SchemaMigration = {
  version: 6,
  name: 'analysis-generation-inputs',
  up(db) {
    db.exec(`
      CREATE TABLE analysis_generation_inputs (
        generation_id INTEGER NOT NULL,
        input_generation_id INTEGER NOT NULL,
        input_analyzer_id TEXT NOT NULL,
        PRIMARY KEY(generation_id, input_generation_id),
        CHECK(generation_id <> input_generation_id),
        FOREIGN KEY(generation_id) REFERENCES analysis_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(input_generation_id) REFERENCES analysis_generations(id)
      );
      CREATE INDEX analysis_generation_inputs_by_input
        ON analysis_generation_inputs(input_generation_id, generation_id);
      CREATE TRIGGER analysis_generation_inputs_integrity
        BEFORE INSERT ON analysis_generation_inputs
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM analysis_generations derived
            JOIN analysis_generations input ON input.id=NEW.input_generation_id
            JOIN analysis_runs input_run ON input_run.id=input.run_id
            WHERE derived.id=NEW.generation_id
              AND derived.workspace_id=input.workspace_id
              AND derived.analyzer_id<>input.analyzer_id
              AND input.analyzer_id=NEW.input_analyzer_id
              AND input_run.status='succeeded'
          ) THEN RAISE(ABORT, 'invalid analysis generation input') END;
        END;
    `);
  },
};
