import { createHash } from "node:crypto";
import { validateMemoryAddress } from "../domain/memory-address.js";
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function hasDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function addressEvidenceReasons(row) {
    const reasons = [];
    const evidence = row.evidence ?? {};
    const address = row.address;
    if (!validateMemoryAddress(address).valid)
        reasons.push("invalid_memory_address");
    if (!["private", "conversation", "project", "team", "global"].includes(address.visibility)) {
        reasons.push("invalid_visibility");
    }
    if (!["ephemeral", "working", "durable"].includes(address.retention))
        reasons.push("invalid_retention");
    if (address.principalId === "legacy:unresolved")
        reasons.push("unresolved_principal");
    switch (address.visibility) {
        case "private":
            if (!["runtime_principal", "registry_direct"].includes(row.attribution)) {
                reasons.push("private_identity_evidence_missing");
            }
            if (!hasDigest(evidence.identityEvidenceDigest))
                reasons.push("identity_evidence_digest_missing");
            if (evidence.resolvedPrincipalId !== address.principalId)
                reasons.push("principal_evidence_address_mismatch");
            break;
        case "conversation":
            if (row.attribution !== "registry_conversation")
                reasons.push("conversation_registry_evidence_missing");
            if (!address.conversationId)
                reasons.push("conversation_boundary_missing");
            if (!hasDigest(evidence.boundaryEvidenceDigest))
                reasons.push("boundary_evidence_digest_missing");
            if (evidence.resolvedConversationId !== address.conversationId) {
                reasons.push("conversation_evidence_address_mismatch");
            }
            break;
        case "project":
            if (row.attribution !== "operator_project")
                reasons.push("project_operator_mapping_missing");
            if (!address.projectId)
                reasons.push("project_boundary_missing");
            if (evidence.resolvedProjectId !== address.projectId)
                reasons.push("project_evidence_address_mismatch");
            if (!evidence.operatorReviewId?.trim())
                reasons.push("operator_review_missing");
            break;
        case "team":
        case "global":
            if (row.attribution !== "operator_global")
                reasons.push("broad_scope_operator_mapping_missing");
            if (!evidence.operatorReviewId?.trim())
                reasons.push("operator_review_missing");
            break;
        default:
            reasons.push("unsupported_visibility");
    }
    return reasons;
}
function reviewRow(row) {
    if (row.lifecycle === "archived" || row.lifecycle === "superseded" || row.lifecycle === "purged") {
        return { disposition: "preserve_archived", reasonCodes: ["non_active_lifecycle_preserved"] };
    }
    if (row.lifecycle !== "candidate") {
        return { disposition: "hold_candidate", reasonCodes: ["promotion_plan_accepts_candidates_only"] };
    }
    if (row.verification === "disputed") {
        return { disposition: "quarantine", reasonCodes: ["verification_disputed"] };
    }
    if (["opaque", "legacy_agent_alias"].includes(row.attribution) || row.classification === "unknown_legacy") {
        return { disposition: "quarantine", reasonCodes: ["unverifiable_legacy_provenance"] };
    }
    const addressReasons = addressEvidenceReasons(row);
    if (addressReasons.length > 0) {
        return { disposition: "hold_candidate", reasonCodes: addressReasons };
    }
    const evidence = row.evidence ?? {};
    const receipts = Math.max(0, Math.floor(evidence.sourceReceiptCount ?? 0));
    switch (row.classification) {
        case "explicit_manual":
            if (!["user_confirmed", "operator_reviewed"].includes(row.verification)) {
                return { disposition: "hold_candidate", reasonCodes: ["manual_confirmation_missing"] };
            }
            break;
        case "task_experience":
            if (!["tool_verified", "operator_reviewed"].includes(row.verification) || receipts < 1) {
                return { disposition: "hold_candidate", reasonCodes: ["task_receipt_or_verification_missing"] };
            }
            break;
        case "reflection_summary":
        case "operational_checkpoint":
        case "auto_capture":
            if (row.verification !== "operator_reviewed" || !evidence.operatorReviewId?.trim() || receipts < 1) {
                return { disposition: "hold_candidate", reasonCodes: ["automatic_source_operator_review_missing"] };
            }
            break;
        default:
            return { disposition: "quarantine", reasonCodes: ["unsupported_legacy_classification"] };
    }
    return {
        disposition: "eligible_for_promotion",
        reasonCodes: ["evidence_complete"],
    };
}
export function planCandidatePromotionsV1(rows) {
    const seen = new Set();
    const reviewed = rows.map((row) => {
        if (!row.itemId.trim() || seen.has(row.itemId))
            throw new Error("candidate item ids must be unique and non-empty");
        seen.add(row.itemId);
        return { itemIdSha256: hash(row.itemId), ...reviewRow(row) };
    });
    const counts = {
        eligible_for_promotion: 0,
        hold_candidate: 0,
        quarantine: 0,
        preserve_archived: 0,
    };
    for (const row of reviewed)
        counts[row.disposition] += 1;
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-promotion-plan",
        readOnly: true,
        emitsItemIds: false,
        automaticPromotionRows: 0,
        authorizesLiveMutation: false,
        counts,
        rows: reviewed,
        planDigest: hash(JSON.stringify(reviewed)),
    };
}
