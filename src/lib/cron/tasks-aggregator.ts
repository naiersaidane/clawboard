import type { Template, CronJob, CronStatus, ExecutionLog, PreInstruction } from '@/components/tasks/types'
import type { RawJob } from './types'
import { readJobs, readAllRuns } from './reader'
import { computeCostUsd } from './pricing'
import { frequencyLabel } from './utils'
import { db } from '@/lib/db'
import { templates as templatesTable, preInstructions as preInstructionsTable } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

function mapCronStatus(status: string): CronStatus {
  if (status === 'ok') return 'ok'
  if (status === 'error') return 'error'
  return null
}

function mapRawJobToCronJob(raw: RawJob, templateIdMap: Map<string, string>): CronJob {
  return {
    id: raw.id,
    name: raw.name,
    templateId: templateIdMap.get(raw.id) ?? null,
    cronExpression: raw.schedule.expr,
    timezone: raw.schedule.tz,
    enabled: raw.enabled,
    frequencyLabel: frequencyLabel(raw.schedule.expr),
    lastRunAtMs: raw.state.lastRunAtMs || null,
    lastStatus: mapCronStatus(raw.state.lastStatus),
    nextRunAtMs: raw.state.nextRunAtMs || null,
    runningAtMs: raw.state.runningAtMs || null,
    consecutiveErrors: raw.state.consecutiveErrors ?? 0,
  }
}

export function aggregateTasks(): {
  templates: Template[]
  cronJobs: CronJob[]
  executionLogs: ExecutionLog[]
  preInstruction: PreInstruction
} {
  // Query templates from SQLite
  const dbTemplates = db.select().from(templatesTable).all()
  const templates: Template[] = dbTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    skillName: t.skillName,
    instructions: t.instructions,
    preInstructions: t.preInstructions,
    agentId: t.agentId,
    deliveryChannel: t.deliveryChannel,
    deliveryRecipient: t.deliveryRecipient,
    model: t.model,
    sessionTarget: t.sessionTarget || 'current',
    skipPreInstructions: !!t.skipPreInstructions,
    cronJobId: t.cronJobId,
    executionCount: t.executionCount,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }))

  // Build reverse lookup: cronJobId -> templateId
  const templateIdMap = new Map<string, string>()
  for (const tpl of templates) {
    if (tpl.cronJobId) {
      templateIdMap.set(tpl.cronJobId, tpl.id)
    }
  }

  // Map cron jobs
  const rawJobs = readJobs()
  const cronJobs = rawJobs.map((j) => mapRawJobToCronJob(j, templateIdMap))

  // Build job name map
  const jobNameMap = new Map(rawJobs.map((j) => [j.id, j.name]))

  // Map execution logs (deduplicate dispatched/finished pairs)
  const allRuns = readAllRuns()
  const executionLogs: ExecutionLog[] = []
  for (const [jobId, runs] of allRuns) {
    const tplId = templateIdMap.get(jobId) ?? null
    // Drop "dispatched" (running) lines when a corresponding "finished" line exists
    const finishedRunAts = new Set(
      runs.filter((r) => r.action === 'finished' || (r.status !== 'running' && r.durationMs > 0)).map((r) => r.runAtMs)
    )
    const deduped = runs.filter(
      (r) => !(r.status === 'running' && r.runAtMs && finishedRunAts.has(r.runAtMs))
    )
    for (const run of deduped) {
      executionLogs.push({
        id: `${jobId}-${run.ts}-${run.durationMs}`,
        cronJobId: jobId,
        cronJobName: jobNameMap.get(jobId) ?? null,
        templateId: tplId,
        stdout: run.summary ?? '',
        stderr: run.error ?? '',
        exitCode: run.status === 'ok' ? 0 : 1,
        durationMs: run.durationMs,
        status: run.status === 'ok' ? 'ok' : 'failed',
        model: run.model ?? 'unknown',
        promptTokens: run.usage?.input_tokens ?? null,
        completionTokens: run.usage?.output_tokens ?? null,
        costUsd: computeCostUsd(run.model, run.usage) || null,
        generationId: run.sessionId ?? null,
        executedAt: new Date(run.ts).toISOString(),
      })
    }
  }

  // Query pre-instructions
  const dbPreInstruction = db.select().from(preInstructionsTable).where(eq(preInstructionsTable.id, 1)).get()
  const preInstruction: PreInstruction = {
    content: dbPreInstruction?.content ?? '',
    updatedAt: dbPreInstruction?.updatedAt ?? new Date().toISOString(),
  }

  return { templates, cronJobs, executionLogs, preInstruction }
}
