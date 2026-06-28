import fs from 'fs'
import path from 'path'
import type { ConnectionStatus } from '@/components/settings/types'
import { readJobs } from '@/lib/cron/reader'

function getCronPath(): string {
  return process.env.OPENCLAW_CRON_PATH || ''
}

function getOpenClawRoot(): string {
  const cronPath = getCronPath()
  if (!cronPath) return ''
  return path.resolve(cronPath, '..')
}

function readJsonFile(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function now(): string {
  return new Date().toISOString()
}

export function checkConnections(): ConnectionStatus[] {
  const openclawRoot = getOpenClawRoot()
  const cronPath = getCronPath()
  const statuses: ConnectionStatus[] = []

  // Check OpenClaw CLI / config
  const configPath = openclawRoot ? path.join(openclawRoot, 'openclaw.json') : ''
  if (configPath && fs.existsSync(configPath)) {
    statuses.push({
      id: 'openclaw',
      name: 'OpenClaw',
      status: 'connected',
      detail: 'openclaw.json found',
      checkedAt: now(),
    })
  } else {
    statuses.push({
      id: 'openclaw',
      name: 'OpenClaw',
      status: 'error',
      detail: openclawRoot ? 'openclaw.json not found' : 'OPENCLAW_CRON_PATH not set',
      checkedAt: now(),
    })
  }

  // Check OpenRouter API (unchecked by default - requires async test)
  statuses.push({
    id: 'openrouter',
    name: 'OpenRouter API',
    status: 'unchecked',
    detail: 'Click "Test" to verify',
    checkedAt: now(),
  })

  // Check cron store (SQLite depuis OpenClaw 2026.6.8 ; ancien jobs.json en repli)
  const sqlitePath = openclawRoot ? path.join(openclawRoot, 'state', 'openclaw.sqlite') : ''
  const legacyJobsPath = cronPath ? path.join(cronPath, 'jobs.json') : ''
  const hasStore =
    (sqlitePath && fs.existsSync(sqlitePath)) || (legacyJobsPath && fs.existsSync(legacyJobsPath))
  if (hasStore) {
    let jobCount = 0
    try {
      jobCount = readJobs().length
    } catch {
      // Gateway indisponible : on reste "connected" (le store existe) sans le compte
    }
    statuses.push({
      id: 'cron-jobs',
      name: 'Cron Jobs',
      status: 'connected',
      detail: `${jobCount} job${jobCount !== 1 ? 's' : ''} configured`,
      checkedAt: now(),
    })
  } else {
    statuses.push({
      id: 'cron-jobs',
      name: 'Cron Jobs',
      status: 'error',
      detail: cronPath ? 'cron store not found' : 'OPENCLAW_CRON_PATH not set',
      checkedAt: now(),
    })
  }

  // Check workspace
  const openclawConfig = configPath ? readJsonFile(configPath) : null
  let workspace = ''
  if (openclawConfig && typeof openclawConfig === 'object') {
    const agents = (openclawConfig as Record<string, unknown>).agents as Record<string, unknown> | undefined
    const defaults = agents?.defaults as Record<string, unknown> | undefined
    workspace = (defaults?.workspace as string) || ''
  }

  if (workspace) {
    const resolvedWorkspace = workspace.startsWith('~')
      ? path.join(process.env.HOME || '', workspace.slice(1))
      : workspace
    // Detect Docker: workspace is a container-internal path not accessible from host
    const isDocker = fs.existsSync(path.join(getOpenClawRoot(), '..', 'docker-compose.yml'))
    if (fs.existsSync(resolvedWorkspace)) {
      statuses.push({
        id: 'workspace',
        name: 'Workspace',
        status: 'connected',
        detail: workspace,
        checkedAt: now(),
      })
    } else if (isDocker) {
      statuses.push({
        id: 'workspace',
        name: 'Workspace',
        status: 'connected',
        detail: `${workspace} (Docker container)`,
        checkedAt: now(),
      })
    } else {
      statuses.push({
        id: 'workspace',
        name: 'Workspace',
        status: 'error',
        detail: `${workspace} not found`,
        checkedAt: now(),
      })
    }
  } else {
    statuses.push({
      id: 'workspace',
      name: 'Workspace',
      status: 'unchecked',
      detail: 'No workspace configured',
      checkedAt: now(),
    })
  }

  return statuses
}

/** Read the OpenRouter API token from OpenClaw's auth-profiles.json */
export function getOpenRouterToken(): string | undefined {
  const openclawRoot = getOpenClawRoot()
  const authProfilesPath = openclawRoot
    ? path.join(openclawRoot, 'agents', 'main', 'agent', 'auth-profiles.json')
    : ''
  if (!authProfilesPath) return undefined
  const authProfiles = readJsonFile(authProfilesPath) as Record<string, unknown> | null
  const profiles = authProfiles?.profiles as Record<string, unknown> | undefined
  if (!profiles) return undefined
  // Find any openrouter profile (could be openrouter:manual, openrouter:default, etc.)
  for (const [key, value] of Object.entries(profiles)) {
    if (key.startsWith('openrouter:') && value && typeof value === 'object') {
      const profile = value as Record<string, unknown>
      const token = (profile.token || profile.key) as string | undefined
      if (token) return token
    }
  }
  return undefined
}

export async function testOpenRouterKey(): Promise<ConnectionStatus> {
  const token = getOpenRouterToken()

  if (!token) {
    return {
      id: 'openrouter',
      name: 'OpenRouter API',
      status: 'error',
      detail: 'No API key found in auth-profiles.json',
      checkedAt: new Date().toISOString(),
    }
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.ok) {
      const data = (await response.json()) as { data?: { label?: string } }
      const label = data?.data?.label || 'Valid'
      return {
        id: 'openrouter',
        name: 'OpenRouter API',
        status: 'connected',
        detail: `Key valid — ${label}`,
        checkedAt: new Date().toISOString(),
      }
    }
    return {
      id: 'openrouter',
      name: 'OpenRouter API',
      status: 'error',
      detail: `HTTP ${response.status}: ${response.statusText}`,
      checkedAt: new Date().toISOString(),
    }
  } catch (err) {
    return {
      id: 'openrouter',
      name: 'OpenRouter API',
      status: 'error',
      detail: err instanceof Error ? err.message : 'Connection failed',
      checkedAt: new Date().toISOString(),
    }
  }
}
