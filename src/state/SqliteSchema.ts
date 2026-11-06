import type Database from 'better-sqlite3';

export const SQLITE_SCHEMA_VERSION = 33;

export function migrateSqliteSchema(db: Database.Database): void {
  // The gateway and host-manager deliberately share this WAL database. Give a
  // concurrent writer time to finish instead of failing a user-facing event.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  let current = db.pragma('user_version', { simple: true }) as number;
  if (current > SQLITE_SCHEMA_VERSION) {
    throw new Error(`SQLite state schema ${current} is newer than supported version ${SQLITE_SCHEMA_VERSION}.`);
  }
  if (current === 0) {
    migrateToVersion1(db);
    current = 1;
  }
  if (current === 1) migrateToVersion2(db);
  if (current <= 2) migrateToVersion3(db);
  if (current <= 3) migrateToVersion4(db);
  if (current <= 4) migrateToVersion5(db);
  if (current <= 5) migrateToVersion6(db);
  if (current <= 6) migrateToVersion7(db);
  if (current <= 7) migrateToVersion8(db);
  if (current <= 8) migrateToVersion9(db);
  if (current <= 9) migrateToVersion10(db);
  if (current <= 10) migrateToVersion11(db);
  if (current <= 11) migrateToVersion12(db);
  if (current <= 12) migrateToVersion13(db);
  if (current <= 13) migrateToVersion14(db);
  if (current <= 14) migrateToVersion15(db);
  if (current <= 15) migrateToVersion16(db);
  if (current <= 16) migrateToVersion17(db);
  if (current <= 17) migrateToVersion18(db);
  if (current <= 18) migrateToVersion19(db);
  if (current <= 19) migrateToVersion20(db);
  if (current <= 20) migrateToVersion21(db);
  if (current <= 21) migrateToVersion22(db);
  if (current <= 22) migrateToVersion23(db);
  if (current <= 23) migrateToVersion24(db);
  if (current <= 24) migrateToVersion25(db);
  if (current <= 25) migrateToVersion26(db);
  if (current <= 26) migrateToVersion27(db);
  if (current <= 27) migrateToVersion28(db);
  if (current <= 28) migrateToVersion29(db);
  if (current <= 29) migrateToVersion30(db);
  if (current <= 30) migrateToVersion31(db);
  if (current <= 31) migrateToVersion32(db);
  if (current <= 32) migrateToVersion33(db);
}

function migrateToVersion33(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 33) return;
    db.exec(`CREATE TABLE dynamic_projects_scoped (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('github')),
      provider_repo_id TEXT NOT NULL, namespace TEXT NOT NULL, name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('registered','active','suspended')),
      payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider,provider_repo_id,owner_user_id,chat_id,topic_id));
      INSERT INTO dynamic_projects_scoped SELECT * FROM dynamic_projects;
      DROP TABLE dynamic_projects;
      ALTER TABLE dynamic_projects_scoped RENAME TO dynamic_projects;
      CREATE INDEX dynamic_projects_topic_scope ON dynamic_projects(owner_user_id,chat_id,topic_id,state);`);
    db.pragma('user_version=33');
  }).immediate();
}

function migrateToVersion32(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 32) return;
    db.exec(`CREATE TABLE IF NOT EXISTS detail_recording_writers(
      turn_key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, process_scope TEXT NOT NULL);
      UPDATE detail_security_contract SET version=3 WHERE id=1;`);
    db.pragma('user_version=32');
  }).immediate();
}

function migrateToVersion31(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 31) return;
    // Semantic compatibility floor: old binaries disclose details without per-access audit.
    db.prepare('UPDATE detail_security_contract SET version=2 WHERE id=1').run();
    db.pragma('user_version=31');
  }).immediate();
}

