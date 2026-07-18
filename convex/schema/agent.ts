import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Agent domain tables — Cola's agentic OS for sellers (the autonomous worker
 * behind the `/s/[slug]` workspace). See convex/CONVENTIONS.md for the Postgres
 * -> Convex translation rules every table here follows (string `id`, ISO-8601
 * timestamps as v.string(), CHECK enums -> v.union of v.literal, nullable ->
 * v.optional, jsonb -> v.any, integer counts -> v.number, bool -> v.boolean,
 * text[] -> v.array(v.string())).
 *
 * NOTE ON IDS: AgentGoal and AgentQuestion had `uuid` PKs in Postgres (every
 * other table is `text`/`gen_random_uuid()::text`). Convex stores all app ids as
 * v.string() regardless — `crypto.randomUUID()` produces the same canonical UUID
 * text the old `uuid::text` cast yielded, so FKs/URLs are unchanged.
 *
 * STATE MACHINES preserved as v.union literals (validated, never free text):
 *   - AgentTask.status: queued|running|paused|completed|failed|cancelled
 *     (transition guard VALID_TRANSITIONS lives in lib/agent/task-state-machine;
 *      the compare-and-swap that enforced it stays a read-then-patch mutation).
 *   - AgentGoal.status: active|completed|cancelled|paused.
 *   - AgentQuestion.status: pending|answered|expired.
 *   - AgentPausedRun.status: pending|resumed|cancelled|expired.
 *   - AgentDraft.status: pending|approved|dismissed|sent.
 *   - ExecutionStep.status: pending|running|completed|failed|skipped.
 *
 * UNIQUENESS INVARIANTS Postgres enforced (no native Convex equivalent) — each
 * is re-implemented as a read-then-insert/patch inside ONE serializable mutation
 * (stronger than the old non-atomic Supabase writes), noted per table:
 *   - AgentSettings_spaceId_key UNIQUE(spaceId): one settings row per space
 *     (the PATCH route upserts on spaceId).
 *   - AgentDraft_idempotencyKey_key UNIQUE(idempotencyKey).
 *   - ExecutionStep_idempotencyKey_key UNIQUE(idempotencyKey).
 *   - TaskDependency_taskId_dependsOnTaskId_key UNIQUE(taskId, dependsOnTaskId).
 *
 * CASCADES Postgres did on AgentTask delete (re-implemented in the cleanup +
 * task-delete mutations, see convex/agent/tasks.ts / activity.ts):
 *   - ExecutionStep.taskId, GoalDecomposition.taskId, TaskCheckpoint.taskId,
 *     TaskDependency.taskId, TaskDependency.dependsOnTaskId -> ON DELETE CASCADE.
 *   - AgentTask.parentTaskId -> ON DELETE SET NULL (children survive).
 *   - Cross-domain (NOT this domain's tables, cannot enforce here, flagged in
 *     the report): AgentMemory.taskId -> SET NULL, Artifact.taskId -> SET NULL,
 *     Artifact.stepId -> SET NULL on ExecutionStep delete.
 *
 * No money lives in this domain. `estimatedCostUsd`/`costUsd` are USD numerics
 * (admin telemetry, NOT cents) carried as v.number verbatim and never recomputed.
 */
