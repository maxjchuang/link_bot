import {expect, it} from 'vitest';
import Database from 'better-sqlite3';
import {migrateSqliteSchema, SQLITE_SCHEMA_VERSION} from '../../src/state/SqliteSchema.js';

it('adds group state to the v33 schema without rewriting legacy payloads', () => {
  const db = new Database(':memory:'); try {
    migrateSqliteSchema(db);
    // The additive tables are the ONLY differences from v33.
    db.exec('DROP TABLE group_services; DROP TABLE group_service_events; PRAGMA user_version=33;');
    db.prepare('INSERT INTO legacy_records(collection,id,payload) VALUES(?,?,?)')
      .run('test', 'unchanged', '{"ownerUserId":"ou_legacy","unrecognized":"preserve"}');
    migrateSqliteSchema(db); migrateSqliteSchema(db);
    expect(db.pragma('user_version', {simple: true})).toBe(SQLITE_SCHEMA_VERSION);
    expect(db.prepare('SELECT payload FROM legacy_records WHERE id=?').get('unchanged'))
      .toEqual({payload: '{"ownerUserId":"ou_legacy","unrecognized":"preserve"}'});
    expect(db.prepare('SELECT count(*) AS count FROM group_services').get()).toEqual({count: 0});
  } finally {db.close();}
});