function migrateToVersion30(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 30) return;
    db.exec(`ALTER TABLE detail_resource_registry ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT -1;
      ALTER TABLE detail_resource_registry ADD COLUMN held_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE detail_resource_registry ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE detail_resource_registry ADD COLUMN allocation_bytes INTEGER NOT NULL DEFAULT 256;
      UPDATE detail_resource_registry SET allocation_bytes=256+coalesce(length(CAST(turn_key AS BLOB)),0);
      UPDATE detail_resource_registry SET held_bytes=allocation_bytes WHERE NOT EXISTS(
        SELECT 1 FROM detail_entries e WHERE e.resource_id=detail_resource_registry.resource_id);
      UPDATE detail_turns SET retained_bytes=retained_bytes+coalesce((SELECT sum(held_bytes) FROM detail_resource_registry r WHERE r.turn_key=detail_turns.turn_key),0);
      UPDATE detail_turns SET payload=json_set(payload,'$.retainedBytes',retained_bytes);
      CREATE INDEX detail_resource_registry_retired ON detail_resource_registry(retired,turn_key);`);
    db.pragma('user_version=30');
  }).immediate();
}

function migrateToVersion29(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 29) return;
    // Semantic compatibility floor: older binaries tie security recording to the UI flag.
    db.exec(`CREATE TABLE detail_security_contract(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT INTO detail_security_contract VALUES(1,1);`);
    db.pragma('user_version = 29');
  }).immediate();
}

function migrateToVersion28(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 28) return;
    db.exec(`CREATE TABLE detail_resource_registry(resource_id TEXT PRIMARY KEY,turn_key TEXT,created_at TEXT NOT NULL);
      CREATE INDEX detail_resource_registry_turn ON detail_resource_registry(turn_key,created_at);
      INSERT INTO detail_resource_registry SELECT resource_id,turn_key,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM detail_entries WHERE resource_id IS NOT NULL;
      CREATE TABLE detail_resource_deletions(resource_id TEXT PRIMARY KEY,turn_key TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX detail_resource_deletions_pending ON detail_resource_deletions(attempts,resource_id);
      CREATE INDEX detail_resource_deletions_turn ON detail_resource_deletions(turn_key);
      CREATE INDEX detail_turns_lifecycle ON detail_turns(json_extract(payload,'$.lifecycle'),json_extract(payload,'$.ownerKind'));
      CREATE TABLE detail_maintenance_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE detail_maintenance_progress(id INTEGER PRIMARY KEY CHECK(id=1),boundary_after INTEGER NOT NULL);
      INSERT INTO detail_maintenance_progress VALUES(1,0);`);
    db.pragma('user_version = 28');
  }).immediate();
}

function migrateToVersion27(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 27) return;
    db.exec(`CREATE TABLE turn_result_views(
      ref TEXT PRIMARY KEY, turn_key TEXT NOT NULL REFERENCES turn_results(turn_key),
      viewer_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX turn_result_views_turn ON turn_result_views(turn_key,kind,updated_at);`);
    db.pragma('user_version = 27');
  }).immediate();
}

function migrateToVersion26(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 26) return;
    // Public results are core records, not expiring diagnostic resources.
    db.exec(`CREATE TABLE turn_results(
      turn_key TEXT PRIMARY KEY, scope TEXT NOT NULL, answer TEXT NOT NULL,
      answer_length INTEGER NOT NULL, ended_at TEXT NOT NULL
    );`);
    db.pragma('user_version = 26');
  }).immediate();
}

function migrateToVersion25(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 25) return;
    db.exec(`
      CREATE TABLE detail_card_refs(card_ref TEXT PRIMARY KEY, turn_key TEXT UNIQUE NOT NULL);
      CREATE TABLE detail_view_state(
        ref TEXT PRIMARY KEY, turn_key TEXT NOT NULL REFERENCES detail_turns(turn_key) ON DELETE CASCADE,
        viewer_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
        expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX detail_view_state_turn ON detail_view_state(turn_key,kind,updated_at);
      CREATE INDEX detail_entries_category ON detail_entries(turn_key,json_extract(payload,'$.category'),sequence);
    `);
    db.pragma('user_version = 25');
  }).immediate();
}

