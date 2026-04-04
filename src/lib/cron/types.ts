// Raw types matching the on-disk format in $OPENCLAW_CRON_PATH

export interface RawJobSchedule {
  kind: string
  expr: string
  tz: string
}

export interface RawJobPayload {
  kind: string
  message: string
  model?: string
}

export interface RawJobState {
  nextRunAtMs: number
  lastRunAtMs: number
  lastStatus: string
  lastDurationMs: number
  consecutiveErrors?: number
  runningAtMs?: number
  lastRunStatus?: string
  lastDelivered?: boolean
  lastDeliveryStatus?: string
}

export interface RawJobDelivery {
  mode: string
  bestEffort?: boolean
  channel?: string
  to?: string
  recipient?: string
}

export interface RawJob {
  id: string
  agentId: string
  sessionKey?: string
  name: string
  enabled: boolean
  createdAtMs: number
  updatedAtMs: number
  schedule: RawJobSchedule
  sessionTarget?: 'isolated' | 'current' | 'main'
  wakeMode?: string
  payload: RawJobPayload
  state: RawJobState
  delivery?: RawJobDelivery
}

export interface RawJobsFile {
  version: number
  jobs: RawJob[]
}

export interface RawRunLineUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface RawRunLine {
  ts: number
  jobId: string
  action: string
  status: string
  runAtMs: number
  durationMs: number
  nextRunAtMs: number
  summary?: string
  error?: string
  sessionId?: string
  sessionKey?: string
  model?: string
  provider?: string
  usage?: RawRunLineUsage
}
