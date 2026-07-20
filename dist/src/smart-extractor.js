/**
 * Smart Memory Extractor — LLM-powered extraction pipeline
 * Replaces regex-triggered capture with intelligent 6-category extraction.
 *
 * Pipeline: conversation → LLM extract → candidates → dedup → persist
 */
import { buildExtractionPrompt, buildDedupPrompt, buildMergePrompt, } from "./extraction-prompts.js";
import { AdmissionController, } from "./admission-control.js";
import { ALWAYS_MERGE_CATEGORIES, MERGE_SUPPORTED_CATEGORIES, TEMPORAL_VERSIONED_CATEGORIES, normalizeCategory, } from "./memory-categories.js";
import { isNoise } from "./noise-filter.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { filterUnsafeMemoryResults, isMemoryEntrySafeForEgress, } from "./memory-egress-policy.js";
import { evaluateMemoryMergePayload } from "./memory-merge-policy.js";
import { normalizeProviderAnnotation } from "./provider-output-policy.js";
import { filterEmbeddingNoiseInputs } from "./embedding-noise-filter.js";
import { appendRelation, buildSmartMetadata, deriveFactKey, parseSmartMetadata, stringifySmartMetadata, parseSupportInfo, updateSupportStats, } from "./smart-metadata.js";
import { isUserMdExclusiveMemory, } from "./workspace-boundary.js";
import { inferAtomicBrandItemPreferenceSlot } from "./preference-slots.js";
import { batchDedup } from "./batch-dedup.js";
import { recordConflictReviewRelations } from "./conflict-governance.js";
import { diagnosticErrorSummary, diagnosticIdentifier, diagnosticTextSummary, } from "./diagnostic-redaction.js";
// ============================================================================
// Envelope Metadata Stripping
// ============================================================================
/**
 * Strip platform envelope metadata injected by OpenClaw channels before
 * the conversation text reaches the extraction LLM. These envelopes contain
 * message IDs, sender IDs, timestamps, and JSON metadata blocks that have
 * zero informational value for memory extraction but get stored verbatim
 * by weaker LLMs (e.g. qwen) that can't distinguish metadata from content.
 *
 * Targets:
 * - "System: [YYYY-MM-DD HH:MM:SS GMT+N] Channel[account] ..." header lines
 * - "Conversation info (untrusted metadata):" + JSON code blocks
 * - "Sender (untrusted metadata):" + JSON code blocks
 * - "Replied message (untrusted, for context):" + JSON code blocks
 * - Standalone JSON blocks containing message_id/sender_id fields
 */
