# ClawLore Configuration Reference

Status: Phase 1 contract baseline.

Configuration lives under:

```text
plugins.entries.clawlore.config
```

OpenClaw's manifest declares `scope-recall-openclaw` as a legacy plugin id so
existing installations can be migrated without losing their configuration.
New configuration and all release evidence must use the canonical root above.

Do not copy live API keys or local credentials into this document. Defaults are
public manifest defaults or conservative operational guidance.

Risk levels:

- `low`: read-only behavior, diagnostics, or local-only tuning.
- `medium`: changes quality, cost, or recall/capture behavior.
- `high`: can send text to external services, persist durable memory, expose
  management tools, delete/archive data, or alter prompt injection.

Restart semantics: OpenClaw plugin config is read at plugin startup and by CLI
process startup. Unless a field is explicitly documented as live-reloadable,
treat changes as requiring Gateway restart or plugin reload before runtime hooks
use the new value. Standalone CLI commands read current config on each run.

## Core Storage

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `dbPath` | OpenClaw state memory path | high | yes | Canonical SQLite truth and vector companion directory. Back up before moving. |
| `vectorBackend` | `lancedb` | medium | yes | `lancedb` for semantic retrieval; `sqlite-bruteforce` for native-free fallback. |
| `agentToolProfile` | `memory-write` | high | yes | Single Agent-tool authority: `read-only`, `memory-write`, `self-improvement`, `operator`, or `operator-secret-index`. Deprecated boolean gates are rejected; use `read-only` for containment and reserve the secret-index profile for explicit operator need. |

## Embedding

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `embedding.provider` | unset | high | yes | Hosted providers receive memory text. Use `local-hash` only for degraded bootstrap/tests. |
| `embedding.apiKey` | unset | high | yes | Secret. Must stay in config/vault, never docs or logs. |
| `embedding.model` | provider default | medium | yes | Must match configured vector dimension. |
| `embedding.baseURL` | provider default | high | yes | External routing endpoint. |
| `embedding.groupId` | unset | high | yes | Provider-specific account id such as MiniMax GroupId. |
| `embedding.dimensions` | provider default | medium | yes | Dimension mismatch creates vector repair debt. |
| `embedding.omitDimensions` | unset | medium | yes | Provider compatibility knob. |
| `embedding.taskQuery` | unset | medium | yes | Provider-specific query task hint. |
| `embedding.taskPassage` | unset | medium | yes | Provider-specific passage task hint. |
| `embedding.normalized` | unset | medium | yes | Only supported by some providers. |
| `embedding.chunking` | `true` | medium | yes | Splits long text before embedding. |
| `embedding.apiVersion` | unset | medium | yes | Azure OpenAI compatibility. |
| `outboundEndpointPolicy.allowedPrivateHosts` | `[]` | high | yes | Exact private/loopback provider hosts intentionally trusted by the operator. Wildcards are rejected; add `127.0.0.1` or `localhost` explicitly for local Ollama. |

All embedding, reranking, and LLM requests are checked at dispatch time. The
default permits HTTPS endpoints only when DNS resolves exclusively to public
addresses. DNS validation occurs in the socket lookup, so the connection uses
the same validated address rather than resolving a second time. URL
credentials, non-HTTP schemes, private/link-local destinations, mixed
public/private DNS answers, and HTTP redirects are rejected. Private or
loopback endpoints require an exact `allowedPrivateHosts` entry.

## Recall Injection

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `autoRecall` | `false` | high | yes | Injects stored memories into prompts. Public installs should opt in deliberately. |
| `autoRecallMinLength` | `15` | medium | yes | Short prompts skip recall. |
| `autoRecallMinRepeated` | `8` | medium | yes | Suppresses repeated injection of the same memory in a session. |
| `autoRecallTimeoutMs` | `5000` | medium | yes | Auto-recall fails open after timeout. |
| `autoRecallMaxItems` | `3` | medium | yes | Item budget. |
| `autoRecallMaxChars` | `600` | medium | yes | Total injected char budget. |
| `autoRecallPerItemMaxChars` | `180` | medium | yes | Per-memory summary budget. |
| `autoRecallAllowCrossScope` | `false` | high | yes | Opt in to injecting memories across project/channel/customer/task boundaries. Same-scope and global recalls remain allowed. |
| `maxRecallPerTurn` | `10` | medium | yes | Hard safety ceiling. |
| `recallMode` | `full` | medium | yes | `full`, `summary`, `adaptive`, or `off` depending on runtime support. |

## Capture And Extraction

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `autoCapture` | `false` | high | yes | Persists durable memory from conversations. Must stay conservative by default. |
| `captureAssistant` | unset | high | yes | Assistant capture can store generated text; use carefully. |
| `smartExtraction` | `false` | high | yes | Sends conversation text to an LLM for extraction when enabled. |
| `extractMinMessages` | `4` | medium | yes | Minimum transcript size for extraction. |
| `extractMaxChars` | `8000` | high | yes | Upper bound sent to extraction model. |
| `sessionCompression.enabled` | `false` | medium | yes | Scores/compresses text before capture. |
| `sessionCompression.minScoreToKeep` | `0.3` | medium | yes | Lower values retain more text. |
| `extractionThrottle.skipLowValue` | `false` | medium | yes | Skips estimated low-value extraction. |
| `extractionThrottle.maxExtractionsPerHour` | `30` | medium | yes | Cost and rate-limit guard. |

