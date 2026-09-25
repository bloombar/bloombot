"""
Minimal DDL for the two database generations, in one place.

The mock generator writes databases with these schemas, and the tests build
fixtures from them, so a test can never pass against a shape the generator does
not actually produce. They are deliberately a *subset* of the real schemas —
only the tables and columns the analysis reads — kept in step with
`models/*.py` (legacy) and `packages/db/src/schema.ts` (current).
"""

LEGACY_DDL = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    created_at DATETIME, updated_at DATETIME,
    discord_id INTEGER UNIQUE, discord_username VARCHAR,
    email VARCHAR, last_name VARCHAR, first_name VARCHAR, github_username VARCHAR
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    created_at DATETIME, updated_at DATETIME,
    content VARCHAR NOT NULL, category VARCHAR NOT NULL, channel VARCHAR NOT NULL,
    direction VARCHAR NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id)
);
"""

CURRENT_DDL = """
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE courses (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
    title TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER
);
CREATE TABLE people (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, display_name TEXT, email TEXT,
    first_name TEXT, last_name TEXT, github_handle TEXT, connected_at INTEGER,
    merged_into_person_id TEXT, merged_at INTEGER, deleted_at INTEGER,
    deleted_by_account_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE person_identities (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, person_id TEXT NOT NULL,
    surface TEXT NOT NULL, external_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE conversations (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, course_id TEXT NOT NULL,
    person_id TEXT NOT NULL, surface TEXT, upstream_thread_id TEXT,
    deleted_at INTEGER, deleted_by_account_id TEXT,
    created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    person_id TEXT NOT NULL, course_id TEXT NOT NULL, direction TEXT NOT NULL,
    content TEXT NOT NULL, surface TEXT, channel_ref TEXT, category_ref TEXT,
    sequence INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE enrolments (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, course_id TEXT NOT NULL,
    person_id TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
    ended_at INTEGER, reinstated_by_account_id TEXT, reinstated_at INTEGER
);
CREATE TABLE cost_ledger_entries (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, course_id TEXT, person_id TEXT,
    model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    cost_micros INTEGER NOT NULL, measurement TEXT NOT NULL, surface TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE usage_counters (
    organization_id TEXT NOT NULL, course_id TEXT NOT NULL, person_id TEXT NOT NULL,
    day TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY (organization_id, course_id, person_id, day)
);
"""