function migrateToVersion24(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 24) return;
    db.exec(`
      CREATE TABLE detail_turns (
        turn_key TEXT PRIMARY KEY, payload TEXT NOT NULL,
        ended_at TEXT, availability TEXT NOT NULL, retained_bytes INTEGER NOT NULL
      );
      CREATE INDEX detail_turns_cleanup ON detail_turns(availability, ended_at);
      CREATE TABLE detail_entries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_key TEXT NOT NULL REFERENCES detail_turns(turn_key) ON DELETE CASCADE,
        entry_id TEXT NOT NULL, resource_id TEXT UNIQUE,
        payload TEXT NOT NULL, retained_bytes INTEGER NOT NULL,
        UNIQUE(turn_key, entry_id)
      );
      CREATE INDEX detail_entries_page ON detail_entries(turn_key, sequence);
      CREATE TABLE detail_events (
        turn_key TEXT NOT NULL REFERENCES detail_turns(turn_key) ON DELETE CASCADE,
        event_key TEXT NOT NULL, retained_bytes INTEGER NOT NULL,
        PRIMARY KEY(turn_key, event_key)
      );
      CREATE TABLE detail_browsers (
        browser_ref TEXT PRIMARY KEY,
        turn_key TEXT NOT NULL REFERENCES detail_turns(turn_key) ON DELETE CASCADE,
        viewer_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 24');
  }).immediate();
}

function migrateToVersion23(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DROP INDEX project_creation_one_open_per_topic;
      CREATE UNIQUE INDEX project_creation_one_open_per_topic
        ON project_creation_operations(chat_id,topic_id)
        WHERE status NOT IN ('bound','failed');
    `);
    db.pragma('user_version = 23');
  })();
}

function migrateToVersion22(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE dynamic_projects (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('github')),
        provider_repo_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('registered','active','suspended')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, provider_repo_id)
      );
      CREATE INDEX dynamic_projects_topic_scope
        ON dynamic_projects(owner_user_id,chat_id,topic_id,state);
      CREATE TABLE project_creation_operations (
        operation_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        provider TEXT CHECK(provider IN ('github')),
        namespace TEXT,
        name TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'collecting','awaiting_confirmation','creating','remote_created',
          'registered','checkout_ready','bound','failed'
        )),
        expires_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX project_creation_one_open_per_topic
        ON project_creation_operations(owner_user_id,chat_id,topic_id)
        WHERE status NOT IN ('bound','failed');
      CREATE INDEX project_creation_status_updated
        ON project_creation_operations(status,updated_at);
    `);
    db.pragma('user_version = 22');
  })();
}

function migrateToVersion21(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE media_objects (
        sha256 TEXT PRIMARY KEY, storage_path TEXT NOT NULL, detected_mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), created_at TEXT NOT NULL
      );
      CREATE TABLE media_attachments (
        id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
        kind TEXT NOT NULL CHECK(kind IN ('image','file')), external_message_id TEXT,
        resource_key TEXT, task_id TEXT, turn_id TEXT, status TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX media_attachments_inbound_dedupe
        ON media_attachments(external_message_id, resource_key)
        WHERE external_message_id IS NOT NULL AND resource_key IS NOT NULL;
      CREATE INDEX media_attachments_turn ON media_attachments(task_id, turn_id, direction, status);
      CREATE TABLE turn_attachments (
        task_id TEXT NOT NULL, turn_id TEXT NOT NULL, attachment_id TEXT NOT NULL
          REFERENCES media_attachments(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, PRIMARY KEY(turn_id, attachment_id)
      );
      CREATE TABLE artifact_deliveries (
        id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES media_attachments(id) ON DELETE CASCADE,
        target TEXT NOT NULL, disposition TEXT NOT NULL, status TEXT NOT NULL,
        remote_resource_key TEXT, message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(attachment_id, target, disposition)
      );
      CREATE TABLE pending_media_bindings (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, topic_id TEXT, sender_user_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES media_attachments(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','consumed','expired')),
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX pending_media_bindings_scope
        ON pending_media_bindings(chat_id, topic_id, sender_user_id, status, expires_at);
    `);
    db.pragma('user_version = 21');
  })();
}

