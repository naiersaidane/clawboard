import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const templates = sqliteTable('templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  skillName: text('skill_name'),
  instructions: text('instructions').notNull(),
  preInstructions: text('pre_instructions'),
  agentId: text('agent_id').notNull().default('main'),
  deliveryChannel: text('delivery_channel').notNull().default('discord'),
  deliveryRecipient: text('delivery_recipient'),
  model: text('model').notNull().default('openrouter/anthropic/claude-sonnet-4'),
  sessionTarget: text('session_target').default('current'),
  skipPreInstructions: integer('skip_pre_instructions').notNull().default(0),
  cronJobId: text('cron_job_id'),
  executionCount: integer('execution_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const preInstructions = sqliteTable('pre_instructions', {
  id: integer('id').primaryKey().default(1),
  content: text('content').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
})
