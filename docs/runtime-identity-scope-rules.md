# Runtime Identity And Scope Rules

Status: Phase 2 baseline.

This document defines the OpenClaw-native runtime identity contract for
ClawLore. It is a metadata and boundary contract, not a place for
live chat ids, tokens, API keys, or private credential values.

## Runtime Field Audit

OpenClaw surfaces do not always provide the same context shape. Memory writes
must therefore extract only known scalar fields and must not persist raw runtime
objects.

Fields accepted when present:

- `agentId` / `agent_id`
- `sessionKey` / `session_key`
- `sessionId` / `session_id`
- `channelId` / `channel_id` / `channel`
- `accountId` / `account_id`
- `conversationId` / `conversation_id` / `chatId` / `chat_id` / `to`
- `threadId` / `thread_id` / `messageThreadId` / `message_thread_id` /
  `topicId` / `topic_id`
- `platform` / `provider` / `surface`
- `workspaceDir` / `workspace_dir` (routing input only; the absolute path is not persisted)

Field handling rules:

- Missing `agentId` does not fall back to `agent:main`; agent-scoped tools fail
  closed when they cannot resolve an agent from runtime context or session key.
- Raw message bodies, raw envelopes, tool outputs, secrets, and arbitrary
  runtime JSON are not copied into metadata.
- String fields are trimmed and length-limited before persistence.
- Scope filters are stored as bounded arrays when present; explicit
  `undefined` is recorded as bypass mode only for trusted system bypass calls.

## Canonical Metadata Fields

The runtime metadata helper writes these stable keys where source data exists:

- `runtime_contract`: currently `openclaw-scope-v1`
- `agentId`, `agent_id`, `scope_owner_agent_id`
- `sessionKey`, `session_key`, `source_session`
- `sessionId`, `session_id`
- `channel_id`, `account_id`, `conversation_id`, `thread_id`, `platform`
- `workspace_bound`: `true` when a workspace boundary was resolved; the absolute
  path remains runtime-local
- `scope_id`
- `scope_filter`
- `scope_filter_mode`: `restricted`, `deny_all`, or `bypass`

The duplicate camel/snake fields are intentional compatibility anchors for old
metadata readers and new contract checks.

## Scope Rules

- Normal agents default writes to `agent:<agentId>`.
- Reserved bypass ids such as `system` must provide an explicit write scope.
- Reads use `resolveScopeFilter(scopeManager, agentId)` unless a caller
  requests a specific accessible scope.
- Inaccessible explicit scopes return `scope_access_denied` before embedding,
  vector search, or SQL writes.
- Smart extraction and regex auto-capture receive the same target scope and
  scope-filter metadata used by the hook.
- Manual `memory_store` and `memory_store_secret_index` persist runtime
  identity metadata with the created row.
- Local scratch and working rows remain reviewable as governance debt; they are
  not promoted to durable cross-context knowledge without an explicit
  promotion/governance path.

## Capture And Admission Defaults

Public default capture remains conservative:

- `autoCapture` is off by default.
- `smartExtraction` is off by default.
- `admissionControl.enabled` is off by default but its rejected-audit entries can
  now include redacted runtime metadata when enabled.
- Capture safety rejects or sanitizes trivial ACKs, injected memory blocks,
  OpenClaw wrappers, compaction summaries, raw tool dumps, private credential
  paths, secret-shaped text, attachment-only payloads, and ephemeral assistant
  progress updates.

## Test Gates

Current Phase 2 test coverage:

- Missing agent runtime context fails closed.
- Secret-index tool is hidden unless explicitly enabled.
- `memory_store` stores deterministic runtime metadata.
- `memory_store` denies foreign agent scopes before embedding or storage.
- Smart extraction persists runtime metadata on auto-captured rows.
- Capture safety blocks tool dumps, credential paths, secrets, wrappers, ACKs,
  attachment-only payloads, and ephemeral progress noise.

Remaining Phase 2 live probes:

- Telegram direct, group, thread, CLI, and subagent runtime contexts should each
  get a safe write/recall smoke before this contract is marked `ready`.
- Local scratch promotion should be exercised through governance tools before
  claiming full scratch-isolation maturity.