export const agentTables = {
  // Was: "AgentTask" (text id, spaceId, title, description nullable, status
  // default 'queued' CHECK, triggerSource default 'manual', goalDescription
  // nullable, parentTaskId nullable [self-FK SET NULL], totalSteps/completedSteps/
  // inputTokens/outputTokens int default 0, estimatedCostUsd numeric(10,6)
  // default 0, metadata jsonb default '{}', startedAt/completedAt/cancelledAt
  // nullable, createdAt, updatedAt).
  AgentTask: defineTable({
    id: v.string(),
    spaceId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('paused'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('cancelled'),
    ),
    triggerSource: v.string(), // default 'manual' (free text source label, not a CHECK enum)
    goalDescription: v.optional(v.string()),
    parentTaskId: v.optional(v.string()),
    totalSteps: v.number(),
    completedSteps: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    estimatedCostUsd: v.number(), // USD numeric (admin telemetry, not cents)
    metadata: v.any(), // jsonb default {} — carries pausedReason, approvalRequired, etc.
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    cancelledAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Every per-row read/update keys by id (task detail, status PATCH, delete,
    // state-machine transition, approvals). Also backs the cascade-delete read.
    .index('by_app_id', ['id'])
    // List a space's tasks newest-first (AgentTask_spaceId_status_idx covered
    // (spaceId,status); the tasks list orders by createdAt desc). The approvals/
    // inbox views filter (spaceId,status='paused'); we filter status in-handler
    // after the spaceId range so one compound index serves both.
    .index('by_space_status', ['spaceId', 'status'])
    .index('by_space_created', ['spaceId', 'createdAt'])
    // Children of a parent task (AgentTask_parentTaskId_idx) — used by the
    // parentTaskId SET-NULL cascade on parent delete.
    .index('by_parent', ['parentTaskId'])
    // Admin stats scan all tasks since a createdAt window (no spaceId filter).
    .index('by_created', ['createdAt']),

  // Was: "AgentDraft" (text id, spaceId, contactId nullable [FK CASCADE], dealId
  // nullable [FK SET NULL], channel CHECK sms|email|note, subject nullable,
  // content, reasoning nullable, priority int default 0, status default 'pending'
  // CHECK, expiresAt nullable, createdAt, updatedAt, confidence int nullable
  // (0..100), outcome varchar(30) nullable CHECK, outcomeDetectedAt nullable,
  // feedback_action text nullable CHECK, edit_distance int nullable, decision_ms
  // int nullable, outcome_signal text nullable, outcome_checked_at nullable,
  // idempotencyKey text nullable UNIQUE, triggerSource jsonb nullable).
  // SNAKE_CASE columns (feedback_action, edit_distance, decision_ms,
  // outcome_signal, outcome_checked_at) are kept verbatim so the call sites and
  // the draft-stats math read the exact same keys.
  AgentDraft: defineTable({
    id: v.string(),
    spaceId: v.string(),
    contactId: v.optional(v.string()),
    dealId: v.optional(v.string()),
    channel: v.union(v.literal('sms'), v.literal('email'), v.literal('note')),
    subject: v.optional(v.string()),
    content: v.string(),
    reasoning: v.optional(v.string()),
    priority: v.number(),
    status: v.union(
      v.literal('pending'),
      v.literal('approved'),
      v.literal('dismissed'),
      v.literal('sent'),
    ),
    expiresAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    confidence: v.optional(v.number()), // 0..100
    outcome: v.optional(
      v.union(
        v.literal('responded'),
        v.literal('no_response'),
        v.literal('bounced'),
        v.literal('unsubscribed'),
        v.literal('meeting_booked'),
      ),
    ),
    outcomeDetectedAt: v.optional(v.string()),
    feedback_action: v.optional(
      v.union(
        v.literal('approved'),
        v.literal('edited_and_approved'),
        v.literal('rejected'),
        v.literal('held'),
      ),
    ),
    edit_distance: v.optional(v.number()),
    decision_ms: v.optional(v.number()),
    outcome_signal: v.optional(v.string()), // 'deal_advanced' | 'none' | null
    outcome_checked_at: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    triggerSource: v.optional(v.any()), // jsonb (nullable) — NOT the AgentTask text field
  })
    // PATCH/feedback/batch-approve verify a draft by (id, spaceId); the id read
    // backs them. by_app_id is the per-row lookup.
    .index('by_app_id', ['id'])
    // The dominant filter is (spaceId, status) — list, the many pending-count
    // queries, momentum/morning/layout badges, summarize-seller. Pair with
    // createdAt for the newest-first / window scans (AgentDraft_spaceId_status_idx
    // was (spaceId,status,createdAt DESC)). priority is a secondary sort the
    // handler applies after collecting the (spaceId,status) range.
    .index('by_space_status', ['spaceId', 'status'])
    // Stats + voice-sample reads filter (spaceId, feedback_action NOT NULL) over
    // a createdAt/updatedAt window (AgentDraft_spaceId_feedback_action_idx).
    .index('by_space_feedback', ['spaceId', 'feedback_action'])
    // Contact-scoped reads: contact detail drafts, tip reply-rate / demo-drop,
    // gmail dedupe — filter (spaceId, contactId). Also the FK-CASCADE-on-Contact
    // analogue (Contact deletes its drafts) reads here.
    .index('by_space_contact', ['spaceId', 'contactId'])
    // Plain spaceId+createdAt window scans (tip reply-rate decline, gmail
    // recentlyDrafted) and any read that doesn't constrain status.
    .index('by_space_created', ['spaceId', 'createdAt'])
    // The outcomes cron pulls (status='sent', outcome_signal IS NULL) over an
    // updatedAt window across ALL spaces — no spaceId. Index status to bound it.
    .index('by_status_updated', ['status', 'updatedAt'])
    // UNIQUE(idempotencyKey) backstop for any idempotent insert (read-before-
    // insert inside the mutation). No current call site sets it, but the index
    // keeps the invariant available + completes the schema.
    .index('by_idempotency_key', ['idempotencyKey']),

  // Was: "AgentGoal" (uuid id, spaceId, contactId nullable [SET NULL], dealId
  // nullable [SET NULL], goalType varchar(50) CHECK, description, instructions
  // nullable, status varchar(20) default 'active' CHECK, priority int default 0,
  // metadata jsonb default '{}', completedAt nullable, createdAt, updatedAt).
  AgentGoal: defineTable({
    id: v.string(), // was uuid; canonical UUID text
    spaceId: v.string(),
    contactId: v.optional(v.string()),
    dealId: v.optional(v.string()),
    goalType: v.union(
      v.literal('follow_up_sequence'),
      v.literal('demo_booking'),
      v.literal('offer_progress'),
      v.literal('deal_close'),
      v.literal('reengagement'),
      v.literal('custom'),
    ),
    description: v.string(),
    instructions: v.optional(v.string()),
    status: v.union(
      v.literal('active'),
      v.literal('completed'),
      v.literal('cancelled'),
      v.literal('paused'),
    ),
    priority: v.number(),
    metadata: v.any(), // jsonb default {} — carries completionNotes
    completedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // PATCH/DELETE resolve a goal by (id, spaceId); id read backs the ownership
    // check.
    .index('by_app_id', ['id'])
    // List filters (spaceId, status) and optionally contactId, sorted by
    // (priority desc, createdAt desc) in-handler (AgentGoal_spaceId_status_idx).
    // contact-context reads (spaceId, contactId, status='active') — the
    // contactId is applied after the (spaceId,status) range.
    .index('by_space_status', ['spaceId', 'status'])
    // AgentGoal_contactId_idx (partial WHERE contactId NOT NULL) — direct
    // contact-scoped lookups.
    .index('by_contact', ['contactId'])
    // AgentGoal_dealId_idx (partial WHERE dealId NOT NULL).
    .index('by_deal', ['dealId']),

  // Was: "AgentQuestion" (uuid id, spaceId, runId varchar(100), agentType
  // varchar(50), question, context nullable, status varchar(20) default 'pending'
  // CHECK, answer nullable, answeredAt nullable, priority int default 0,
  // contactId nullable [SET NULL], createdAt).
  AgentQuestion: defineTable({
    id: v.string(), // was uuid; canonical UUID text
    spaceId: v.string(),
    runId: v.string(),
    agentType: v.string(),
    question: v.string(),
    context: v.optional(v.string()),
    status: v.union(v.literal('pending'), v.literal('answered'), v.literal('expired')),
    answer: v.optional(v.string()),
    answeredAt: v.optional(v.string()),
    priority: v.number(),
    contactId: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // PATCH answers a question by (id, spaceId); id read backs the ownership +
    // status guard.
    .index('by_app_id', ['id'])
    // List + morning count filter (spaceId, status), sorted (priority desc,
    // createdAt asc) in-handler (AgentQuestion_spaceId_status_idx).
    .index('by_space_status', ['spaceId', 'status'])
    // AgentQuestion_contactId_idx (partial WHERE contactId NOT NULL).
    .index('by_contact', ['contactId']),

  // Was: "AgentSettings" (text id, spaceId, enabled bool default false,
  // dailyTokenBudget int default 50000, createdAt, updatedAt, chatModel text
  // nullable). UNIQUE(spaceId): one row per space — the PATCH route upserts on
  // spaceId, re-implemented as read-by-space-then-patch-or-insert.
  AgentSettings: defineTable({
    id: v.string(),
    spaceId: v.string(),
    enabled: v.boolean(), // default false
    dailyTokenBudget: v.number(), // default 50000
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    chatModel: v.optional(v.string()), // null = use platform default model
  })
    // Every access is "the settings for this space" (read in usage/ai-task/
    // manager-task/swarm budget checks + workspace model load; upsert in PATCH).
    // UNIQUE(spaceId) enforced by the upsert reading this then patch-or-insert.
    .index('by_space', ['spaceId']),

  // Was: "AgentActivityLog" (text id, spaceId [CASCADE], runId, agentType,
  // actionType, reasoning nullable, outcome CHECK completed|queued_for_approval|
  // suggested|failed, relatedContactId nullable [SET NULL], relatedDealId
  // nullable [SET NULL], reversible bool default true, reversedAt nullable,
  // metadata jsonb nullable, createdAt).
  AgentActivityLog: defineTable({
    id: v.string(),
    spaceId: v.string(),
    runId: v.string(),
    agentType: v.string(),
    actionType: v.string(),
    reasoning: v.optional(v.string()),
    outcome: v.union(
      v.literal('completed'),
      v.literal('queued_for_approval'),
      v.literal('suggested'),
      v.literal('failed'),
    ),
    relatedContactId: v.optional(v.string()),
    relatedDealId: v.optional(v.string()),
    reversible: v.boolean(), // default true
    reversedAt: v.optional(v.string()),
    metadata: v.any(), // jsonb (nullable)
    createdAt: v.string(), // ISO-8601
  })
    // reverse route verifies an entry by (id, spaceId) then patches reversedAt.
    .index('by_app_id', ['id'])
    // Main activity feed + overnight brief filter (spaceId) then optional
    // (agentType / outcome) in-handler, newest-first
    // (AgentActivityLog_spaceId_createdAt_idx = (spaceId, createdAt DESC)).
    .index('by_space_created', ['spaceId', 'createdAt'])
    // Recent-runs list + the live-stream picker filter by runId
    // (AgentActivityLog_runId_idx).
    .index('by_run', ['runId'])
    // Deal/contact intelligence context reads filter (spaceId, relatedDealId) /
    // (spaceId, relatedContactId), newest-first.
    .index('by_space_deal', ['spaceId', 'relatedDealId'])
    .index('by_space_contact', ['spaceId', 'relatedContactId']),

  // Was: "AgentPausedRun" (text id, spaceId [CASCADE], userId, conversationId
  // nullable, runState text (serialized SDK state), approvals jsonb default '[]',
  // status default 'pending' CHECK, expiresAt nullable, createdAt, updatedAt).
  AgentPausedRun: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    conversationId: v.optional(v.string()),
    runState: v.string(), // serialized SDK run state (opaque text)
    approvals: v.any(), // jsonb array of pending approvals (default [])
    status: v.union(
      v.literal('pending'),
      v.literal('resumed'),
      v.literal('cancelled'),
      v.literal('expired'),
    ),
    expiresAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Resume route loads a run by id (then scope-checks userId/status/expiry) and
    // CAS-patches status pending->resumed by id.
    .index('by_app_id', ['id'])
    // AgentPausedRun_spaceId_status_idx (spaceId, status, createdAt DESC).
    .index('by_space_status', ['spaceId', 'status'])
    // AgentPausedRun_userId_idx.
    .index('by_user', ['userId'])
    // The cron sweep marks (status='pending', expiresAt < now) expired and
    // hard-deletes (createdAt < cutoff) across ALL spaces. Index status for the
    // expire pass; the createdAt sweep is a bounded full scan.
    .index('by_status', ['status'])
    .index('by_created', ['createdAt']),

  // Was: "ExecutionStep" (text id, taskId [CASCADE], spaceId, stepIndex int
  // default 0, toolName, toolArgs jsonb default '{}', toolResult jsonb nullable,
  // status default 'pending' CHECK, inputTokens/outputTokens int default 0,
  // costUsd numeric(10,6) default 0, idempotencyKey text nullable UNIQUE,
  // errorMessage nullable, startedAt/completedAt nullable, createdAt, stepType
  // text default 'tool_call', inputSummary nullable, outputSummary nullable).
  ExecutionStep: defineTable({
    id: v.string(),
    // PG declared taskId NOT NULL, but lib/agent/tool-call-logger inserts a NULL
    // taskId for chat-turn tool calls (sdk-chat-stream calls logToolCallStart
    // with taskId=undefined) — that insert silently FAILS today against the NOT
    // NULL column (the lib swallows the error), so those steps are never logged.
    // We make taskId OPTIONAL so task-less tool calls become first-class rows
    // (the honest fix the NOT NULL constraint blocked); the cascade/by_task_step
    // index still serves task-scoped reads. Flagged in the migration report.
    taskId: v.optional(v.string()),
    spaceId: v.string(),
    stepIndex: v.number(),
    toolName: v.string(),
    toolArgs: v.any(), // jsonb default {}
    toolResult: v.optional(v.any()), // jsonb (nullable)
    status: v.union(
      v.literal('pending'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('skipped'),
    ),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(), // USD numeric (telemetry, not cents)
    idempotencyKey: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    stepType: v.string(), // default 'tool_call'
    inputSummary: v.optional(v.string()),
    outputSummary: v.optional(v.string()),
  })
    // logToolCallComplete/Error patch a step by id. by_app_id backs the lookup.
    .index('by_app_id', ['id'])
    // Task detail lists a task's steps ordered by stepIndex (and the alt read
    // orders by startedAt — applied in-handler) (ExecutionStep_taskId_stepIndex_idx).
    // Also the AgentTask cascade-delete reads a task's steps here.
    .index('by_task_step', ['taskId', 'stepIndex'])
    // ExecutionStep_idempotencyKey_idx (partial WHERE idempotencyKey NOT NULL) —
    // dedup backstop for the one-per-key invariant; no current reader, kept for
    // completeness.
    .index('by_idempotency_key', ['idempotencyKey']),

  // Was: "CustomAgent" (text id, spaceId [CASCADE], name, description nullable,
  // systemPrompt text default '', model text default 'gpt-4o-mini', capabilities
  // jsonb default '[]', isActive bool default true, createdAt, updatedAt).
  CustomAgent: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.string(), // default ''
    model: v.string(), // default 'gpt-4o-mini'
    capabilities: v.any(), // jsonb array (default [])
    isActive: v.boolean(), // default true; false = soft-deleted
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Edit/get/update/soft-delete + swarm load resolve by id (then scope-check
    // spaceId in the route). CustomAgent_spaceId_idx covers the list reads
    // (spaceId, isActive=true) — isActive filtered in-handler.
    .index('by_app_id', ['id'])
    .index('by_space', ['spaceId']),

  // Was: "Routine" (text id, spaceId [CASCADE], instruction, cadence default
  // 'daily' CHECK hourly|daily|weekdays|monthly|custom, hour int default 13
  // (0..23), enabled bool default true, lastRunAt nullable, lastRunStatus
  // nullable CHECK ok|error, nextRunAt NOT NULL, createdAt, updatedAt, dayOfMonth
  // int nullable (1..28), daysOfWeek text[] nullable (mon..sun)).
  //
  // nextRunAt was computed by a Postgres BEFORE INSERT/UPDATE trigger
  // (routine_set_next_run -> routine_next_run_at). Convex has no triggers, so the
  // create/update/stamp mutations PORT routine_next_run_at and set nextRunAt +
  // updatedAt themselves (see convex/agent/routines.ts).
  Routine: defineTable({
    id: v.string(),
    spaceId: v.string(),
    instruction: v.string(),
    cadence: v.union(
      v.literal('hourly'),
      v.literal('daily'),
      v.literal('weekdays'),
      v.literal('monthly'),
      v.literal('custom'),
    ),
    hour: v.number(), // 0..23, default 13
    enabled: v.boolean(), // default true
    lastRunAt: v.optional(v.string()),
    lastRunStatus: v.optional(v.union(v.literal('ok'), v.literal('error'))),
    nextRunAt: v.string(), // ISO-8601 (computed by the mutation, was a PG trigger)
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    dayOfMonth: v.optional(v.number()), // 1..28, set only for cadence='monthly'
    daysOfWeek: v.optional(v.array(v.string())), // mon..sun, set only for cadence='custom'
  })
    // GET/PATCH/DELETE/run resolve by (id, spaceId); id read backs it. The list +
    // the per-space count filter by spaceId (Routine_space_idx).
    .index('by_app_id', ['id'])
    .index('by_space', ['spaceId'])
    // The hourly cron finds due routines (enabled=true, nextRunAt <= now) across
    // ALL spaces, ordered by nextRunAt asc (Routine_due_idx, partial WHERE
    // enabled). We index nextRunAt and filter enabled in-handler.
    .index('by_next_run', ['nextRunAt']),

  // Was: "GoalDecomposition" (text id, spaceId [CASCADE], taskId nullable
  // [CASCADE], goalText, decomposedSteps jsonb default '[]', llmModel text
  // default 'gpt-4.1-mini', promptTokens/completionTokens int default 0,
  // createdAt). NO call sites today — carried so the schema stays complete and
  // the AgentTask cascade-delete can clear a task's decompositions.
  GoalDecomposition: defineTable({
    id: v.string(),
    spaceId: v.string(),
    taskId: v.optional(v.string()),
    goalText: v.string(),
    decomposedSteps: v.any(), // jsonb array (default [])
    llmModel: v.string(), // default 'gpt-4.1-mini'
    promptTokens: v.number(),
    completionTokens: v.number(),
    createdAt: v.string(), // ISO-8601
  })
    .index('by_app_id', ['id'])
    // GoalDecomposition_spaceId_taskId_idx — and the task cascade reads by taskId.
    .index('by_space_task', ['spaceId', 'taskId'])
    .index('by_task', ['taskId']),

  // Was: "TaskCheckpoint" (text id, taskId [CASCADE], spaceId, checkpointData
  // jsonb NOT NULL, stepIndex int default 0, createdAt). NO call sites today —
  // carried for schema completeness + the AgentTask cascade-delete.
  TaskCheckpoint: defineTable({
    id: v.string(),
    taskId: v.string(),
    spaceId: v.string(),
    checkpointData: v.any(), // jsonb (NOT NULL in PG)
    stepIndex: v.number(),
    createdAt: v.string(), // ISO-8601
  })
    .index('by_app_id', ['id'])
    // TaskCheckpoint_taskId_idx — and the task cascade reads by taskId.
    .index('by_task', ['taskId']),

  // Was: "TaskDependency" (text id, taskId [CASCADE], dependsOnTaskId [CASCADE],
  // dependencyType text default 'sequential' CHECK sequential|data|soft,
  // createdAt). CHECK(taskId <> dependsOnTaskId) + UNIQUE(taskId, dependsOnTaskId).
  // NO call sites today — carried for schema completeness + cascade-delete (a
  // deleted task drops dependencies on EITHER side).
  TaskDependency: defineTable({
    id: v.string(),
    taskId: v.string(),
    dependsOnTaskId: v.string(),
    dependencyType: v.union(v.literal('sequential'), v.literal('data'), v.literal('soft')),
    createdAt: v.string(), // ISO-8601
  })
    .index('by_app_id', ['id'])
    // UNIQUE(taskId, dependsOnTaskId) — read-before-insert backstop + the
    // cascade-delete read for a task's outgoing edges (TaskDependency_taskId_idx).
    .index('by_task', ['taskId', 'dependsOnTaskId'])
    // TaskDependency_dependsOnTaskId_idx — incoming edges (the cascade also
    // clears edges that POINT AT the deleted task).
    .index('by_depends_on', ['dependsOnTaskId']),
};