function migrateToVersion20(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE user_sandboxes (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL CHECK(generation > 0),
        status TEXT NOT NULL CHECK(status IN ('provisioning','running','stopping','stopped','failed')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX user_sandboxes_status_activity
        ON user_sandboxes(status, updated_at);

      CREATE TABLE inbound_admissions (
        admission_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        task_id TEXT,
        turn_id TEXT,
        action TEXT,
        sandbox_generation INTEGER,
        process_generation INTEGER,
        status TEXT NOT NULL CHECK(status IN ('received','pending','submitting','accepted','rejected','unknown','completed')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, external_message_id)
      );
      CREATE INDEX inbound_admissions_status_updated
        ON inbound_admissions(status, updated_at);
      CREATE INDEX inbound_admissions_task_updated
        ON inbound_admissions(task_id, updated_at);
    `);

    const hasLegacyReceipts = Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbound_message_receipts'",
    ).get());
    const rows = (hasLegacyReceipts
      ? db.prepare('SELECT message_id, payload FROM inbound_message_receipts').all()
      : []) as Array<{ message_id: string; payload: string }>;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO inbound_admissions(
        admission_id,source,external_message_id,owner_id,task_id,turn_id,action,
        sandbox_generation,process_generation,status,payload,created_at,updated_at
      ) VALUES (@admissionId,@source,@externalMessageId,@ownerId,NULL,NULL,NULL,NULL,NULL,@status,@payload,@createdAt,@updatedAt)
    `);
    for (const row of rows) {
      const receipt = JSON.parse(row.payload) as {
        userId?: string; chatId?: string; chatType?: 'private'|'group'; textPreview?: string;
        status?: string; firstReceivedAt?: string; completedAt?: string; failedAt?: string; processingStartedAt?: string;
      };
      const createdAt = receipt.firstReceivedAt ?? new Date(0).toISOString();
      const status = receipt.status === 'completed' ? 'completed'
        : receipt.status === 'failed' ? 'rejected'
          : 'unknown';
      const updatedAt = receipt.completedAt ?? receipt.failedAt ?? receipt.processingStartedAt ?? createdAt;
      const admission = {
        admissionId: `admission:${row.message_id}`,
        source: 'feishu',
        externalMessageId: row.message_id,
        ownerId: receipt.userId ?? 'unknown',
        rawPayload: {
          messageId: row.message_id,
          chatId: receipt.chatId ?? '',
          chatType: receipt.chatType ?? 'private',
          userId: receipt.userId ?? 'unknown',
          text: receipt.textPreview ?? '',
        },
        status,
        createdAt,
        updatedAt,
        ...(status === 'unknown' ? { error: 'legacy admission was in flight during schema migration' } : {}),
      };
      insert.run({ ...admission, payload: JSON.stringify(admission) });
    }
    db.pragma('user_version = 20');
  })();
}

function migrateToVersion19(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE conversation_execution_profiles (
        scope_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, topic_id TEXT,
        owner_user_id TEXT NOT NULL, status TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX conversation_execution_profiles_status
        ON conversation_execution_profiles(status, updated_at);
    `);
    db.pragma('user_version = 19');
  })();
}

function migrateToVersion18(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE ambient_topic_states (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, topic_id TEXT NOT NULL,
        last_message_created_at TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ambient_topic_states_scope ON ambient_topic_states(chat_id, topic_id);
    `);
    db.pragma('user_version = 18');
  })();
}

function migrateToVersion17(db: Database.Database): void {
}

function migrateToVersion16(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE token_usage_watermarks (
        thread_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX token_usage_watermarks_task ON token_usage_watermarks(task_id);
      CREATE TABLE token_usage_ledger (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, context_id TEXT,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, user_id TEXT NOT NULL,
        project_id TEXT NOT NULL, chat_id TEXT, topic_id TEXT, model TEXT,
        input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE INDEX token_usage_ledger_task_time ON token_usage_ledger(task_id, occurred_at);
      CREATE INDEX token_usage_ledger_user_time ON token_usage_ledger(user_id, occurred_at);
      CREATE INDEX token_usage_ledger_project_time ON token_usage_ledger(project_id, occurred_at);
    `);
    db.pragma('user_version = 16');
  })();
}

function migrateToVersion15(db: Database.Database): void {
}

function migrateToVersion14(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE workspace_specs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(task_id, version)
      );
      CREATE INDEX workspace_specs_task_state ON workspace_specs(task_id, state, version DESC);
      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX change_sets_task_project ON change_sets(task_id, project_id, updated_at);
    `);
    db.pragma('user_version = 14');
  })();
}

