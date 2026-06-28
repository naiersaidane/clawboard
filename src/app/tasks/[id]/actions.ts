'use server'

import { spawn } from 'child_process'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { templates, preInstructions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { readJobs, appendRun } from '@/lib/cron/reader'
import { runOpenclaw } from '@/lib/cron/cli'
import { getOpenclawSpawn } from '@/lib/config'
import type { TaskEditPayload } from '@/components/task-detail/types'

export async function runAgainTask(cronJobId: string) {
  const tpl = db.select().from(templates).where(eq(templates.cronJobId, cronJobId)).get()

  let message: string
  let model: string | undefined
  if (tpl) {
    const pre = db.select().from(preInstructions).where(eq(preInstructions.id, 1)).get()
    const parts = [
      tpl.skipPreInstructions ? null : pre?.content,
      tpl.preInstructions,
      tpl.skillName ? `Utilise le skill ${tpl.skillName}, lis attentivement ses instructions et exécute-les.` : null,
      tpl.instructions,
    ].filter(Boolean).join('\n\n---\n\n')
    message = parts
    model = tpl.model || undefined

    // Increment execution count
    db.update(templates)
      .set({ executionCount: tpl.executionCount + 1, updatedAt: new Date().toISOString() })
      .where(eq(templates.id, tpl.id))
      .run()
  } else {
    // Fallback to raw job payload
    const jobs = readJobs()
    const job = jobs.find((j) => j.id === cronJobId)
    if (!job) return
    message = job.payload.message
    model = job.payload.model
  }

  const agent = tpl?.agentId || 'main'
  const args = ['agent', '--agent', agent, '-m', message]
  if (tpl?.deliveryChannel && tpl?.deliveryRecipient) {
    args.push('--deliver', '--reply-channel', tpl.deliveryChannel, '--reply-to', tpl.deliveryRecipient)
  }

  const startMs = Date.now()

  // Write immediate "dispatched" line so the UI reflects the launch
  appendRun(cronJobId, {
    ts: startMs,
    jobId: cronJobId,
    action: 'dispatched',
    status: 'running',
    summary: 'Exécution lancée manuellement',
    runAtMs: startMs,
    durationMs: 0,
    model,
    source: 'clawboard-manual',
  })

  const spawnCmd = getOpenclawSpawn(args)
  if (!spawnCmd) {
    appendRun(cronJobId, {
      ts: Date.now(), jobId: cronJobId, action: 'finished', status: 'error',
      summary: 'OpenClaw CLI non trouvé. Configurez OPENCLAW_CLI_PATH ou vérifiez votre installation Docker.',
      runAtMs: startMs, durationMs: 0, model, source: 'clawboard-manual',
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

    appendRun(cronJobId, {
      ts: Date.now(),
      jobId: cronJobId,
      action: 'finished',
      status,
      summary,
      runAtMs: startMs,
      durationMs,
      model,
      source: 'clawboard-manual',
    })
  })

  child.unref()

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${cronJobId}`)
}

export async function editTask(cronJobId: string, updates: TaskEditPayload) {
  // Met à jour le nom du job côté Gateway
  const res = runOpenclaw(['cron', 'edit', cronJobId, '--name', updates.name])
  if (!res.ok) console.error('[clawboard] cron edit (rename) a échoué :', res.stderr)

  // Update template instructions in SQLite if linked
  const tpl = db.select().from(templates).where(eq(templates.cronJobId, cronJobId)).get()
  if (tpl) {
    db.update(templates)
      .set({
        name: updates.name,
        instructions: updates.instructions,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(templates.id, tpl.id))
      .run()
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${cronJobId}`)
}

export async function archiveTask(cronJobId: string) {
  const res = runOpenclaw(['cron', 'disable', cronJobId])
  if (!res.ok) console.error('[clawboard] cron disable (archive) a échoué :', res.stderr)

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${cronJobId}`)
}

export async function deleteTask(cronJobId: string) {
  const res = runOpenclaw(['cron', 'rm', cronJobId])
  if (!res.ok) console.error('[clawboard] cron rm (delete) a échoué :', res.stderr)

  // Unlink template
  const tpl = db.select().from(templates).where(eq(templates.cronJobId, cronJobId)).get()
  if (tpl) {
    db.update(templates)
      .set({ cronJobId: null, updatedAt: new Date().toISOString() })
      .where(eq(templates.id, tpl.id))
      .run()
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${cronJobId}`)
}