## Admission Control

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `admissionControl.enabled` | `false` | high | yes | Gates smart-extraction writes. |
| `admissionControl.preset` | `balanced` | medium | yes | Named tuning preset. |
| `admissionControl.utilityMode` | `standalone` | medium | yes | Utility scoring mode. |
| `admissionControl.rejectThreshold` | `0.45` | medium | yes | Reject below this score. |
| `admissionControl.admitThreshold` | `0.6` | medium | yes | Admit above this score. |
| `admissionControl.noveltyCandidatePoolSize` | `8` | medium | yes | Dedup/novelty candidate count. |
| `admissionControl.auditMetadata` | `true` | low | yes | Stores audit metadata on decisions. |
| `admissionControl.persistRejectedAudits` | `false` | high | yes | Rejected audit logs may include conversation-derived content. |
| `admissionControl.rejectedAuditFilePath` | unset | high | yes | Local audit JSONL path. |

## Retrieval

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `retrieval.mode` | `hybrid` | medium | yes | Hybrid vector plus BM25 by default. |
| `retrieval.vectorWeight` | `0.7` | medium | yes | Vector score weight. |
| `retrieval.bm25Weight` | `0.3` | medium | yes | Lexical score weight. |
| `retrieval.minScore` | `0.3` | medium | yes | Pre-filter threshold. |
| `retrieval.rerank` | `cross-encoder` | high | yes | May send candidates to a reranker service. |
| `retrieval.rerankApiKey` | unset | high | yes | Secret. |
| `retrieval.rerankModel` | `jina-reranker-v3` | medium | yes | Provider model name. |
| `retrieval.rerankEndpoint` | `https://api.jina.ai/v1/rerank` | high | yes | External routing endpoint. |
| `retrieval.rerankProvider` | `jina` | high | yes | Request/response shape and auth style. |
| `retrieval.candidatePoolSize` | `20` | medium | yes | Candidate pool before final filtering. |
| `retrieval.recencyHalfLifeDays` | `14` | medium | yes | Recency boost half-life. |
| `retrieval.recencyWeight` | `0.1` | medium | yes | Max recency boost. |
| `retrieval.filterNoise` | `true` | low | yes | Filters known noisy memories. |
| `retrieval.lengthNormAnchor` | `500` | medium | yes | Penalizes long entries after anchor. |
| `retrieval.hardMinScore` | `0.35` | medium | yes | Final hard cutoff. |
| `retrieval.timeDecayHalfLifeDays` | `60` | medium | yes | Gradual old-memory decay. |
| `retrieval.reinforcementFactor` | `0.5` | medium | yes | Frequent access slows decay. |
| `retrieval.maxHalfLifeMultiplier` | `3` | medium | yes | Prevents immortal frequently accessed rows. |

## LLM Extraction

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `llm.auth` | `api-key` | high | yes | `oauth` may use local OAuth cache where supported. |
| `llm.apiKey` | unset | high | yes | Secret. |
| `llm.model` | `openai/gpt-oss-120b` | high | yes | Extraction/review model. |
| `llm.baseURL` | unset | high | yes | External routing endpoint. |
| `llm.oauthProvider` | unset | high | yes | OAuth provider id. |
| `llm.oauthPath` | default local OAuth path | high | yes | Local credential path, never publish. |
| `llm.timeoutMs` | `30000` | medium | yes | Extraction request timeout. |

## Experience And Reflection

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `taskExperienceCapture.enabled` | `false` | high | yes | Stores reusable task capsules after successful tool-backed work. |
| `taskExperienceCapture.minMessages` | `4` | medium | yes | Minimum transcript length. |
| `taskExperienceCapture.minToolCalls` | `1` | medium | yes | Requires tool evidence. |
| `taskExperienceCapture.maxInputChars` | `18000` | high | yes | Transcript chars sent to reviewer. |
| `taskExperienceCapture.maxCapsuleChars` | `2400` | medium | yes | Persisted capsule bound. |
| `taskExperienceCapture.minConfidence` | `0.68` | medium | yes | Reviewer confidence threshold. |
| `taskExperienceCapture.dedupeThreshold` | `0.92` | medium | yes | Duplicate capsule threshold. |
| `sessionStrategy` | `none` | high | yes | Selects reflection/session memory pipeline. |
| `sessionMemory.enabled` | `false` | high | yes | Legacy compatibility mapped to session strategy. |
| `memoryReflection.messageCount` | `120` | high | yes | Reflection input window. |
| `memoryReflection.maxInputChars` | `24000` | high | yes | Reflection input bound. |
| `memoryReflection.timeoutMs` | `20000` | medium | yes | Reflection timeout. |
| `memoryReflection.thinkLevel` | `medium` | medium | yes | Reflection model thinking hint. |

## Local Mirrors And Workspace Boundaries

| Key | Default | Risk | Restart | Notes |
| --- | --- | --- | --- | --- |
| `autoBackup` | `false` | high | no | Deprecated compatibility no-op. `true` creates no backup and makes doctor report an issue; use encrypted snapshot/export. |
| `mdMirror.enabled` | `false` | high | yes | Writes human-readable Markdown mirror. |
| `mdMirror.dir` | unset | high | yes | Local mirror directory. |
| `workspaceBoundary.userMdExclusive.enabled` | `false` | high | yes | Routes USER.md-exclusive facts away from plugin recall. |
| `workspaceBoundary.userMdExclusive.filterRecall` | `true` | high | yes | Filters those facts from recall results. |
| `selfImprovement.enabled` | `false` | high | yes | May write workspace learning files. |

## Decay, Tiering, And Compaction

The `decay.*`, `tier.*`, and `memoryCompaction.*` fields tune ranking,
retention, or summarization. Treat them as `medium` risk because they can
change recall answers or mutate stored summaries.

Commercial hardening should add config validation tests for unsafe
combinations, especially hosted reranking with sensitive deployments and
aggressive auto-capture plus smart extraction.
