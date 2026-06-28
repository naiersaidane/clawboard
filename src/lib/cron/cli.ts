import { execFileSync } from 'child_process'
import { getOpenclawSpawn } from '@/lib/config'

export interface OpenclawResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Exécute une commande openclaw de façon synchrone via le CLI natif (ou Docker).
 *
 * args : ex. ['cron', 'list', '--all', '--json']
 *
 * Utilise execFile (PAS de shell) : les arguments contenant des sauts de ligne,
 * accents ou guillemets sont passés tels quels, sans risque d'injection ni de
 * mauvais échappement. C'est essentiel car les messages des jobs sont multi-lignes.
 *
 * Depuis OpenClaw 2026.6.8 le stockage cron est en SQLite et le CLI parle au
 * Gateway (source de vérité). On passe donc systématiquement par lui pour lire
 * et muter les jobs, au lieu de l'ancien fichier cron/jobs.json (supprimé).
 */
export function runOpenclaw(args: string[], opts: { timeoutMs?: number } = {}): OpenclawResult {
  const spawn = getOpenclawSpawn(args)
  if (!spawn) {
    return {
      ok: false,
      stdout: '',
      stderr: 'OpenClaw CLI introuvable (configurez OPENCLAW_CLI_PATH ou vérifiez Docker).',
    }
  }
  try {
    const stdout = execFileSync(spawn.cmd, spawn.args, {
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout ?? '', stderr: '' }
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? ''
    const stderr =
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString()) || e.message || 'Erreur openclaw'
    return { ok: false, stdout, stderr }
  }
}
