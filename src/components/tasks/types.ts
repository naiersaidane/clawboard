// ── Data Interfaces ──────────────────────────────────────────────

export interface Template {
  id: string;
  name: string;
  skillName: string | null;
  instructions: string;
  preInstructions: string | null;
  agentId: string;
  deliveryChannel: string;
  deliveryRecipient: string | null;
  model: string;
  sessionTarget: string;
  skipPreInstructions: boolean;
  cronJobId: string | null;
  executionCount: number;
  createdAt: string;
  updatedAt: string;
}

export type CronStatus = "ok" | "error" | null;

export interface CronJob {
  id: string;
  name: string;
  templateId: string | null;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  frequencyLabel: string;
  lastRunAtMs: number | null;
  lastStatus: CronStatus;
  nextRunAtMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

export type ExecutionStatus = "ok" | "failed";

export interface ExecutionLog {
  id: string;
  cronJobId: string | null;
  cronJobName: string | null;
  templateId: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  status: ExecutionStatus;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  generationId: string | null;
  executedAt: string;
}

export interface PreInstruction {
  content: string;
  updatedAt: string;
}

// ── Kanban Display Types ─────────────────────────────────────────

export type KanbanColumn =
  | "planned"
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface KanbanCard {
  cronJob: CronJob;
  template: Template | null;
  column: KanbanColumn;
}

// ── Tab Type ─────────────────────────────────────────────────────

export type TabId =
  | "tasks"
  | "templates"
  | "schedules"
  | "pre-instructions"
  | "archives";

// ── Props Interface ──────────────────────────────────────────────

export interface TasksProps {
  templates: Template[];
  cronJobs: CronJob[];
  executionLogs: ExecutionLog[];
  preInstruction: PreInstruction;
  activeTab: TabId;
  templateDefaults?: { agentId: string; deliveryChannel: string; model: string };
  onTabChange?: (tab: TabId) => void;
  onCreateTemplate?: (
    template: Omit<Template, "id" | "executionCount" | "createdAt" | "updatedAt">
  ) => void;
  onUpdateTemplate?: (id: string, updates: Partial<Template>) => void;
  onDeleteTemplate?: (id: string) => void;
  onRunNow?: (templateId: string) => void;
  onToggleSchedule?: (cronJobId: string, enabled: boolean) => void;
  onCreateSchedule?: (schedule: {
    templateId: string;
    cronExpression: string;
    timezone: string;
  }) => void;
  onUpdateSchedule?: (
    cronJobId: string,
    updates: Partial<Pick<CronJob, "cronExpression" | "timezone" | "enabled">>
  ) => void;
  onDeleteSchedule?: (cronJobId: string) => void;
  onSavePreInstructions?: (content: string) => void;
  onViewTaskDetail?: (cronJobId: string) => void;
  onFilterArchives?: (filters: {
    search?: string;
    templateId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) => void;
}