function migrateToVersion13(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE repository_migrations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX repository_migrations_task_state ON repository_migrations(task_id, state, updated_at);
    `);
    db.pragma('user_version = 13');
  })();
}

function migrateToVersion12(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE pending_project_routing (
        id TEXT PRIMARY KEY, original_message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL, requester_user_id TEXT NOT NULL,
        status TEXT NOT NULL, expires_at TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX pending_project_routing_expiry ON pending_project_routing(status, expires_at);
    `);
    db.pragma('user_version = 12');
  })();
}

function migrateToVersion11(db: Database.Database): void {
}

function migrateToVersion10(db: Database.Database): void {
}

function migrateToVersion9(db: Database.Database): void {
}

function migrateToVersion8(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE conversation_context_cursors (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id, chat_id, thread_key)
      );
    `);
    db.pragma('user_version = 8');
  })();
}

function migrateToVersion7(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE pending_tool_auth (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX pending_tool_auth_user_provider ON pending_tool_auth(user_id, provider, created_at);
    `);
    db.pragma('user_version = 7');
  })();
}

function migrateToVersion6(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE project_knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'active', 'rejected', 'superseded')),
        version INTEGER NOT NULL CHECK(version > 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX project_knowledge_project_status ON project_knowledge(project_id, status, version);
      CREATE TABLE project_usage (
        actor_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY(actor_key, project_id)
      );
      CREATE INDEX project_usage_recent ON project_usage(actor_key, last_used_at DESC);
    `);
    db.pragma('user_version = 6');
  })();
}

function migrateToVersion5(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
        memory_id UNINDEXED,
        scope_type UNINDEXED,
        scope_id UNINDEXED,
        title,
        description,
        content,
        tags,
        tokenize = 'unicode61'
      );
    `);
    const rows = db.prepare('SELECT payload FROM memory_entries').all() as Array<{ payload: string }>;
    const insert = db.prepare(`
      INSERT INTO memory_entries_fts(memory_id, scope_type, scope_id, title, description, content, tags)
      VALUES (@id, @scope, @scopeId, @title, @description, @content, @tags)
    `);
    for (const row of rows) {
      const memory = JSON.parse(row.payload) as {
        id: string; scope: string; scopeId: string; title: string; description: string; content: string; tags: string[];
      };
      insert.run({ ...memory, tags: memory.tags.join(' ') });
    }
    db.pragma('user_version = 5');
  })();
}

