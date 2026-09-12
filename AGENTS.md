# ClawBoard

Dashboard de monitoring pour les crons OpenClaw. Next.js 16 + Tailwind 4 + SQLite (Drizzle) + TypeScript.

## Stack

- **Framework**: Next.js 16.1.6 (App Router, Server Actions, Turbopack)
- **DB**: SQLite via better-sqlite3 + Drizzle ORM (`clawboard.db`)
- **UI**: Tailwind CSS v4, Lucide icons
- **Repo**: `croissanceIA/clawboard`

## Architecture

- Les crons sont gérés par **OpenClaw** (système externe) via `jobs.json` + `runs/*.jsonl`
- ClawBoard lit/écrit dans `$OPENCLAW_CRON_PATH` pour afficher et gérer les jobs
- Les **templates** (modèles de tâches) sont stockés dans SQLite
- Les **schedules** (récurrences) sont écrites dans `jobs.json` d'OpenClaw
- `runNow()` lance `openclaw agent` via `spawn` detached (le process doit survivre après la réponse)
- La configuration est centralisée dans `src/lib/config.ts` (lit les env vars)

## Fichiers clés

| Fichier | Rôle |
|---------|------|
| `src/lib/config.ts` | Configuration centralisée (env vars, auto-détection CLI) |
| `src/app/page.tsx` | Dashboard — appelle `aggregateDashboard()` |
| `src/app/tasks/page.tsx` | Page tâches — appelle `aggregateTasks()` |
| `src/app/tasks/actions.ts` | Server Actions : createTemplate, createSchedule, runNow, etc. |
| `src/lib/cron/reader.ts` | Lit jobs.json et runs/*.jsonl depuis `$OPENCLAW_CRON_PATH` |
| `src/lib/cron/aggregator.ts` | Calcule stats dashboard (filtre par jour) |
| `src/lib/cron/tasks-aggregator.ts` | Agrège templates + jobs + runs pour la page tâches |
| `src/lib/cron/pricing.ts` | Calcul des coûts par modèle/tokens |
| `src/lib/cron/types.ts` | Types RawJob, RawRunLine (format on-disk OpenClaw) |
| `src/lib/db/schema.ts` | Schema Drizzle (templates, preInstructions) |
| `src/components/tasks/KanbanBoard.tsx` | Kanban avec logique temporelle (nextRunAtMs) |
| `src/components/tasks/TemplatesGrid.tsx` | Grille modèles avec bouton Exécuter |
| `src/components/tasks/ScheduleTimeline.tsx` | Timeline des récurrences |
| `src/components/SetupGuide.tsx` | Guide de configuration affiché si pas configuré |

## Configuration

Voir `.env.example` pour toutes les variables. Configuration via `npm run setup` ou manuellement dans `.env.local`.

**Important** : `.env.local` doit exister AVANT `npm run build` (Next.js intègre les env au build)

## OpenClaw CLI

- Le chemin vers le binaire est configurable via `OPENCLAW_CLI_PATH` (auto-détecté sinon)
- Syntaxe : `openclaw agent --agent main -m 'message' --deliver --reply-channel discord --reply-to 'channel_id'`
- Les jobs dans jobs.json doivent avoir `payload.kind: "agentTurn"`, `sessionTarget: "isolated"`, `wakeMode: "now"`
- `delivery.mode: "announce"`, `delivery.to: "channel:xxx"` (pas `recipient`)

## Conventions

- UI en français
- Server Actions (pas d'API REST)
- `revalidatePath('/tasks')` après chaque mutation
- Les crons sont identifiés par UUID, ceux créés via ClawBoard ont un préfixe `clawboard-`
