import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { RawJob, RawRunLine } from './types'
import { runOpenclaw } from './cli'

function getCronPath(): string {
  return process.env.OPENCLAW_CRON_PATH || ''
}

/**
 * Chemin de la base SQLite OpenClaw. Depuis 2026.6.8 le cron y est stocké
 * (avant : cron/jobs.json). OPENCLAW_CRON_PATH pointe sur .../.openclaw/cron,
 * la base est dans .../.openclaw/state/openclaw.sqlite.
 */
function getSqlitePath(): string {
  const cronPath = getCronPath()
  if (!cronPath) return ''
  return path.join(cronPath, '..', 'state', 'openclaw.sqlite')
}

/** Clé de store utilisée par OpenClaw dans cron_jobs / cron_run_logs (= ancien chemin jobs.json). */
function getStoreKey(): string {
  const cronPath = getCronPath()
  return cronPath ? path.join(cronPath, 'jobs.json') : ''
}

/**
 * Liste les jobs cron via le CLI OpenClaw (`cron list --all --json`), qui
 * interroge le Gateway. La sortie a exactement la forme RawJob attendue par
 * les agrégateurs (id, name, schedule, payload, state, delivery, ...).
 */
export function readJobs(): RawJob[] {
  const res = runOpenclaw(['cron', 'list', '--all', '--json'], { timeoutMs: 30_000 })
  if (!res.ok || !res.stdout.trim()) return []
  try {
    const parsed = JSON.parse(res.stdout) as { jobs?: RawJob[] } | RawJob[]
    if (Array.isArray(parsed)) return parsed
    return parsed.jobs ?? []
  } catch {
    return []
  }
}

/**
 * Écrit une ligne de run "manuelle" dans cron/runs/<jobId>.jsonl.
 * Utilisé par les exécutions lancées depuis Clawboard (runNow / runAgainTask),
 * qui passent par `openclaw agent` et n'apparaissent donc pas dans cron_run_logs.
 */
export function appendRun(jobId: string, entry: Record<string, unknown>): void {
  const cronPath = getCronPath()
  if (!cronPath) return
  try {
    const runsDir = path.join(cronPath, 'runs')
    if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true })
    const filePath = path.join(runsDir, `${jobId}.jsonl`)
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // best-effort : un log manquant ne doit pas faire échouer l'action
  }
}

/** Lit l'historique des runs du scheduler depuis la table SQLite cron_run_logs. */
function readRunsFromSqlite(): Map<string, RawRunLine[]> {
  const result = new Map<string, RawRunLine[]>()
  const dbPath = getSqlitePath()
  if (!dbPath || !fs.existsSync(dbPath)) return result
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const storeKey = getStoreKey()
    const rows = (storeKey
      ? db
          .prepare('SELECT job_id, entry_json FROM cron_run_logs WHERE store_key = ? ORDER BY ts ASC')
          .all(storeKey)
      : db.prepare('SELECT job_id, entry_json FROM cron_run_logs ORDER BY ts ASC').all()) as {
      job_id: string
      entry_json: string
    }[]
    for (const row of rows) {
      try {
        const entry = JSON.parse(row.entry_json) as RawRunLine
        const list = result.get(row.job_id) ?? []
        list.push(entry)
        result.set(row.job_id, list)
      } catch {
        // ligne corrompue : on l'ignore
      }
    }
  } catch {
    // base absente / verrouillée : repli silencieux
  } finally {
    try {
      db?.close()
    } catch {
      /* noop */
    }
  }
  return result
}

/** Lit les runs manuels / legacy depuis cron/runs/*.jsonl. */
function readRunsFromJsonl(): Map<string, RawRunLine[]> {
  const cronPath = getCronPath()
  const result = new Map<string, RawRunLine[]>()
  if (!cronPath) return result
  try {
    const runsDir = path.join(cronPath, 'runs')
    if (!fs.existsSync(runsDir)) return result
    const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'))
    for (const file of files) {
      const jobId = file.replace('.jsonl', '')
      const content = fs.readFileSync(path.join(runsDir, file), 'utf-8')
      const lines = content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as RawRunLine
          } catch {
            return null
          }
        })
        .filter((line): line is RawRunLine => line !== null)
      if (lines.length) result.set(jobId, lines)
    }
  } catch {
    // graceful fallback
  }
  return result
}

/**
 * Historique combiné : runs du scheduler (SQLite cron_run_logs) + runs manuels
 * ou legacy (cron/runs/*.jsonl). Déduplication défensive par (ts, runAtMs,
 * action, status) au cas où une source recouvrirait l'autre.
 */
export function readAllRuns(): Map<string, RawRunLine[]> {
  const sqliteRuns = readRunsFromSqlite()
  const jsonlRuns = readRunsFromJsonl()
  const merged = new Map<string, RawRunLine[]>()
  const keyOf = (r: RawRunLine) => `${r.ts}|${r.runAtMs}|${r.action}|${r.status}`

  // SQLite d'abord (priorité), puis jsonl
  for (const [jobId, lines] of [...sqliteRuns, ...jsonlRuns]) {
    const existing = merged.get(jobId) ?? []
    const seen = new Set(existing.map(keyOf))
    for (const line of lines) {
      const k = keyOf(line)
      if (!seen.has(k)) {
        existing.push(line)
        seen.add(k)
      }
    }
    merged.set(jobId, existing)
  }
  return merged
}
