import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 512 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function parseRecord(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function sessionFileIdentity(value) {
    const name = value.replace(/\\/g, "/").split("/").at(-1) ?? value;
    return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}
function addUnique(index, value, key) {
    const current = index.get(value);
    if (current === undefined)
        index.set(value, key);
    else if (current !== key)
        index.set(value, null);
}
function privateJson(path, maxBytes = CONTROL_MAX_BYTES) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > maxBytes) {
        throw new Error("control input must be a non-empty owner-only JSON file");
    }
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}
function loadRegistry(path) {
    const loaded = privateJson(path, 4 * 1024 * 1024);
    const parsed = loaded.value;
    const keys = new Set(Object.keys(parsed));
    const sessionIds = new Map();
    const sessionFiles = new Map();
    for (const [key, raw] of Object.entries(parsed)) {
        if (!raw || typeof raw !== "object")
            continue;
        const entry = raw;
        if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
            addUnique(sessionIds, entry.sessionId.trim(), key);
        }
        if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
            addUnique(sessionFiles, sessionFileIdentity(entry.sessionFile.trim()), key);
        }
    }
    return { keys, sessionIds, sessionFiles };
}
function sessionReferences(metadata) {
    return ["sessionKey", "session_key", "source_session", "sessionId", "session_id"]
        .map((field) => metadata[field])
        .filter((value) => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim());
}
function registryKeyFor(index, reference) {
    if (index.keys.has(reference))
        return reference;
    const byId = index.sessionIds.get(reference);
    if (byId)
        return byId;
    const byFile = index.sessionFiles.get(sessionFileIdentity(reference));
    return byFile || undefined;
}
function isDirectKey(value) {
    return /^agent:[^:]+:[^:]+:[^:]+:direct:[^:]+$/.test(value);
}
function isConversationKey(value) {
    return /^agent:[^:]+:[^:]+:group:[^:]+(?::topic:[^:]+)?$/.test(value);
}
function isLegacyAgentAlias(value) {
    const parts = value.split(":");
    return parts.length === 3 && parts[0] === "agent" && parts[1] === parts[2];
}
function derivedSystem(metadata) {
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    return ["summary", "digest", "reflection", "checkpoint", "pressure-guard", "pressure_guard"]
        .some((kind) => source.includes(kind));
}
function classification(row, metadata) {
    const evidence = parseRecord(row.evidence_json);
    const explicit = String(evidence.classification ?? "").trim();
    if (explicit)
        return explicit;
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    if (source.includes("manual") || source.includes("user"))
        return "explicit_manual";
    if (source.includes("reflection") || source.includes("summary") || source.includes("digest")) {
        return "reflection_summary";
    }
    if (source.includes("task") && source.includes("experience"))
        return "task_experience";
    if (source.includes("checkpoint") || source.includes("pressure"))
        return "operational_checkpoint";
    if (source.includes("capture"))
        return "auto_capture";
    return "unknown_legacy";
}
function assignedEvidenceKind(row) {
    const evidence = parseRecord(row.evidence_json).registryResolvedEvidenceV1;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
        return undefined;
    const kind = evidence.evidenceKind;
    return kind === "direct-principal" || kind === "conversation-boundary" ? kind : undefined;
}
function laneFor(row, registry) {
    const metadata = parseRecord(row.metadata);
    const references = sessionReferences(metadata);
    const matched = [...new Set(references.map((reference) => registryKeyFor(registry, reference)).filter(Boolean))];
    if (matched.length > 1) {
        return {
            lane: "conflicting_registry_quarantine",
            requiredActions: ["retain_quarantine", "resolve_conflicting_registry_evidence"],
        };
    }
    if (matched.length === 1) {
        const key = matched[0];
        const evidenceDigest = hash(JSON.stringify({ registryKey: key, references: [...references].sort() }));
        if (isDirectKey(key)) {
            return {
                lane: "registry_private_assignment_review",
                evidenceDigest,
                requiredActions: ["confirm_private_principal_assignment", "record_identity_evidence", "review_verification"],
            };
        }
        if (isConversationKey(key)) {
            return {
                lane: "registry_conversation_assignment_review",
                evidenceDigest,
                requiredActions: ["confirm_conversation_boundary_assignment", "record_boundary_evidence", "review_verification"],
            };
        }
        return {
            lane: "registry_other_boundary_review",
            evidenceDigest,
            requiredActions: ["classify_registry_boundary", "record_boundary_evidence", "keep_candidate_until_reviewed"],
        };
    }
    if (references.length > 0) {
        const first = references[0];
        if (isLegacyAgentAlias(first)) {
            return {
                lane: "legacy_agent_alias_quarantine",
                requiredActions: ["retain_quarantine", "require_external_identity_evidence_before_reconsideration"],
            };
        }
        if (derivedSystem(metadata)) {
            return {
                lane: "derived_system_evidence_review",
                requiredActions: ["attach_source_receipt", "operator_review", "keep_candidate_until_verified"],
            };
        }
        if (first.startsWith("agent:")) {
            return {
                lane: "unresolved_session_review",
                requiredActions: ["repair_or_map_session_registry_reference", "keep_candidate_until_attributed"],
            };
        }
        return {
            lane: "opaque_reference_quarantine",
            requiredActions: ["retain_quarantine", "require_external_provenance_before_reconsideration"],
        };
    }
    const kind = classification(row, metadata);
    if (kind === "explicit_manual") {
        return {
            lane: "manual_principal_assignment_review",
            requiredActions: ["operator_assign_principal_or_keep_candidate", "record_identity_evidence", "review_verification"],
        };
    }
    if (kind === "unknown_legacy") {
        return {
            lane: "unknown_legacy_quarantine",
            requiredActions: ["retain_quarantine", "require_external_provenance_before_reconsideration"],
        };
    }
    if (derivedSystem(metadata) || ["reflection_summary", "operational_checkpoint"].includes(kind)) {
        return {
            lane: "derived_system_evidence_review",
            requiredActions: ["attach_source_receipt", "operator_review", "keep_candidate_until_verified"],
        };
    }
    return {
        lane: "known_source_evidence_review",
        requiredActions: ["attach_source_receipt", "operator_review", "keep_candidate_until_verified"],
    };
}
function policyBoundLaneFor(row, registry, disposition) {
    if (!disposition)
        return laneFor(row, registry);
    const metadata = parseRecord(row.metadata);
    const kind = classification(row, metadata);
    if (disposition === "quarantine") {
        const raw = laneFor(row, registry);
        if (kind === "unknown_legacy") {
            return {
                lane: "unknown_legacy_quarantine",
                requiredActions: ["retain_quarantine", "require_external_provenance_before_reconsideration"],
            };
        }
        if (raw.lane.endsWith("_quarantine"))
            return raw;
        return {
            lane: "policy_quarantine_review",
            requiredActions: ["retain_quarantine", "resolve_policy_quarantine_reasons"],
        };
    }
    const assigned = assignedEvidenceKind(row);
    if (assigned === "direct-principal") {
        return {
            lane: "assigned_private_evidence_review",
            requiredActions: ["review_address_resolution", "attach_source_receipt", "operator_review", "keep_candidate_until_verified"],
        };
    }
    if (assigned === "conversation-boundary") {
        return {
            lane: "assigned_conversation_evidence_review",
            requiredActions: ["review_address_resolution", "attach_source_receipt", "operator_review", "keep_candidate_until_verified"],
        };
    }
    const raw = laneFor(row, registry);
    if (raw.lane.endsWith("_quarantine")) {
        return {
            lane: "legacy_provenance_hold_review",
            requiredActions: ["review_policy_hold_reasons", "attach_external_provenance", "keep_candidate_until_verified"],
        };
    }
    return raw;
}
function scalar(db, sql) {
    const row = db.prepare(sql).get();
    return Number(Object.values(row)[0] ?? 0);
}
function sourceState(db, includeAllProjections = false) {
    const compatibilityExists = Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name='memory_fts_compat_v2'").get());
    const source = {
        v1Rows: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
        v2Rows: scalar(db, "SELECT COUNT(*) FROM memory_items"),
        candidateRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
        activeRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
        archivedRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
        compatibilityRows: compatibilityExists ? scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2") : 0,
        pendingOutboxRows: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
    };
    if (includeAllProjections) {
        source.currentFtsRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_v2");
        source.vectorRows = scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2");
        source.relationRows = scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2");
    }
    return source;
}
function sourceMatchesBaseline(live, baseline) {
    return live.v1Rows === baseline.v1Rows
        && live.v2Rows === baseline.v2Rows
        && live.candidateRows === baseline.candidateRows
        && live.activeRows === baseline.activeRows
        && live.archivedRows === baseline.archivedRows
        && live.compatibilityRows === baseline.compatibilityRows
        && live.currentFtsRows === baseline.currentFtsRows
        && live.vectorRows === baseline.vectorRows
        && live.relationRows === baseline.relationRows
        && live.pendingOutboxRows === baseline.pendingOutboxRows;
}
export function createLiveCandidateEvidenceRemediationPlanV1(input) {
    const baselineLoaded = privateJson(input.baselinePreviewPath);
    const baseline = baselineLoaded.value;
    if (!["clawlore-phase7g-live-preview", "clawlore-post-assignment-candidate-plan"].includes(baseline.phase)
        || baseline.candidatePromotionPlan?.authorizesLiveMutation !== false
        || !/^[a-f0-9]{64}$/i.test(baseline.candidatePromotionPlan?.planDigest ?? "")
        || !Array.isArray(baseline.candidatePromotionPlan?.rows)
        || (baseline.phase === "clawlore-post-assignment-candidate-plan"
            && hash(JSON.stringify(baseline.candidatePromotionPlan.rows)) !== baseline.candidatePromotionPlan.planDigest))
        throw new Error("baseline promotion preview contract is invalid");
    const policyBound = baseline.phase === "clawlore-post-assignment-candidate-plan";
    if (policyBound && (baseline.decision?.eligibleRows !== 0
        || baseline.decision?.lifecycleRolloutSelectable !== false
        || baseline.candidatePromotionPlan.automaticPromotionRows !== 0
        || !baseline.source
        || baseline.candidatePromotionPlan.rows.some((row) => !["hold_candidate", "quarantine"].includes(row.disposition ?? ""))))
        throw new Error("current candidate baseline is not a zero-eligible remediation input");
    const registry = loadRegistry(input.sessionsRegistryPath);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = sourceState(db, policyBound);
        const sourceRows = db.prepare(`SELECT i.item_id,i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
        if (sourceRows.length !== before.candidateRows)
            throw new Error("candidate mapping is incomplete");
        const baselineHashes = new Set(baseline.candidatePromotionPlan.rows.map((row) => row.itemIdSha256));
        if (baselineHashes.size !== sourceRows.length || sourceRows.some((row) => !baselineHashes.has(hash(row.item_id)))) {
            throw new Error("live candidate set no longer matches baseline promotion preview");
        }
        if (policyBound && !sourceMatchesBaseline(before, baseline.source)) {
            throw new Error("live source no longer matches current candidate baseline");
        }
        const dispositions = new Map(baseline.candidatePromotionPlan.rows.map((row) => [row.itemIdSha256, row.disposition]));
        const rows = sourceRows.map((row) => ({
            itemIdSha256: hash(row.item_id),
            ...policyBoundLaneFor(row, registry, dispositions.get(hash(row.item_id))),
        }));
        const counts = Object.fromEntries([
            "registry_private_assignment_review", "registry_conversation_assignment_review",
            "registry_other_boundary_review", "assigned_private_evidence_review",
            "assigned_conversation_evidence_review", "manual_principal_assignment_review",
            "derived_system_evidence_review", "known_source_evidence_review",
            "unresolved_session_review", "legacy_provenance_hold_review", "policy_quarantine_review",
            "conflicting_registry_quarantine",
            "legacy_agent_alias_quarantine", "opaque_reference_quarantine",
            "unknown_legacy_quarantine",
        ].map((lane) => [lane, rows.filter((row) => row.lane === lane).length]));
        const after = sourceState(db, policyBound);
        if (JSON.stringify(before) !== JSON.stringify(after))
            throw new Error("live candidate state changed during read-only planning");
        const assignmentReviewRows = counts.registry_private_assignment_review
            + counts.registry_conversation_assignment_review
            + counts.registry_other_boundary_review
            + counts.manual_principal_assignment_review;
        const evidenceReviewRows = counts.assigned_private_evidence_review
            + counts.assigned_conversation_evidence_review
            + counts.derived_system_evidence_review
            + counts.known_source_evidence_review
            + counts.unresolved_session_review
            + counts.legacy_provenance_hold_review;
        const quarantineRows = rows.length - assignmentReviewRows - evidenceReviewRows;
        const policyHoldRows = policyBound
            ? baseline.candidatePromotionPlan.rows.filter((row) => row.disposition === "hold_candidate").length
            : undefined;
        const policyQuarantineRows = policyBound
            ? baseline.candidatePromotionPlan.rows.filter((row) => row.disposition === "quarantine").length
            : undefined;
        if (policyBound && (assignmentReviewRows + evidenceReviewRows !== policyHoldRows || quarantineRows !== policyQuarantineRows)) {
            throw new Error("remediation lanes do not preserve baseline policy dispositions");
        }
        const planCore = {
            baselinePhase: baseline.phase,
            baselinePromotionPlanDigest: baseline.candidatePromotionPlan.planDigest,
            baselinePreviewSha256: baselineLoaded.sha256,
            source: before,
            counts,
            summary: {
                assignmentReviewRows,
                evidenceReviewRows,
                quarantineRows,
                ...(policyBound ? { policyHoldRows, policyQuarantineRows } : {}),
                mutationReadyRows: 0,
            },
            rows,
        };
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-evidence-remediation-plan",
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsTranscriptContent: false,
            emitsRawIdentifiers: false,
            automaticPromotionRows: 0,
            authorizesLifecycleMutation: false,
            requiresOperatorReview: true,
            ...planCore,
            planDigest: hash(JSON.stringify(planCore)),
        };
    }
    finally {
        db.close();
    }
}
