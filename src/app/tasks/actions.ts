'use server'

import crypto from 'crypto'
import { spawn } from 'child_process'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { templates, preInstructions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { CronExpressionParser } from 'cron-parser'
import { readJobs, writeJobs, appendRun } from '@/lib/cron/reader'
import { getOpenclawSpawn } from '@/lib/config'
import type { Template } from '@/components/tasks/types'
import type { RawJob } from '@/lib/cron/types'

function buildMessage(tpl: { preInstructions: string | null; skillName: string | null; instructions: string; skipPreInstructions?: number | boolean }, globalPre?: string | null): string {
  return [
    tpl.skipPreInstructions ? null : globalPre,
    tpl.preInstructions,
    tpl.skillName ? `Utilise le skill ${tpl.skillName}, lis attentivement ses instructions et exécute-les.` : null,
    tpl.instructions,
  ].filter(Boolean).join('\n\n---\n\n')
}

function syncJobWithTemplate(tpl: typeof import('@/lib/db/schema').templates.$inferSelect): void {
  if (!tpl.cronJobId) return
  const jobs = readJobs()
  const job = jobs.find((j) => j.id === tpl.cronJobId)
  if (!job) return

  const pre = db.select().from(preInstructions).where(eq(preInstructions.id, 1)).get()
  job.payload.message = buildMessage(tpl, pre?.content)
  job.name = tpl.name
  if (tpl.model) job.payload.model = tpl.model
  if (tpl.deliveryChannel && job.delivery) {
    job.delivery.channel = tpl.deliveryChannel
    job.delivery.to = tpl.deliveryRecipient ? `channel:${tpl.deliveryRecipient}` : undefined
  }
  job.sessionTarget = (tpl.sessionTarget as RawJob['sessionTarget']) || 'current'
  job.updatedAtMs = Date.now()
  writeJobs(jobs)
}

export async function createTemplate(
  data: Omit<Template, 'id' | 'executionCount' | 'createdAt' | 'updatedAt'>
) {
  const now = new Date().toISOString()
  db.insert(templates).values({
    id: crypto.randomUUID(),
    name: data.name,
    skillName: data.skillName,
    instructions: data.instructions,
    preInstructions: data.preInstructions,
    agentId: data.agentId,
    deliveryChannel: data.deliveryChannel,
    deliveryRecipient: data.deliveryRecipient,
    model: data.model,
    sessionTarget: data.sessionTarget || 'current',
    skipPreInstructions: data.skipPreInstructions ? 1 : 0,
    cronJobId: data.cronJobId,
    executionCount: 0,
    createdAt: now,
    updatedAt: now,
  }).run()
  revalidatePath('/tasks')
}

export async function updateTemplate(id: string, updates: Partial<Template>) {
  const now = new Date().toISOString()
  const { id: _id, createdAt: _ca, executionCount: _ec, skipPreInstructions, ...rest } = updates
  db.update(templates)
    .set({ ...rest, ...(skipPreInstructions !== undefined && { skipPreInstructions: skipPreInstructions ? 1 : 0 }), updatedAt: now })
    .where(eq(templates.id, id))
    .run()

  // Sync changes to jobs.json if template is linked to a cron job
  const tpl = db.select().from(templates).where(eq(templates.id, id)).get()
  if (tpl) syncJobWithTemplate(tpl)

  revalidatePath('/tasks')
}

export async function deleteTemplate(id: string) {
  db.delete(templates).where(eq(templates.id, id)).run()
  revalidatePath('/tasks')
}

export async function runNow(templateId: string) {
  const tpl = db.select().from(templates).where(eq(templates.id, templateId)).get()
  if (!tpl) return

  const pre = db.select().from(preInstructions).where(eq(preInstructions.id, 1)).get()
  const parts = buildMessage(tpl, pre?.content)

  const agent = tpl.agentId || 'main'
  const args = ['agent', '--agent', agent, '-m', parts]
  if (tpl.deliveryChannel && tpl.deliveryRecipient) {
    args.push('--deliver', '--reply-channel', tpl.deliveryChannel, '--reply-to', tpl.deliveryRecipient)
  }

  const jobId = tpl.cronJobId || `clawboard-manual-${tpl.id}`
  const startMs = Date.now()

  // Write immediate "dispatched" line so the UI reflects the launch
  appendRun(jobId, {
    ts: startMs,
    jobId,
    action: 'dispatched',
    status: 'running',
    summary: 'Exécution lancée manuellement',
    runAtMs: startMs,
    durationMs: 0,
    model: tpl.model || undefined,
    source: 'clawboard-manual',
  })

  const spawnCmd = getOpenclawSpawn(args)
  if (!spawnCmd) {
    appendRun(jobId, {
      ts: Date.now(), jobId, action: 'finished', status: 'error',
      summary: 'OpenClaw CLI non trouvé. Configurez OPENCLAW_CLI_PATH ou vérifiez votre installation Docker.',
      runAtMs: startMs, durationMs: 0, model: tpl.model || undefined, source: 'clawboard-manual',
    })
    return
  }

  const child = spawn(spawnCmd.cmd, spawnCmd.args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

  child.on('close', (code) => {
    const durationMs = Date.now() - startMs
    const status = code === 0 ? 'ok' : 'error'
    const summary = status === 'ok'
      ? (stdout.trim().slice(-500) || 'Exécution terminée')
      : (stderr.trim().slice(-500) || `Exit code ${code}`)

    appendRun(jobId, {
      ts: Date.now(),
      jobId,
      action: 'finished',
      status,
      summary,
      runAtMs: startMs,
      durationMs,
      model: tpl.model || undefined,
      source: 'clawboard-manual',
    })
  })

  child.unref()

  // Increment execution count
  db.update(templates)
    .set({ executionCount: tpl.executionCount + 1, updatedAt: new Date().toISOString() })
    .where(eq(templates.id, templateId))
    .run()

  revalidatePath('/tasks')
}

export async function toggleSchedule(cronJobId: string, enabled: boolean) {
  const jobs = readJobs()
  const job = jobs.find((j) => j.id === cronJobId)
  if (!job) return
  job.enabled = enabled
  job.updatedAtMs = Date.now()
  writeJobs(jobs)
  revalidatePath('/tasks')
}

export async function createSchedule(data: {
  templateId: string
  cronExpression: string
  timezone: string
}) {
  const jobs = readJobs()
  const tpl = db.select().from(templates).where(eq(templates.id, data.templateId)).get()
  if (!tpl) return

  const jobId = `clawboard-${crypto.randomUUID().slice(0, 8)}`
  const now = Date.now()

  // Build the full message from pre-instructions + template
  const pre = db.select().from(preInstructions).where(eq(preInstructions.id, 1)).get()
  const messageParts = buildMessage(tpl, pre?.content)

  const newJob: RawJob = {
    id: jobId,
    agentId: tpl.agentId || 'main',
    name: tpl.name,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: {
      kind: 'cron',
      expr: data.cronExpression,
      tz: data.timezone,
    },
    sessionTarget: (tpl.sessionTarget as RawJob['sessionTarget']) || 'current',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: messageParts,
      model: tpl.model || undefined,
    },
    state: {
      nextRunAtMs: (() => {
        try {
          const interval = CronExpressionParser.parse(data.cronExpression, { tz: data.timezone })
          return interval.next().getTime()
        } catch { return 0 }
      })(),
      lastRunAtMs: 0,
      lastStatus: '',
      lastDurationMs: 0,
      consecutiveErrors: 0,
    },
    delivery: tpl.deliveryChannel ? {
      mode: 'announce',
      bestEffort: true,
      channel: tpl.deliveryChannel,
      to: tpl.deliveryRecipient ? `channel:${tpl.deliveryRecipient}` : undefined,
    } : undefined,
  }

  jobs.push(newJob)
  writeJobs(jobs)

  // Link template to cron job
  db.update(templates)
    .set({ cronJobId: jobId, updatedAt: new Date().toISOString() })
    .where(eq(templates.id, data.templateId))
    .run()

  revalidatePath('/tasks')
}

export async function updateSchedule(
  cronJobId: string,
  updates: { cronExpression?: string; timezone?: string; enabled?: boolean }
) {
  const jobs = readJobs()
  const job = jobs.find((j) => j.id === cronJobId)
  if (!job) return

  if (updates.cronExpression !== undefined) job.schedule.expr = updates.cronExpression
  if (updates.timezone !== undefined) job.schedule.tz = updates.timezone
  if (updates.enabled !== undefined) job.enabled = updates.enabled
  job.updatedAtMs = Date.now()

  // Recalculate next run time when expression or timezone changes
  if (updates.cronExpression !== undefined || updates.timezone !== undefined) {
    try {
      const interval = CronExpressionParser.parse(job.schedule.expr, { tz: job.schedule.tz })
      job.state.nextRunAtMs = interval.next().getTime()
    } catch { /* keep existing nextRunAtMs */ }
  }

  writeJobs(jobs)
  revalidatePath('/tasks')
}

export async function deleteSchedule(cronJobId: string) {
  const jobs = readJobs()
  const filtered = jobs.filter((j) => j.id !== cronJobId)
  writeJobs(filtered)

  // Clear cronJobId from template
  const tpl = db.select().from(templates).where(eq(templates.cronJobId, cronJobId)).get()
  if (tpl) {
    db.update(templates)
      .set({ cronJobId: null, updatedAt: new Date().toISOString() })
      .where(eq(templates.id, tpl.id))
      .run()
  }

  revalidatePath('/tasks')
}

export async function savePreInstructions(content: string) {
  const now = new Date().toISOString()
  db.update(preInstructions)
    .set({ content, updatedAt: now })
    .where(eq(preInstructions.id, 1))
    .run()

  // Sync all linked jobs with updated pre-instructions
  const allTemplates = db.select().from(templates).all()
  for (const tpl of allTemplates) {
    syncJobWithTemplate(tpl)
  }

  revalidatePath('/tasks')
}