function migrateToVersion4(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE task_scopes (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('private', 'group', 'topic', 'legacy')),
        scope_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('canonical', 'legacy')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX task_scopes_type_key ON task_scopes(scope_type, scope_key);
      CREATE TABLE task_memberships (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('member', 'owner', 'administrator')),
        status TEXT NOT NULL CHECK(status IN ('active', 'removed')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, user_id)
      );
      CREATE INDEX task_memberships_user_status ON task_memberships(user_id, status, task_id);
      CREATE TABLE task_contexts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        codex_thread_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'archived', 'failed')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, codex_thread_id)
      );
      CREATE UNIQUE INDEX task_contexts_one_active ON task_contexts(task_id) WHERE state = 'active';
      CREATE INDEX task_contexts_task_created ON task_contexts(task_id, created_at, id);
      CREATE TABLE task_repositories (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        checkout_path TEXT NOT NULL,
        is_primary INTEGER NOT NULL CHECK(is_primary IN (0, 1)),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, checkout_path),
        UNIQUE(task_id, project_id)
      );
      CREATE UNIQUE INDEX task_repositories_one_primary ON task_repositories(task_id) WHERE is_primary = 1;
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('task', 'user', 'bot')),
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'active', 'forgotten', 'expired', 'rejected', 'superseded')),
        version INTEGER NOT NULL CHECK(version > 0),
        estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_entries_scope_status ON memory_entries(scope_type, scope_id, status, updated_at);
      CREATE TABLE memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(memory_id, event_key)
      );
      CREATE TABLE context_memory_reads (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES task_contexts(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        memory_version INTEGER NOT NULL,
        detail_level TEXT NOT NULL CHECK(detail_level IN ('catalog', 'summary', 'full', 'source')),
        estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
        payload TEXT NOT NULL,
        loaded_at TEXT NOT NULL,
        UNIQUE(context_id, memory_id, memory_version, detail_level)
      );
      CREATE TABLE dream_jobs (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('task', 'user', 'bot')),
        scope_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'deferred', 'completed', 'failed', 'interrupted')),
        from_event_sequence INTEGER NOT NULL CHECK(from_event_sequence >= 0),
        to_event_sequence INTEGER,
        watermark_sequence INTEGER,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_type, scope_id, business_date)
      );
      CREATE INDEX dream_jobs_status_created ON dream_jobs(status, created_at, id);
    `);
    backfillConversationRecords(db);
    db.pragma('user_version = 4');
  })();
}

function backfillConversationRecords(db: Database.Database): void {
  const tasks = db.prepare(`
    SELECT id, owner_user_id AS ownerUserId, project_id AS projectId, payload, created_at AS createdAt, updated_at AS updatedAt
    FROM tasks ORDER BY created_at, id
  `).all() as Array<{ id: string; ownerUserId: string; projectId: string; payload: string; createdAt: string; updatedAt: string }>;
  const bindings = db.prepare(`
    SELECT task_id AS taskId, payload FROM task_bindings ORDER BY updated_at DESC, id DESC
  `).all() as Array<{ taskId: string; payload: string }>;
  const bindingsByTask = new Map<string, Array<Record<string, unknown>>>();
  for (const row of bindings) {
    const list = bindingsByTask.get(row.taskId) ?? [];
    list.push(JSON.parse(row.payload) as Record<string, unknown>);
    bindingsByTask.set(row.taskId, list);
  }

  const insertScope = db.prepare(`
    INSERT INTO task_scopes(task_id, scope_type, scope_key, status, payload, created_at, updated_at)
    VALUES (@taskId, @scope, @scopeKey, @status, @payload, @createdAt, @updatedAt)
  `);
  const insertMembership = db.prepare(`
    INSERT OR IGNORE INTO task_memberships(id, task_id, user_id, role, status, payload, created_at, updated_at)
    VALUES (@id, @taskId, @userId, @role, @status, @payload, @createdAt, @updatedAt)
  `);
  const insertContext = db.prepare(`
    INSERT OR IGNORE INTO task_contexts(id, task_id, codex_thread_id, state, payload, created_at, updated_at)
    VALUES (@id, @taskId, @codexThreadId, @state, @payload, @createdAt, @updatedAt)
  `);
  const insertRepository = db.prepare(`
    INSERT OR IGNORE INTO task_repositories(id, task_id, project_id, checkout_path, is_primary, payload, created_at, updated_at)
    VALUES (@id, @taskId, @projectId, @checkoutPath, @isPrimary, @payload, @createdAt, @updatedAt)
  `);

  for (const row of tasks) {
    const task = JSON.parse(row.payload) as Record<string, unknown>;
    const taskBindings = bindingsByTask.get(row.id) ?? [];
    const preferred = taskBindings[0];
    const candidate = legacyScope(preferred, row.ownerUserId);
    const available = !db.prepare('SELECT 1 FROM task_scopes WHERE scope_key=?').get(candidate.scopeKey);
    const scope = available ? candidate : { scope: 'legacy', scopeKey: `legacy:${row.id}` };
    const scopeRecord = {
      taskId: row.id,
      ...scope,
      status: available ? 'canonical' : 'legacy',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    insertScope.run({ ...scopeRecord, payload: JSON.stringify(scopeRecord) });

    const users = new Set([row.ownerUserId, ...taskBindings.map((binding) => String(binding.userId ?? '')).filter(Boolean)]);
    for (const userId of users) {
      const membership = {
        id: `membership:${row.id}:${userId}`,
        taskId: row.id,
        userId,
        role: userId === row.ownerUserId ? 'owner' : 'member',
        status: 'active',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      insertMembership.run({ ...membership, payload: JSON.stringify(membership) });
    }

    const repository = {
      id: `repository:${row.id}:primary`,
      taskId: row.id,
      projectId: String(task.projectId ?? row.projectId),
      checkoutPath: '.',
      baseRef: String(task.baseRef ?? 'main'),
      branchName: String(task.branchName ?? ''),
      isPrimary: true,
      addedBy: row.ownerUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    insertRepository.run({ ...repository, isPrimary: 1, payload: JSON.stringify(repository) });

    if (typeof task.codexThreadId === 'string' && task.codexThreadId) {
      const context = {
        id: `context:${row.id}:initial`,
        taskId: row.id,
        codexThreadId: task.codexThreadId,
        state: 'active',
        createdBy: row.ownerUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      insertContext.run({ ...context, payload: JSON.stringify(context) });
    }
  }
}

function legacyScope(binding: Record<string, unknown> | undefined, ownerUserId: string): {
  scope: 'private' | 'group' | 'topic'; scopeKey: string; chatId?: string; topicId?: string; privateUserId?: string;
} {
  if (binding?.chatType === 'group' && typeof binding.chatId === 'string') {
    if (typeof binding.topicId === 'string' && binding.topicId) {
      return { scope: 'topic', scopeKey: `topic:${binding.chatId}:${binding.topicId}`, chatId: binding.chatId, topicId: binding.topicId };
    }
    return { scope: 'group', scopeKey: `group:${binding.chatId}`, chatId: binding.chatId };
  }
  const userId = typeof binding?.userId === 'string' ? binding.userId : ownerUserId;
  return { scope: 'private', scopeKey: `private:${userId}`, privateUserId: userId, chatId: userId };
}

function migrateToVersion3(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE outbound_events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent')),
        attempts INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX outbound_events_status ON outbound_events(status, created_at);
      CREATE TABLE metrics (
        name TEXT NOT NULL,
        labels TEXT NOT NULL,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(name, labels)
      );
    `);
    db.pragma('user_version = 3');
  })();
}

