import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrateSqliteSchema, SQLITE_SCHEMA_VERSION } from '../../src/state/SqliteSchema.js';

/** Review-owned legacy fixture: the actual v32 dynamic-project table shape,
 * not a v33 table with its user_version merely lowered. */
function legacyDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dynamic_projects (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('github')),
    provider_repo_id TEXT NOT NULL, namespace TEXT NOT NULL, name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('registered','active','suspended')),
    payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(provider,provider_repo_id));
    CREATE INDEX dynamic_projects_topic_scope ON dynamic_projects(owner_user_id,chat_id,topic_id,state);
    PRAGMA user_version=32;`);
  return db;
}

function insert(db: Database.Database, id: string, options: { repo?: string; owner?: string; chat?: string; topic?: string; state?: string } = {}) {
  const record = { id, provider: 'github', providerRepoId: options.repo ?? 'R_original', namespace: 'example', name: 'project',
    cloneUrl: 'git@github.com:example/project.git', defaultBranch: 'main', ownerUserId: options.owner ?? 'ou_original',
    chatId: options.chat ?? 'oc_original', topicId: options.topic ?? 'topic_original', state: options.state ?? 'active',
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' };
  db.prepare(`INSERT INTO dynamic_projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.provider, record.providerRepoId,
    record.namespace, record.name, record.ownerUserId, record.chatId, record.topicId, record.state, JSON.stringify(record), record.createdAt, record.updatedAt);
}

describe('topic import migration adversarial review', () => {
  it('preserves legacy IDs, payload bytes, timestamps, and all three states', () => {
    const db = legacyDatabase();
    try {
      insert(db, 'dyn_active');
      insert(db, 'dyn_registered', { repo: 'R_registered', state: 'registered' });
      insert(db, 'dyn_suspended', { repo: 'R_suspended', state: 'suspended' });
      const before = db.prepare('SELECT * FROM dynamic_projects ORDER BY id').all();
      migrateSqliteSchema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION);
      expect(db.prepare('SELECT * FROM dynamic_projects ORDER BY id').all()).toEqual(before);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      migrateSqliteSchema(db);
      expect(db.prepare('SELECT * FROM dynamic_projects ORDER BY id').all()).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='dynamic_projects_scoped'").get()).toBeUndefined();
    } finally { db.close(); }
  });

  it('allows independent owner, chat, and topic imports while enforcing same-scope uniqueness', () => {
    const db = legacyDatabase();
    try {
      insert(db, 'dyn_original');
      migrateSqliteSchema(db);
      insert(db, 'dyn_other_owner', { owner: 'ou_other' });
      insert(db, 'dyn_other_chat', { chat: 'oc_other' });
      insert(db, 'dyn_other_topic', { topic: 'topic_other' });
      expect(() => insert(db, 'dyn_same_scope_duplicate')).toThrow(/UNIQUE/);
      expect(db.prepare('SELECT count(*) AS n FROM dynamic_projects').get()).toEqual({ n: 4 });
      expect(db.prepare('SELECT id FROM dynamic_projects WHERE owner_user_id=? AND chat_id=? AND topic_id=?').all(
        'ou_original', 'oc_original', 'topic_original')).toEqual([{ id: 'dyn_original' }]);
      expect(db.prepare("PRAGMA index_list('dynamic_projects')").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'dynamic_projects_topic_scope' }),
      ]));
    } finally { db.close(); }
  });
});
