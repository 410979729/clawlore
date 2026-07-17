/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { enrichContentWithArtifactAnchors, mergeArtifactMetadata } from "./artifacts.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import {
  recordConflictReviewRelations
} from "./conflict-governance.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { isNoise } from "./noise-filter.js";
import {
  runtimeBoundaryMetadata
} from "./runtime-memory-boundary.js";
import { buildRuntimeScopeMetadata } from "./runtime-scope-metadata.js";
import { isSystemBypassId } from "./scopes.js";
import { buildSecretIndex } from "./secret-index.js";
import {
  buildSmartMetadata,
  stringifySmartMetadata
} from "./smart-metadata.js";
import type { MemoryStore } from "./store.js";
import {
  isUserMdExclusiveMemory
} from "./workspace-boundary.js";

import {
  clamp01,
  deriveManualMemoryLayer,
  MEMORY_CATEGORIES,
  requireRuntimeAgentId,
  requireRuntimeMemoryAccess,
  resolveToolContext,
  resolveWorkspaceDir,
  safeToolFailure,
  stringEnum,
  type ToolContext
} from "./tool-runtime-policy.js";

export function registerMemoryStoreTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(
            Type.Number({ description: "Importance score 0-1 (default: 0.7)" }),
          ),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
          scope: Type.Optional(
            Type.String({
              description: "Memory scope (optional, defaults to agent scope)",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, runtimeCtx: unknown) {
          const {
            text,
            importance = 0.7,
            category = "other",
            scope,
          } = params as {
            text: string;
            importance?: number;
            category?: string;
            scope?: string;
          };

          try {
            const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_store");
            if (agentResolution.ok === false) return agentResolution.response;
            const agentId = agentResolution.agentId;
            const accessResolution = requireRuntimeMemoryAccess(
              runtimeContext, agentId, toolCtx, runtimeCtx, "memory_store",
            );
            if (accessResolution.ok === false) return accessResolution.response;
            const access = accessResolution.access;
            // Determine target scope
            let targetScope = scope;
            if (!targetScope) {
              if (isSystemBypassId(agentId)) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Reserved bypass agent IDs must provide an explicit scope for memory_store writes.",
                    },
                  ],
                  details: {
                    error: "explicit_scope_required",
                    agentId,
                  },
                };
              }
              targetScope = access.defaultScope;
            }

            // Validate scope access
            if (!targetScope || !access.isAccessible(targetScope)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Access denied to scope: ${targetScope}`,
                  },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: targetScope,
                },
              };
            }

            const enrichedText = enrichContentWithArtifactAnchors(text);
            const captureSafety = evaluateCaptureSafety(enrichedText);
            if (!captureSafety.allowed) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Skipped: text blocked by capture safety filter (${captureSafety.reason})`,
                  },
                ],
                details: {
                  action: "capture_safety_filtered",
                  reason: captureSafety.reason,
                  pattern: captureSafety.pattern,
                },
              };
            }

            // Sanitize attachment markers before storage
            const sanitizedText = sanitizeCaptureText(enrichedText) || enrichedText;

            // Reject noise before wasting an embedding API call
            if (isNoise(sanitizedText)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Skipped: text detected as noise (greeting, boilerplate, or meta-question)`,
                  },
                ],
                details: { action: "noise_filtered", text: sanitizedText.slice(0, 60) },
              };
            }

            if (
              isUserMdExclusiveMemory(
                { text: sanitizedText },
                runtimeContext.workspaceBoundary,
              )
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Skipped: this fact belongs in USER.md, not plugin memory.",
                  },
                ],
                details: {
                  action: "skipped_by_workspace_boundary",
                  boundary: "user_md_exclusive",
                },
              };
            }

            const safeImportance = clamp01(importance, 0.7);
            const vector = await runtimeContext.embedder.embedPassage(sanitizedText);
            const runtimeScopeMetadata = buildRuntimeScopeMetadata({
              agentId,
              staticContext: toolCtx,
              runtimeContext: runtimeCtx,
              scope: targetScope,
              scopeFilter: [targetScope],
              workspaceDir: resolveWorkspaceDir(runtimeCtx, runtimeContext.workspaceDir),
            });
            Object.assign(runtimeScopeMetadata, runtimeBoundaryMetadata(access.boundary));

            // Check for duplicates using raw vector similarity (bypasses importance/recency weighting)
            // Fail-open by design: dedup must never block a legitimate memory write.
            // excludeInactive: superseded historical records must not block new writes.
            let existing: Awaited<ReturnType<MemoryStore["vectorSearch"]>> = [];
            try {
              existing = await runtimeContext.store.vectorSearch(vector, 1, 0.1, [
                targetScope,
              ], { excludeInactive: true });
            } catch (err) {
              console.warn(
                `clawlore: duplicate pre-check failed, continue store: ${diagnosticErrorSummary(err)}`,
              );
            }

            if (existing.length > 0 && existing[0].score > 0.98) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing[0].entry.text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing[0].entry.id,
                  existingText: existing[0].entry.text,
                  existingScope: existing[0].entry.scope,
                  similarity: existing[0].score,
                },
              };
            }

            const entry = await runtimeContext.store.store({
              text: sanitizedText,
              vector,
              importance: safeImportance,
              category: category as any,
              scope: targetScope,
              metadata: stringifySmartMetadata(
                mergeArtifactMetadata(
                  buildSmartMetadata(
                    {
                      text: sanitizedText,
                      category: category as any,
                      importance: safeImportance,
                    },
                    {
                      ...runtimeScopeMetadata,
                      l0_abstract: sanitizedText,
                      l1_overview: `- ${sanitizedText}`,
                      l2_content: sanitizedText,
                      source: "manual",
                      state: "confirmed",
                      memory_layer: deriveManualMemoryLayer(category as string),
                      last_confirmed_use_at: Date.now(),
                      bad_recall_count: 0,
                      suppressed_until_turn: 0,
                    },
                  ),
                  sanitizedText,
                ),
              ),
            });
            let conflictReview: Awaited<ReturnType<typeof recordConflictReviewRelations>> | undefined;
            try {
              conflictReview = await recordConflictReviewRelations(
                runtimeContext.store,
                entry,
                [targetScope],
              );
            } catch (err) {
              console.warn(`clawlore: conflict-review marking fails: ${diagnosticErrorSummary(err)}`);
            }

            // Dual-write to Markdown mirror if enabled
            if (context.mdMirror) {
              await context.mdMirror(
                { text: sanitizedText, category: category as string, scope: targetScope, timestamp: entry.timestamp },
                { source: "memory_store", agentId },
              );
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Stored: "${sanitizedText.slice(0, 100)}${sanitizedText.length > 100 ? "..." : ""}" in scope '${targetScope}'`,
                },
              ],
              details: {
                action: "created",
                id: entry.id,
                scope: entry.scope,
                category: entry.category,
                importance: entry.importance,
                conflictReview,
              },
            };
          } catch (error) {
            return safeToolFailure("store_failed", "Memory storage failed", error);
          }
        },
      };
    },
    { name: "memory_store" },
  );
}

export function registerMemoryStoreSecretIndexTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_store_secret_index",
        label: "Memory Store Secret Index",
        description:
          "Store searchable credential index metadata and vault references without storing plaintext secret values.",
        parameters: Type.Object({
          label: Type.Optional(Type.String({ description: "Human-readable credential label" })),
          service: Type.Optional(Type.String({ description: "Service or product name" })),
          account: Type.Optional(Type.String({ description: "Account, tenant, or project name" })),
          username: Type.Optional(Type.String({ description: "Username or login identifier" })),
          hostname: Type.Optional(Type.String({ description: "Host or server name" })),
          vaultRef: Type.Optional(Type.String({ description: "External vault/keyring reference or locator" })),
          secretType: Type.Optional(Type.String({ description: "password, token, api_key, private_key, cookie, credential, or other" })),
          rotationDue: Type.Optional(Type.String({ description: "Optional rotation due date" })),
          notes: Type.Optional(Type.String({ description: "Non-secret notes" })),
          entities: Type.Optional(Type.Array(Type.String())),
          tags: Type.Optional(Type.Array(Type.String())),
          secretFingerprintSha256: Type.Optional(Type.String({
            description: "Optional SHA-256 fingerprint generated locally by a trusted vault/client helper; plaintext is forbidden",
            pattern: "^[A-Fa-f0-9]{64}$",
          })),
          scope: Type.Optional(Type.String({ description: "Memory scope (optional, defaults to agent scope)" })),
        }),
        async execute(_toolCallId: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, runtimeCtx: unknown) {
          try {
            const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_store_secret_index");
            if (agentResolution.ok === false) return agentResolution.response;
            const agentId = agentResolution.agentId;
            const accessResolution = requireRuntimeMemoryAccess(
              runtimeContext, agentId, toolCtx, runtimeCtx, "memory_store_secret_index",
            );
            if (accessResolution.ok === false) return accessResolution.response;
            const access = accessResolution.access;
            const raw = params as Record<string, unknown>;
            let targetScope = typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : undefined;
            if (!targetScope) {
              if (isSystemBypassId(agentId)) {
                return {
                  content: [{ type: "text", text: "Reserved bypass agent IDs must provide an explicit scope for secret index writes." }],
                  details: { error: "explicit_scope_required", agentId },
                };
              }
              targetScope = access.defaultScope;
            }
            if (!targetScope || !access.isAccessible(targetScope)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${targetScope}` }],
                details: { error: "scope_access_denied", requestedScope: targetScope },
              };
            }

            const { content: text, metadata: secretMetadata } = buildSecretIndex(raw);
            const vector = await runtimeContext.embedder.embedPassage(text);
            const importance = clamp01(secretMetadata.importance as number, 0.82);
            const runtimeScopeMetadata = buildRuntimeScopeMetadata({
              agentId,
              staticContext: toolCtx,
              runtimeContext: runtimeCtx,
              scope: targetScope,
              scopeFilter: [targetScope],
              workspaceDir: resolveWorkspaceDir(runtimeCtx, runtimeContext.workspaceDir),
            });
            Object.assign(runtimeScopeMetadata, runtimeBoundaryMetadata(access.boundary));
            const entry = await runtimeContext.store.store({
              text,
              vector,
              importance,
              category: "fact",
              scope: targetScope,
              metadata: stringifySmartMetadata(
                buildSmartMetadata(
                  { text, category: "fact", importance },
                  {
                    ...secretMetadata,
                    ...runtimeScopeMetadata,
                    l0_abstract: text.split("\n").slice(0, 4).join("; "),
                    l1_overview: text,
                    l2_content: text,
                    source: "manual",
                    state: "confirmed",
                    memory_layer: "durable",
                    last_confirmed_use_at: Date.now(),
                    bad_recall_count: 0,
                    suppressed_until_turn: 0,
                  },
                ),
              ),
            });

            return {
              content: [{ type: "text", text: `Stored secret index ${entry.id.slice(0, 8)} in scope '${targetScope}' without plaintext secret value.` }],
              details: {
                action: "stored_secret_index",
                id: entry.id,
                scope: targetScope,
                plaintextStored: false,
              },
            };
          } catch (error) {
            return safeToolFailure("secret_index_store_failed", "Secret index store failed", error);
          }
        },
      };
    },
    { name: "memory_store_secret_index" },
  );
}
