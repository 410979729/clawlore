import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createLiveCandidateEvidenceRemediationPlanV1, } from "./live-candidate-evidence-remediation.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 2 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateFile(path, maxBytes = CONTROL_MAX_BYTES) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > maxBytes) {
        throw new Error("control input must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function loadRemediationPreview(path) {
    const loaded = privateFile(path);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (value.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-evidence-remediation-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsRawIdentifiers !== false
        || value.authorizesLifecycleMutation !== false
        || value.automaticPromotionRows !== 0
        || !/^[a-f0-9]{64}$/i.test(value.planDigest ?? "")
        || !Array.isArray(value.rows))
        throw new Error("remediation preview contract is invalid");
    return { value, sha256: loaded.sha256 };
}
function decisionFor(row) {
    if (row.lane === "registry_private_assignment_review") {
        return {
            decision: "propose_private_principal_evidence_assignment",
            resolver: "sessions_registry_exact_private_v1",
        };
    }
    if (row.lane === "registry_conversation_assignment_review") {
        return {
            decision: "propose_conversation_boundary_evidence_assignment",
            resolver: "sessions_registry_exact_conversation_v1",
        };
    }
    if (row.lane === "manual_principal_assignment_review") {
        return { decision: "keep_candidate_unassigned" };
    }
    if ([
        "registry_other_boundary_review",
        "derived_system_evidence_review",
        "known_source_evidence_review",
        "unresolved_session_review",
    ].includes(row.lane)) {
        return { decision: "await_external_source_receipt" };
    }
    return { decision: "retain_quarantine" };
}
function stableStateDigest(row) {
    return hash(JSON.stringify({
        itemId: row.item_id,
        currentRevisionId: row.current_revision_id,
        addressJson: row.address_json,
        lifecycle: row.lifecycle,
        verification: row.verification,
    }));
}
function assertSameRemediationPlan(expected, actual) {
    if (actual.planDigest !== expected.planDigest || JSON.stringify(actual.source) !== JSON.stringify(expected.source)) {
        throw new Error("live remediation plan no longer matches the approved read-only baseline");
    }
    const expectedRows = new Map(expected.rows.map((row) => [row.itemIdSha256, JSON.stringify(row)]));
    if (expectedRows.size !== actual.rows.length
        || actual.rows.some((row) => expectedRows.get(row.itemIdSha256) !== JSON.stringify(row)))
        throw new Error("live remediation rows no longer match the read-only baseline");
}
export function createLiveEvidenceAssignmentPlanV1(input) {
    if (!/^clawlore-v2-evidence-assignment-[a-z0-9-]+$/i.test(input.proposedRolloutId)) {
        throw new Error("proposed rollout id is invalid");
    }
    const loaded = loadRemediationPreview(input.remediationPreviewPath);
    const registry = privateFile(input.sessionsRegistryPath, 4 * 1024 * 1024);
    const baseline = privateFile(input.baselinePromotionPreviewPath);
    if (baseline.sha256 !== loaded.value.baselinePreviewSha256) {
        throw new Error("promotion baseline checksum no longer matches remediation preview");
    }
    const currentRemediation = createLiveCandidateEvidenceRemediationPlanV1({
        sourcePath: input.sourcePath,
        sessionsRegistryPath: input.sessionsRegistryPath,
        baselinePreviewPath: input.baselinePromotionPreviewPath,
    });
    assertSameRemediationPlan(loaded.value, currentRemediation);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    let states;
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        states = db.prepare(`SELECT item_id,current_revision_id,address_json,lifecycle,verification
      FROM memory_items WHERE lifecycle='candidate' ORDER BY item_id`).all();
    }
    finally {
        db.close();
    }
    if (states.length !== loaded.value.source.candidateRows) {
        throw new Error("live candidate count no longer matches remediation preview");
    }
    const remediationRows = new Map(loaded.value.rows.map((row) => [row.itemIdSha256, row]));
    if (remediationRows.size !== states.length)
        throw new Error("remediation candidate coverage is incomplete");
    const rows = states.map((state) => {
        const itemIdSha256 = hash(state.item_id);
        const remediation = remediationRows.get(itemIdSha256);
        if (!remediation)
            throw new Error("live candidate is missing from remediation preview");
        const route = decisionFor(remediation);
        const currentStateDigest = stableStateDigest(state);
        if (route.resolver && !/^[a-f0-9]{64}$/i.test(remediation.evidenceDigest ?? "")) {
            throw new Error("registry assignment is missing exact resolver evidence");
        }
        const proposedEvidencePayloadDigest = route.resolver
            ? hash(JSON.stringify({
                proposedRolloutId: input.proposedRolloutId,
                itemIdSha256,
                currentStateDigest,
                lane: remediation.lane,
                resolver: route.resolver,
                resolverEvidenceDigest: remediation.evidenceDigest,
                evidenceKind: route.decision,
                preserveLifecycle: "candidate",
                preserveVerification: state.verification,
            }))
            : undefined;
        return {
            itemIdSha256,
            currentStateDigest,
            lane: remediation.lane,
            decision: route.decision,
            ...(route.resolver ? {
                resolver: route.resolver,
                resolverEvidenceDigest: remediation.evidenceDigest,
                proposedEvidencePayloadDigest,
            } : {}),
            postLifecycle: "candidate",
            postVerification: state.verification,
            lifecycleMutationAllowed: false,
        };
    });
    const decisionNames = [
        "propose_private_principal_evidence_assignment",
        "propose_conversation_boundary_evidence_assignment",
        "keep_candidate_unassigned",
        "await_external_source_receipt",
        "retain_quarantine",
    ];
    const decisions = Object.fromEntries(decisionNames.map((decision) => [
        decision,
        rows.filter((row) => row.decision === decision).length,
    ]));
    const proposedEvidenceAssignmentRows = decisions.propose_private_principal_evidence_assignment
        + decisions.propose_conversation_boundary_evidence_assignment;
    const explicitHoldRows = decisions.keep_candidate_unassigned + decisions.await_external_source_receipt;
    const quarantineRows = decisions.retain_quarantine;
    if (proposedEvidenceAssignmentRows + explicitHoldRows + quarantineRows !== states.length) {
        throw new Error("evidence assignment plan does not cover every candidate exactly once");
    }
    const after = createLiveCandidateEvidenceRemediationPlanV1({
        sourcePath: input.sourcePath,
        sessionsRegistryPath: input.sessionsRegistryPath,
        baselinePreviewPath: input.baselinePromotionPreviewPath,
    });
    assertSameRemediationPlan(loaded.value, after);
    const planCore = {
        proposedRolloutId: input.proposedRolloutId,
        remediationPlanDigest: loaded.value.planDigest,
        remediationPreviewSha256: loaded.sha256,
        sessionsRegistrySha256: registry.sha256,
        source: loaded.value.source,
        summary: {
            proposedEvidenceAssignmentRows,
            explicitHoldRows,
            quarantineRows,
            lifecycleRowsChanged: 0,
            verificationRowsChanged: 0,
        },
        decisions,
        rows,
    };
    return {
        schemaVersion: 1,
        phase: "clawlore-evidence-assignment-plan",
        readOnly: true,
        queryOnly: true,
        emitsMemoryContent: false,
        emitsTranscriptContent: false,
        emitsRawIdentifiers: false,
        automaticPromotionRows: 0,
        authorizesEvidenceWrite: false,
        authorizesLifecycleMutation: false,
        authorizesContextEngine: false,
        authorizesPromptMutation: false,
        authorizesFinalRecall: false,
        requiresFreshSnapshotBeforeApply: true,
        requiresSeparateOperatorApproval: true,
        ...planCore,
        planDigest: hash(JSON.stringify(planCore)),
    };
}