export function stripEnvelopeMetadata(text) {
    // 1. Strip "System: [timestamp] Channel..." lines
    let cleaned = text.replace(/^System:\s*\[[\d\-: +GMT]+\]\s+\S+\[.*?\].*$/gm, "");
    // 2. Strip labeled metadata sections with their JSON code blocks
    //    e.g. "Conversation info (untrusted metadata):\n```json\n{...}\n```"
    cleaned = cleaned.replace(/(?:Conversation info|Sender|Replied message)\s*\(untrusted[^)]*\):\s*```json\s*\{[\s\S]*?\}\s*```/g, "");
    // 3. Strip any remaining JSON blocks that look like envelope metadata
    //    (contain message_id and sender_id fields)
    cleaned = cleaned.replace(/```json\s*\{[^}]*"message_id"\s*:[^}]*"sender_id"\s*:[^}]*\}\s*```/g, "");
    // 4. Collapse excessive blank lines left by removals
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    return cleaned.trim();
}
// ============================================================================
// Constants
// ============================================================================
const SIMILARITY_THRESHOLD = 0.7;
const MAX_SIMILAR_FOR_PROMPT = 3;
const MAX_MEMORIES_PER_EXTRACTION = 5;
const VALID_DECISIONS = new Set([
    "create",
    "merge",
    "skip",
    "support",
    "contextualize",
    "contradict",
    "supersede",
]);
export class SmartExtractor {
    store;
    embedder;
    llm;
    config;
    log;
    debugLog;
    admissionController;
    persistAdmissionAudit;
    onAdmissionRejected;
    constructor(store, embedder, llm, config = {}) {
        this.store = store;
        this.embedder = embedder;
        this.llm = llm;
        this.config = config;
        this.log = config.log ?? ((msg) => console.log(msg));
        this.debugLog = config.debugLog ?? (() => { });
        this.persistAdmissionAudit =
            config.admissionControl?.enabled === true &&
                config.admissionControl.auditMetadata !== false;
        this.onAdmissionRejected = config.onAdmissionRejected;
        this.admissionController =
            config.admissionControl?.enabled === true
                ? new AdmissionController(this.store, this.llm, config.admissionControl, this.debugLog)
                : null;
    }
    // --------------------------------------------------------------------------
    // Main entry point
    // --------------------------------------------------------------------------
    /**
     * Extract memories from a conversation text and persist them.
     * Returns extraction statistics.
     */
    async extractAndPersist(conversationText, sessionKey = "unknown", options = {}) {
        const stats = { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 };
        const sanitizedConversation = sanitizeCaptureText(conversationText);
        const conversationSafety = evaluateCaptureSafety(sanitizedConversation);
        if (!conversationSafety.allowed) {
            stats.skipped += 1;
            this.debugLog(`clawlore: smart-extractor: skipped unsafe conversation text reason=${conversationSafety.reason} pattern=${conversationSafety.pattern ?? "unknown"}`);
            return stats;
        }
        const targetScope = options.scope ?? this.config.defaultScope ?? "global";
        // Distinguish "no override supplied" from explicit bypass/override values.
        // - omitted `scopeFilter` => default to `[targetScope]`
        // - explicit `undefined` => preserve full-bypass semantics for trusted callers
        // - explicit `[]` or non-empty array => pass through unchanged
        const hasExplicitScopeFilter = "scopeFilter" in options;
        const scopeFilter = hasExplicitScopeFilter
            ? options.scopeFilter
            : [targetScope];
        const runtimeMetadata = options.runtimeMetadata ?? {};
        // Step 1: LLM extraction
        const candidates = await this.extractCandidates(sanitizedConversation);
        if (candidates.length === 0) {
            this.log("clawlore: smart-extractor: no memories extracted");
            // LLM returned zero candidates → strongest noise signal → feedback to noise bank
            this.learnAsNoise(sanitizedConversation);
            return stats;
        }
        this.log(`clawlore: smart-extractor: extracted ${candidates.length} candidate(s)`);
        // Step 1b: Batch-internal dedup — embed candidate abstracts and remove near-duplicates
        //          before expensive per-candidate LLM dedup calls (see src/batch-dedup.ts)
        const capped = candidates.slice(0, MAX_MEMORIES_PER_EXTRACTION);
        let survivingCandidates = capped;
        try {
            const abstracts = capped.map((c) => c.abstract);
            const vectors = await Promise.all(abstracts.map((a) => this.embedder.embed(a).catch(() => [])));
            const dedupResult = batchDedup(abstracts, vectors);
            if (dedupResult.duplicateIndices.length > 0) {
                survivingCandidates = dedupResult.survivingIndices.map((i) => capped[i]);
                stats.skipped += dedupResult.duplicateIndices.length;
                this.log(`clawlore: smart-extractor: batchDedup dropped ${dedupResult.duplicateIndices.length} near-duplicate(s), ${survivingCandidates.length} survivor(s)`);
            }
        }
        catch (err) {
            this.log(`clawlore: smart-extractor: batchDedup failed, proceeding without batch dedup: ${diagnosticErrorSummary(err)}`);
        }
        // Step 2: Process each surviving candidate through dedup pipeline
        for (const candidate of survivingCandidates) {
            if (isUserMdExclusiveMemory({
                memoryCategory: candidate.category,
                abstract: candidate.abstract,
                content: candidate.content,
            }, this.config.workspaceBoundary)) {
                stats.skipped += 1;
                stats.boundarySkipped = (stats.boundarySkipped ?? 0) + 1;
                this.log(`clawlore: smart-extractor: skipped USER.md-exclusive [${candidate.category}] ` +
                    `abstract=${diagnosticTextSummary(candidate.abstract)}`);
                continue;
            }
            try {
                await this.processCandidate(candidate, sanitizedConversation, sessionKey, stats, targetScope, scopeFilter, runtimeMetadata);
            }
            catch (err) {
                this.log(`clawlore: smart-extractor: failed to process candidate [${candidate.category}]: ${diagnosticErrorSummary(err)}`);
            }
        }
        return stats;
    }
    // --------------------------------------------------------------------------
    // Embedding Noise Pre-Filter
    // --------------------------------------------------------------------------
    /**
     * Filter out texts that match noise prototypes by embedding similarity.
     * Long texts (>300 chars) are passed through without checking.
     * Only active when noiseBank is configured and initialized.
     */
    async filterNoiseByEmbedding(texts) {
        return filterEmbeddingNoiseInputs({
            texts,
            noiseBank: this.config.noiseBank,
            embed: (text) => this.embedder.embed(text),
            debugLog: this.debugLog,
        });
    }
    /**
     * Feed back conversation text to the noise prototype bank.
     * Called when LLM extraction returns zero candidates (strongest noise signal).
     */
    async learnAsNoise(conversationText) {
        const noiseBank = this.config.noiseBank;
        if (!noiseBank || !noiseBank.initialized)
            return;
        try {
            const tail = conversationText.slice(-300);
            const vec = await this.embedder.embed(tail);
            if (vec && vec.length > 0) {
                noiseBank.learn(vec);
                this.debugLog("clawlore: smart-extractor: learned noise from zero-extraction");
            }
        }
        catch {
            // Non-critical — silently skip
        }
    }
    // --------------------------------------------------------------------------
    // Step 1: LLM Extraction
    // --------------------------------------------------------------------------
    /**
     * Call LLM to extract candidate memories from conversation text.
     */
    async extractCandidates(conversationText) {
        const maxChars = this.config.extractMaxChars ?? 8000;
        const truncated = conversationText.length > maxChars
            ? conversationText.slice(-maxChars)
            : conversationText;
        // Strip platform envelope metadata injected by OpenClaw channels
        // (e.g. "System: [2026-03-18 14:21:36 GMT+8] Feishu[default] DM | ou_...")
        // These pollute extraction if treated as conversation content.
        const cleaned = stripEnvelopeMetadata(truncated);
        const user = this.config.user ?? "User";
        const prompt = buildExtractionPrompt(cleaned, user);
        const result = await this.llm.completeJson(prompt, "extract-candidates");
        if (!result) {
            throw new Error("extract-candidates returned null");
        }
        if (result.degraded === true) {
            throw new Error(`extract-candidates degraded: ${result.degradedReason || result.degraded_reason || "unknown"}`);
        }
        if (!result.memories || !Array.isArray(result.memories)) {
            throw new Error(`extract-candidates returned unexpected shape keys=${Object.keys(result).join(",") || "(none)"}`);
        }
        this.debugLog(`clawlore: smart-extractor: extract-candidates raw memories=${result.memories.length}`);
        // Validate and normalize candidates
        const candidates = [];
        let invalidCategoryCount = 0;
        let shortAbstractCount = 0;
        let noiseAbstractCount = 0;
        let unsafeCandidateCount = 0;
        for (const raw of result.memories) {
            const category = normalizeCategory(raw.category ?? "");
            if (!category) {
                invalidCategoryCount++;
                this.debugLog(`clawlore: smart-extractor: dropping candidate due to invalid category ` +
                    `category=${diagnosticTextSummary(raw.category)} abstract=${diagnosticTextSummary(raw.abstract)}`);
                continue;
            }
            const abstract = (raw.abstract ?? "").trim();
            const overview = (raw.overview ?? "").trim();
            const content = (raw.content ?? "").trim();
            const candidateSafety = evaluateCaptureSafety([abstract, overview, content].filter(Boolean).join("\n"));
            if (!candidateSafety.allowed) {
                unsafeCandidateCount++;
                this.debugLog(`clawlore: smart-extractor: dropping unsafe candidate reason=${candidateSafety.reason} pattern=${candidateSafety.pattern ?? "unknown"} category=${category}`);
                continue;
            }
            // Skip empty or noise
            if (!abstract || abstract.length < 5) {
                shortAbstractCount++;
                this.debugLog(`clawlore: smart-extractor: dropping candidate due to short abstract ` +
                    `category=${category} abstract=${diagnosticTextSummary(abstract)}`);
                continue;
            }
            if (isNoise(abstract)) {
                noiseAbstractCount++;
                this.debugLog(`clawlore: smart-extractor: dropping candidate due to noise abstract ` +
                    `category=${category} abstract=${diagnosticTextSummary(abstract)}`);
                continue;
            }
            // Sanitize attachment markers before persisting
            const sanitizedAbstract = sanitizeCaptureText(abstract) || abstract;
            const sanitizedOverview = sanitizeCaptureText(overview) || overview;
            const sanitizedContent = sanitizeCaptureText(content) || content;
            candidates.push({ category, abstract: sanitizedAbstract, overview: sanitizedOverview, content: sanitizedContent });
        }
        this.debugLog(`clawlore: smart-extractor: validation summary accepted=${candidates.length}, invalidCategory=${invalidCategoryCount}, shortAbstract=${shortAbstractCount}, noiseAbstract=${noiseAbstractCount}, unsafe=${unsafeCandidateCount}`);
        return candidates;
    }
    // --------------------------------------------------------------------------
    // Step 2: Dedup + Persist
    // --------------------------------------------------------------------------
    /**
     * Process a single candidate memory: dedup → merge/create → store
     */
    async processCandidate(candidate, conversationText, sessionKey, stats, targetScope, scopeFilter, runtimeMetadata = {}) {
        // Profile always merges (skip dedup — admission control still applies)
        if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) {
            const profileResult = await this.handleProfileMerge(candidate, conversationText, sessionKey, targetScope, scopeFilter, undefined, runtimeMetadata);
            if (profileResult === "rejected") {
                stats.rejected = (stats.rejected ?? 0) + 1;
            }
            else if (profileResult === "created") {
                stats.created++;
            }
            else {
                stats.merged++;
            }
            return;
        }
        // Embed the candidate for vector dedup
        const embeddingText = `${candidate.abstract} ${candidate.content}`;
        const vector = await this.embedder.embed(embeddingText);
        if (!vector || vector.length === 0) {
            this.log("clawlore: smart-extractor: embedding failed, storing as-is");
            await this.storeCandidate(candidate, vector || [], sessionKey, targetScope, undefined, runtimeMetadata);
            stats.created++;
            return;
        }
        // Admission control gate (before dedup)
        const admission = this.admissionController
            ? await this.admissionController.evaluate({
                candidate,
                candidateVector: vector,
                conversationText,
                scopeFilter: scopeFilter ?? [targetScope],
            })
            : undefined;
        if (admission?.decision === "reject") {
            stats.rejected = (stats.rejected ?? 0) + 1;
            this.log(`clawlore: smart-extractor: admission rejected [${candidate.category}] ` +
                `abstract=${diagnosticTextSummary(candidate.abstract)} reason=${diagnosticTextSummary(admission.audit.reason)}`);
            await this.recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter ?? [targetScope], admission.audit, runtimeMetadata);
            return;
        }
        // Dedup pipeline
        const dedupResult = await this.deduplicate(candidate, vector, scopeFilter);
        switch (dedupResult.decision) {
            case "create":
                await this.storeCandidate(candidate, vector, sessionKey, targetScope, admission?.audit, runtimeMetadata);
                stats.created++;
                break;
            case "merge":
                if (dedupResult.matchId &&
                    MERGE_SUPPORTED_CATEGORIES.has(candidate.category)) {
                    const mergeResult = await this.handleMerge(candidate, dedupResult.matchId, vector, targetScope, scopeFilter, dedupResult.contextLabel, admission?.audit, runtimeMetadata);
                    stats[mergeResult]++;
                }
                else {
                    // Category doesn't support merge → create instead
                    await this.storeCandidate(candidate, vector, sessionKey, targetScope, admission?.audit, runtimeMetadata);
                    stats.created++;
                }
                break;
            case "skip":
                this.log(`clawlore: smart-extractor: skipped [${candidate.category}] ` +
                    `abstract=${diagnosticTextSummary(candidate.abstract)}`);
                stats.skipped++;
                break;
            case "supersede":
                if (dedupResult.matchId &&
                    TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category)) {
                    await this.handleSupersede(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, admission?.audit, runtimeMetadata);
                    stats.created++;
                    stats.superseded = (stats.superseded ?? 0) + 1;
                }
                else {
                    await this.storeCandidate(candidate, vector, sessionKey, targetScope, admission?.audit, runtimeMetadata);
                    stats.created++;
                }
                break;
            case "support":
                if (dedupResult.matchId) {
                    await this.handleSupport(dedupResult.matchId, { session: sessionKey, timestamp: Date.now() }, dedupResult.reason, dedupResult.contextLabel, scopeFilter, admission?.audit, runtimeMetadata);
                    stats.supported = (stats.supported ?? 0) + 1;
                }
                else {
                    await this.storeCandidate(candidate, vector, sessionKey, targetScope, admission?.audit, runtimeMetadata);
                    stats.created++;
                }
                break;
            case "contextualize":
                if (dedupResult.matchId) {
                    await this.handleContextualize(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel, admission?.audit, runtimeMetadata);
                    stats.created++;
                }
                else {
                    await this.storeCandidate(candidate, vector, sessionKey, targetScope, admission?.audit, runtimeMetadata);
                    stats.created++;
                }
                break;
            case "contradict":
                if (dedupResult.matchId) {
                    await this.handleContradict(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel, admission?.audit, runtimeMetadata);
                    stats.created++;
                    stats.contradicted = (stats.contradicted ?? 0) + 1;
                }
                else {
                    await this.storeCandidate(candidate, vector, sessionKey, targetScope, admission?.audit, runtimeMetadata);
                    stats.created++;
                }
                break;
        }
    }
    // --------------------------------------------------------------------------
    // Dedup Pipeline (vector pre-filter + LLM decision)
    // --------------------------------------------------------------------------
    /**
     * Two-stage dedup: vector similarity search → LLM decision.
     */
    async deduplicate(candidate, candidateVector, scopeFilter) {
        // Stage 1: Vector pre-filter — find similar active memories.
        // excludeInactive ensures the store over-fetches to fill N active slots,
        // preventing superseded history from crowding out the current fact.
        const activeSimilar = filterUnsafeMemoryResults(await this.store.vectorSearch(candidateVector, 5, SIMILARITY_THRESHOLD, scopeFilter, { excludeInactive: true }));
        if (activeSimilar.length === 0) {
            return { decision: "create", reason: "No similar memories found" };
        }
        // Stage 1.5: Preference slot guard — same brand but different item
        // should always be stored as a new memory, not merged/skipped.
        // Example: "喜欢麦当劳的板烧鸡腿堡" and "喜欢麦当劳的麦辣鸡翅" are
        // different preferences even though they share the same brand.
        if (candidate.category === "preferences") {
            const candidateSlot = inferAtomicBrandItemPreferenceSlot(candidate.content);
            if (candidateSlot) {
                const allDifferentItem = activeSimilar.every((r) => {
                    const existingSlot = inferAtomicBrandItemPreferenceSlot(r.entry.text);
                    // If existing is not a brand-item preference, let LLM decide
                    if (!existingSlot)
                        return false;
                    // Same brand, different item → should not be deduped
                    return existingSlot.brand === candidateSlot.brand && existingSlot.item !== candidateSlot.item;
                });
                if (allDifferentItem) {
                    return { decision: "create", reason: "Same brand but different item-level preference (preference-slot guard)" };
                }
            }
        }
        // Stage 2: LLM decision
        return this.llmDedupDecision(candidate, activeSimilar);
    }
    async llmDedupDecision(candidate, similar) {
        const topSimilar = similar.slice(0, MAX_SIMILAR_FOR_PROMPT);
        const existingFormatted = topSimilar
            .map((r, i) => {
            // Extract L0 abstract from metadata if available, fallback to text
            let metaObj = {};
            try {
                metaObj = JSON.parse(r.entry.metadata || "{}");
            }
            catch { }
            const abstract = metaObj.l0_abstract || r.entry.text;
            const overview = metaObj.l1_overview || "";
            return `${i + 1}. [${metaObj.memory_category || r.entry.category}] ${abstract}\n   Overview: ${overview}\n   Score: ${r.score.toFixed(3)}`;
        })
            .join("\n");
        const prompt = buildDedupPrompt(candidate.abstract, candidate.overview, candidate.content, existingFormatted);
        try {
            const data = await this.llm.completeJson(prompt, "dedup-decision");
            if (!data) {
                this.log("clawlore: smart-extractor: dedup LLM returned unparseable response, defaulting to CREATE");
                return { decision: "create", reason: "LLM response unparseable" };
            }
            const decision = (typeof data.decision === "string"
                ? data.decision.toLowerCase()
                : "create");
            if (!VALID_DECISIONS.has(decision)) {
                return {
                    decision: "create",
                    reason: "Unknown decision from provider",
                };
            }
            // Resolve merge target from LLM's match_index (1-based)
            const idx = data.match_index;
            const hasValidIndex = typeof idx === "number" && idx >= 1 && idx <= topSimilar.length;
            const matchEntry = hasValidIndex
                ? topSimilar[idx - 1]
                : topSimilar[0];
            // For destructive decisions (supersede), missing match_index is
            // unsafe — we could invalidate the wrong memory. Degrade to create.
            const destructiveDecisions = new Set(["supersede", "contradict"]);
            if (destructiveDecisions.has(decision) && !hasValidIndex) {
                this.log(`clawlore: smart-extractor: ${decision} decision has missing/invalid match_index (${idx}), degrading to create`);
                return {
                    decision: "create",
                    reason: `${decision} degraded: missing match_index`,
                };
            }
            return {
                decision,
                reason: normalizeProviderAnnotation(data.reason) ?? "Provider supplied no safe reason",
                matchId: ["merge", "support", "contextualize", "contradict", "supersede"].includes(decision) ? matchEntry?.entry.id : undefined,
                contextLabel: normalizeProviderAnnotation(data.context_label, 80),
            };
        }
        catch (err) {
            this.log(`clawlore: smart-extractor: dedup LLM failed: ${diagnosticErrorSummary(err)}`);
            return { decision: "create", reason: "LLM failed" };
        }
    }
    // --------------------------------------------------------------------------
    // Merge Logic
    // --------------------------------------------------------------------------
    /**
     * Profile always-merge: read existing profile, merge with LLM, upsert.
     */
    async handleProfileMerge(candidate, conversationText, sessionKey, targetScope, scopeFilter, admissionAudit, runtimeMetadata = {}) {
        // Find existing profile memory by category
        const embeddingText = `${candidate.abstract} ${candidate.content}`;
        const vector = await this.embedder.embed(embeddingText);
        // Run admission control for profile candidates (they skip the main dedup path)
        if (!admissionAudit && this.admissionController && vector && vector.length > 0) {
            const profileAdmission = await this.admissionController.evaluate({
                candidate,
                candidateVector: vector,
                conversationText,
                scopeFilter: scopeFilter ?? [targetScope],
            });
            if (profileAdmission.decision === "reject") {
                this.log(`clawlore: smart-extractor: admission rejected profile ` +
                    `abstract=${diagnosticTextSummary(candidate.abstract)} reason=${diagnosticTextSummary(profileAdmission.audit.reason)}`);
                await this.recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter ?? [targetScope], profileAdmission.audit, runtimeMetadata);
                return "rejected";
            }
            admissionAudit = profileAdmission.audit;
        }
        // Search for existing profile memories
        const existing = filterUnsafeMemoryResults(await this.store.vectorSearch(vector || [], 1, 0.3, scopeFilter));
        const profileMatch = existing.find((r) => {
            try {
                const meta = JSON.parse(r.entry.metadata || "{}");
                return meta.memory_category === "profile";
            }
            catch {
                return false;
            }
        });
        if (profileMatch) {
            return this.handleMerge(candidate, profileMatch.entry.id, vector || [], targetScope, scopeFilter, undefined, admissionAudit, runtimeMetadata);
        }
        else {
            // No existing profile — create new
            await this.storeCandidate(candidate, vector || [], sessionKey, targetScope, admissionAudit, runtimeMetadata);
            return "created";
        }
    }
    /**
     * Merge a candidate into an existing memory using LLM.
     */
    async handleMerge(candidate, matchId, candidateVector, targetScope, scopeFilter, contextLabel, admissionAudit, runtimeMetadata = {}) {
        const storeFallback = async (reason) => {
            this.log(`clawlore: smart-extractor: merge ${reason}, storing safe candidate as new`);
            await this.storeCandidate(candidate, candidateVector, "merge-fallback", targetScope, admissionAudit, runtimeMetadata);
            return "created";
        };
        let existing;
        try {
            existing = await this.store.getById(matchId, scopeFilter);
        }
        catch {
            return storeFallback("source read failed");
        }
        if (!existing || !isMemoryEntrySafeForEgress(existing)) {
            return storeFallback("source missing or unsafe");
        }
        const existingMeta = parseSmartMetadata(existing.metadata, existing);
        const prompt = buildMergePrompt(existingMeta.l0_abstract || existing.text, existingMeta.l1_overview || "", existingMeta.l2_content || existing.text, candidate.abstract, candidate.overview, candidate.content, candidate.category);
        let untrustedMerged;
        try {
            untrustedMerged = await this.llm.completeJson(prompt, "merge-memory");
        }
        catch {
            return storeFallback("provider failed");
        }
        const mergeDecision = evaluateMemoryMergePayload(untrustedMerged);
        if (!mergeDecision.allowed)
            return storeFallback(`output rejected (${mergeDecision.reason})`);
        const merged = mergeDecision.value;
        const mergedText = `${merged.abstract} ${merged.content}`;
        const newVector = await this.embedder.embed(mergedText);
        const metadata = stringifySmartMetadata(this.withAdmissionAudit(buildSmartMetadata(existing ?? { text: merged.abstract }, {
            ...runtimeMetadata,
            l0_abstract: merged.abstract,
            l1_overview: merged.overview,
            l2_content: merged.content,
            memory_category: candidate.category,
            tier: "working",
            confidence: 0.8,
        }), admissionAudit));
        await this.store.update(matchId, {
            text: merged.abstract,
            vector: newVector,
            metadata,
        }, scopeFilter);
        // Update support stats on the merged memory
        try {
            const updatedEntry = await this.store.getById(matchId, scopeFilter);
            if (updatedEntry) {
                const meta = parseSmartMetadata(updatedEntry.metadata, updatedEntry);
                const supportInfo = parseSupportInfo(meta.support_info);
                const updated = updateSupportStats(supportInfo, contextLabel, "support");
                const finalMetadata = stringifySmartMetadata({ ...meta, support_info: updated });
                await this.store.update(matchId, { metadata: finalMetadata }, scopeFilter);
            }
        }
        catch {
            // Non-critical: merge succeeded, support stats update is best-effort
        }
        this.log(`clawlore: smart-extractor: merged [${candidate.category}] ` +
            `context=${diagnosticTextSummary(contextLabel)} into=${diagnosticIdentifier(matchId)}`);
        return "merged";
    }
    /**
     * Handle SUPERSEDE: preserve the old record as historical but mark it as no
     * longer current, then create the new active fact.
     */
    async handleSupersede(candidate, vector, matchId, sessionKey, targetScope, scopeFilter, admissionAudit, runtimeMetadata = {}) {
        const existing = await this.store.getById(matchId, scopeFilter);
        if (!existing) {
            await this.storeCandidate(candidate, vector, sessionKey, targetScope, undefined, runtimeMetadata);
            return;
        }
        const now = Date.now();
        const existingMeta = parseSmartMetadata(existing.metadata, existing);
        const factKey = existingMeta.fact_key ?? deriveFactKey(candidate.category, candidate.abstract);
        const storeCategory = this.mapToStoreCategory(candidate.category);
        const created = await this.store.store({
            text: candidate.abstract,
            vector,
            category: storeCategory,
            scope: targetScope,
            importance: this.getDefaultImportance(candidate.category),
            metadata: stringifySmartMetadata(buildSmartMetadata({
                text: candidate.abstract,
                category: storeCategory,
            }, {
                ...runtimeMetadata,
                l0_abstract: candidate.abstract,
                l1_overview: candidate.overview,
                l2_content: candidate.content,
                memory_category: candidate.category,
                tier: "working",
                access_count: 0,
                confidence: 0.7,
                source_session: sessionKey,
                source: "auto-capture",
                state: "confirmed", // #350: write confirmed to unblock auto-recall
                memory_layer: "working",
                injected_count: 0,
                bad_recall_count: 0,
                suppressed_until_turn: 0,
                valid_from: now,
                fact_key: factKey,
                supersedes: matchId,
                relations: appendRelation([], {
                    type: "supersedes",
                    targetId: matchId,
                }),
            })),
        });
        const invalidatedMetadata = buildSmartMetadata(existing, {
            ...runtimeMetadata,
            fact_key: factKey,
            invalidated_at: now,
            superseded_by: created.id,
            relations: appendRelation(existingMeta.relations, {
                type: "superseded_by",
                targetId: created.id,
            }),
        });
        await this.store.update(matchId, { metadata: stringifySmartMetadata(invalidatedMetadata) }, scopeFilter);
        this.log(`clawlore: smart-extractor: superseded [${candidate.category}] ` +
            `${diagnosticIdentifier(matchId)} -> ${diagnosticIdentifier(created.id)}`);
    }
    // --------------------------------------------------------------------------
    // Context-Aware Handlers (support / contextualize / contradict)
    // --------------------------------------------------------------------------
    /**
     * Handle SUPPORT: update support stats on existing memory for a specific context.
     */
    async handleSupport(matchId, source, reason, contextLabel, scopeFilter, admissionAudit, runtimeMetadata = {}) {
        const existing = await this.store.getById(matchId, scopeFilter);
        if (!existing)
            return;
        const meta = parseSmartMetadata(existing.metadata, existing);
        const supportInfo = parseSupportInfo(meta.support_info);
        const updated = updateSupportStats(supportInfo, contextLabel, "support");
        meta.support_info = updated;
        await this.store.update(matchId, { metadata: stringifySmartMetadata(this.withAdmissionAudit({ ...meta, ...runtimeMetadata }, admissionAudit)) }, scopeFilter);
        this.log(`clawlore: smart-extractor: support context=${diagnosticTextSummary(contextLabel || "general")} ` +
            `on=${diagnosticIdentifier(matchId)} reason=${diagnosticTextSummary(reason)}`);
    }
    /**
     * Handle CONTEXTUALIZE: create a new entry that adds situational nuance,
     * linked to the original via a relation in metadata.
     */
    async handleContextualize(candidate, vector, matchId, sessionKey, targetScope, scopeFilter, contextLabel, admissionAudit, runtimeMetadata = {}) {
        const storeCategory = this.mapToStoreCategory(candidate.category);
        const metadata = stringifySmartMetadata(this.withAdmissionAudit({
            ...runtimeMetadata,
            l0_abstract: candidate.abstract,
            l1_overview: candidate.overview,
            l2_content: candidate.content,
            memory_category: candidate.category,
            tier: "working",
            access_count: 0,
            confidence: 0.7,
            last_accessed_at: Date.now(),
            source_session: sessionKey,
            source: "auto-capture",
            state: "confirmed", // #350: write confirmed to unblock auto-recall
            memory_layer: "working",
            injected_count: 0,
            bad_recall_count: 0,
            suppressed_until_turn: 0,
            contexts: contextLabel ? [contextLabel] : [],
            relations: [{ type: "contextualizes", targetId: matchId }],
        }, admissionAudit));
        await this.store.store({
            text: candidate.abstract,
            vector,
            category: storeCategory,
            scope: targetScope,
            importance: this.getDefaultImportance(candidate.category),
            metadata,
        });
        this.log(`clawlore: smart-extractor: contextualize context=${diagnosticTextSummary(contextLabel || "general")} ` +
            `linked=${diagnosticIdentifier(matchId)}`);
    }
    /**
     * Handle CONTRADICT: create contradicting entry + record contradiction evidence
     * on the original memory's support stats.
     */
    async handleContradict(candidate, vector, matchId, sessionKey, targetScope, scopeFilter, contextLabel, admissionAudit, runtimeMetadata = {}) {
        // 1. Record contradiction on the existing memory
        const existing = await this.store.getById(matchId, scopeFilter);
        if (existing) {
            const meta = parseSmartMetadata(existing.metadata, existing);
            const supportInfo = parseSupportInfo(meta.support_info);
            const updated = updateSupportStats(supportInfo, contextLabel, "contradict");
            meta.support_info = updated;
            await this.store.update(matchId, { metadata: stringifySmartMetadata(this.withAdmissionAudit({ ...meta, ...runtimeMetadata }, admissionAudit)) }, scopeFilter);
        }
        // 2. Store the contradicting entry as a new memory
        const storeCategory = this.mapToStoreCategory(candidate.category);
        const metadata = stringifySmartMetadata(this.withAdmissionAudit({
            ...runtimeMetadata,
            l0_abstract: candidate.abstract,
            l1_overview: candidate.overview,
            l2_content: candidate.content,
            memory_category: candidate.category,
            tier: "working",
            access_count: 0,
            confidence: 0.7,
            last_accessed_at: Date.now(),
            source_session: sessionKey,
            source: "auto-capture",
            state: "confirmed", // #350: write confirmed to unblock auto-recall
            memory_layer: "working",
            injected_count: 0,
            bad_recall_count: 0,
            suppressed_until_turn: 0,
            contexts: contextLabel ? [contextLabel] : [],
            relations: [{ type: "contradicts", targetId: matchId }],
        }, admissionAudit));
        const created = await this.store.store({
            text: candidate.abstract,
            vector,
            category: storeCategory,
            scope: targetScope,
            importance: this.getDefaultImportance(candidate.category),
            metadata,
        });
        await recordConflictReviewRelations(this.store, created, scopeFilter ?? [targetScope]).catch((err) => {
            this.log(`clawlore: smart-extractor: conflict-review marking failed: ${diagnosticErrorSummary(err)}`);
        });
        this.log(`clawlore: smart-extractor: contradict context=${diagnosticTextSummary(contextLabel || "general")} ` +
            `on=${diagnosticIdentifier(matchId)}, new entry created`);
    }
    // --------------------------------------------------------------------------
    // Store Helper
    // --------------------------------------------------------------------------
    /**
     * Store a candidate memory as a new entry with L0/L1/L2 metadata.
     */
    async storeCandidate(candidate, vector, sessionKey, targetScope, admissionAudit, runtimeMetadata = {}) {
        // Map 6-category to existing store categories for backward compatibility
        const storeCategory = this.mapToStoreCategory(candidate.category);
        const metadata = stringifySmartMetadata(buildSmartMetadata({
            text: candidate.abstract,
            category: this.mapToStoreCategory(candidate.category),
        }, {
            ...runtimeMetadata,
            l0_abstract: candidate.abstract,
            l1_overview: candidate.overview,
            l2_content: candidate.content,
            memory_category: candidate.category,
            tier: "working",
            access_count: 0,
            confidence: 0.7,
            source_session: sessionKey,
            source: "auto-capture",
            state: "confirmed", // #350: write confirmed to unblock auto-recall
            memory_layer: "working",
            injected_count: 0,
            bad_recall_count: 0,
            suppressed_until_turn: 0,
        }));
        await this.store.store({
            text: candidate.abstract, // L0 used as the searchable text
            vector,
            category: storeCategory,
            scope: targetScope,
            importance: this.getDefaultImportance(candidate.category),
            metadata,
        });
        this.log(`clawlore: smart-extractor: created [${candidate.category}] ` +
            `abstract=${diagnosticTextSummary(candidate.abstract)}`);
    }
    /**
     * Map 6-category to existing 5-category store type for backward compatibility.
     */
    mapToStoreCategory(category) {
        switch (category) {
            case "profile":
                return "fact";
            case "preferences":
                return "preference";
            case "entities":
                return "entity";
            case "events":
                return "decision";
            case "cases":
                return "fact";
            case "patterns":
                return "other";
            default:
                return "other";
        }
    }
    /**
     * Get default importance score by category.
     */
    getDefaultImportance(category) {
        switch (category) {
            case "profile":
                return 0.9; // Identity is very important
            case "preferences":
                return 0.8;
            case "entities":
                return 0.7;
            case "events":
                return 0.6;
            case "cases":
                return 0.8; // Problem-solution pairs are high value
            case "patterns":
                return 0.85; // Reusable processes are high value
            default:
                return 0.5;
        }
    }
    // --------------------------------------------------------------------------
    // Admission Control Helpers
    // --------------------------------------------------------------------------
    /**
     * Embed admission audit record into metadata if audit persistence is enabled.
     */
    withAdmissionAudit(metadata, admissionAudit) {
        if (!admissionAudit || !this.persistAdmissionAudit) {
            return metadata;
        }
        return { ...metadata, admission_control: admissionAudit };
    }
    /**
     * Record a rejected admission to the durable audit log.
     */
    async recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter, audit, runtimeMetadata = {}) {
        if (!this.onAdmissionRejected) {
            return;
        }
        try {
            await this.onAdmissionRejected({
                version: "amac-v1",
                rejected_at: Date.now(),
                session_key: sessionKey,
                target_scope: targetScope,
                scope_filter: scopeFilter,
                runtime_metadata: runtimeMetadata,
                candidate: {
                    ...candidate,
                    abstract: redactAuditText(candidate.abstract),
                    content: redactAuditText(candidate.content),
                },
                audit,
                conversation_excerpt: redactAuditText(conversationText.slice(-1200)),
            });
        }
        catch (err) {
            this.log(`clawlore: smart-extractor: rejected admission audit write failed: ${diagnosticErrorSummary(err)}`);
        }
    }
}
function redactAuditText(value) {
    const length = typeof value === "string" ? value.length : 0;
    return `[redacted conversation-derived text; chars=${length}]`;
}
// ============================================================================
// Extraction Rate Limiter (Feature 7: Adaptive Extraction Throttling)
// ============================================================================
const ONE_HOUR_MS = 60 * 60 * 1000;
/**
 * Create an extraction rate limiter that tracks timestamps in a sliding
 * one-hour window.
 */
export function createExtractionRateLimiter(options = {}) {
    const maxPerHour = options.maxExtractionsPerHour ?? 30;
    const timestamps = [];
    function pruneOld() {
        const cutoff = Date.now() - ONE_HOUR_MS;
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }
    }
    return {
        isRateLimited() {
            pruneOld();
            return timestamps.length >= maxPerHour;
        },
        recordExtraction() {
            pruneOld();
            timestamps.push(Date.now());
        },
        getRecentCount() {
            pruneOld();
            return timestamps.length;
        },
    };
}
