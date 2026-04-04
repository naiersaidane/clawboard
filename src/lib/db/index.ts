import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import path from 'path'
import * as schema from './schema'

const globalForDb = globalThis as unknown as { __db?: ReturnType<typeof initDb> }

function initDb() {
  const dbPath = path.join(process.cwd(), 'clawboard.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')

  // Inline migrations
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_name TEXT,
      instructions TEXT NOT NULL,
      pre_instructions TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      delivery_channel TEXT NOT NULL DEFAULT 'discord',
      delivery_recipient TEXT,
      model TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4',
      skip_pre_instructions INTEGER NOT NULL DEFAULT 0,
      cron_job_id TEXT,
      execution_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pre_instructions (
      id INTEGER PRIMARY KEY DEFAULT 1,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO pre_instructions (id, content, updated_at)
    VALUES (1, '', '${new Date().toISOString()}');
  `)

  // Migration: add skip_pre_instructions column (safe for existing DBs)
  try { sqlite.exec(`ALTER TABLE templates ADD COLUMN skip_pre_instructions INTEGER NOT NULL DEFAULT 0`) } catch { /* column already exists */ }

  // Migration: add session_target column (safe for existing DBs)
  try { sqlite.exec(`ALTER TABLE templates ADD COLUMN session_target TEXT DEFAULT 'current'`) } catch { /* column already exists */ }

  return drizzle(sqlite, { schema })
}

export const db = globalForDb.__db ?? initDb()

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__db = db
}