function migrateToVersion2(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE resource_samples (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        sample_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX resource_samples_type_time ON resource_samples(sample_type, created_at);
      CREATE TABLE startup_metrics (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        startup_type TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 2');
  })();
}

function migrateToVersion1(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        runtime_state TEXT NOT NULL,
        last_user_interaction_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_runtime_lru ON tasks(runtime_state, last_user_interaction_at);
      CREATE TABLE task_bindings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX turns_task_state ON turns(task_id, state);
      CREATE TABLE turn_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        turn_id TEXT,
        generation INTEGER,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX turn_events_task_sequence ON turn_events(task_id, sequence);
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        owner_user_id TEXT,
        generation INTEGER,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX approvals_task_status ON approvals(task_id, status);
      CREATE TABLE publish_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE live_cards (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        turn_id TEXT,
        operation_sequence INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ready_slots (
        id TEXT PRIMARY KEY,
        version_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready', 'claimed', 'discarded')),
        claimed_by_task_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX ready_slots_version_status ON ready_slots(version_key, status, created_at);
      CREATE TABLE runtime_leases (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        lease_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE inbound_message_receipts (
        message_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      );
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT UNIQUE,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE external_operation_claims (
        idempotency_key TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE lifecycle_intents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'reconciled')),
        observed_state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX lifecycle_intents_status ON lifecycle_intents(status, task_id);
      CREATE TABLE legacy_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(collection, id)
      );
      CREATE TABLE file_store_imports (
        source_key TEXT PRIMARY KEY,
        backup_path TEXT NOT NULL,
        report TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
  })();
}
