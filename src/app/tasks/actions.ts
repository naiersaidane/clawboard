'use server'

import crypto from 'crypto'
import { spawn } from 'child_process'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { templates, preInstructions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { appendRun } from '@/lib/cron/reader'
import { runOpenclaw } from '@/lib/cron/cli'
import { getOpenclawSpawn } from '@/lib/config'
import type { Template } from '@/components/tasks/types'

function buildMessage(tpl: { preInstructions: string | null; skillName: string | null; instructions: string; skipPreInstructions?: number | boolean }, globalPre?: string | null): string {
  return [
    tpl.skipPreInstructions ? null : globalPre,
    tpl.preInstructions,
    tpl.skillName ? `Utilise le skill ${tpl.skillName}, lis attentivement ses instructions et exécute-les.` : null,
    tpl.instructions,
  ].filter(Boolean).join('\n\n---\n\n')
}

/**
 * Arguments CLI de livraison (--announce + canal + destinataire).
 * Reproduit le delivery historique : { mode: 'announce', channel, to: 'channel:<id>', bestEffort: true }.
 */
function deliveryArgs(channel?: string | null, recipient?: string | null): string[] {
  if (!channel || !recipient) return []
  const dest = recipient.includes(':') ? recipient : `channel:${recipient}`
  return ['--announce', '--best-effort-deliver', '--channel', channel, '--to', dest]
}

/**
 * Argument CLI de session. Le CLI n'accepte que main|isolated ;
 * la valeur historique 'current' (défaut Clawboard) laisse le défaut du Gateway.
 */
function sessionArgs(sessionTarget?: string | null): string[] {
  if (sessionTarget === 'isolated' || sessionTarget === 'main') return ['--session', sessionTarget]
  return []
}

/** Synchronise le job cron lié (nom, message, modèle, livraison, session) via `openclaw cron edit`. */
function syncJobWithTemplate(tpl: typeof import('@/lib/db/schema').templates.$inferSelect): void {
  if (!tpl.cronJobId) return
  const pre = db.select().from(preInstructions).where(eq(preInstructions.id, 1)).get()
  const message = buildMessage(tpl, pre?.content)

  const args = ['cron', 'edit', tpl.cronJobId, '--name', tpl.name, '--message', message]
  if (tpl.model) args.push('--model', tpl.model)
  args.push(...sessionArgs(tpl.sessionTarget))
  args.push(...deliveryArgs(tpl.deliveryChannel, tpl.deliveryRecipient))

  const res = runOpenclaw(args)
  if (!res.ok) console.error('[clawboard] cron edit (sync template) a échoué :', res.stderr)
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

  // Propage les changements au job cron lié (le cas échéant)
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
  const res = runOpenclaw(['cron', enabled ? 'enable' : 'disable', cronJobId])
  if (!res.ok) console.error('[clawboard] cron enable/disable a échoué :', res.stderr)
  revalidatePath('/tasks')
}

export async function createSchedule(data: {
  templateId: string
  cronExpression: string
  timezone: string
}) {
  const tpl = db.select().from(templates).where(eq(templates.id, data.templateId)).get()
  if (!tpl) return

  const pre = db.select().from(preInstructions).where(eq(preInstructions.id, 1)).get()
  const message = buildMessage(tpl, pre?.content)

  const args = [
    'cron', 'add',
    '--name', tpl.name,
    '--agent', tpl.agentId || 'main',
    '--cron', data.cronExpression,
    '--tz', data.timezone,
    '--message', message,
    '--wake', 'now',
    '--json',
  ]
  if (tpl.model) args.push('--model', tpl.model)
  args.push(...sessionArgs(tpl.sessionTarget))
  args.push(...deliveryArgs(tpl.deliveryChannel, tpl.deliveryRecipient))

  const res = runOpenclaw(args)
  if (!res.ok) {
    console.error('[clawboard] cron add a échoué :', res.stderr)
    return
  }

  let jobId: string | undefined
  try {
    jobId = (JSON.parse(res.stdout) as { id?: string }).id
  } catch {
    console.error('[clawboard] cron add : réponse JSON illisible :', res.stdout.slice(0, 200))
  }
  if (!jobId) return

  // Lie le template au job cron créé
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
  const args = ['cron', 'edit', cronJobId]
  if (updates.cronExpression !== undefined) args.push('--cron', updates.cronExpression)
  if (updates.timezone !== undefined) args.push('--tz', updates.timezone)
  if (updates.enabled === true) args.push('--enable')
  else if (updates.enabled === false) args.push('--disable')

  // Rien à modifier
  if (args.length <= 3) {
    revalidatePath('/tasks')
    return
  }

  const res = runOpenclaw(args)
  if (!res.ok) console.error('[clawboard] cron edit (schedule) a échoué :', res.stderr)
  revalidatePath('/tasks')
}

export async function deleteSchedule(cronJobId: string) {
  const res = runOpenclaw(['cron', 'rm', cronJobId])
  if (!res.ok) console.error('[clawboard] cron rm a échoué :', res.stderr)

  // Détache le template
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

  // Resynchronise tous les jobs liés avec les nouvelles pre-instructions
  const allTemplates = db.select().from(templates).all()
  for (const tpl of allTemplates) {
    syncJobWithTemplate(tpl)
  }

  revalidatePath('/tasks')
}
