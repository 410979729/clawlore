import { createHash } from "node:crypto";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import { normalizeCandidateContentV1 } from "./candidate-content-quality-review.js";
const EXPECTED_REWRITE_ROWS = 32;
const EXPECTED_OVERSIZED_ROWS = 7;
const MIN_PROPOSED_CONTENT_LENGTH = 40;
const MAX_PROPOSED_CONTENT_LENGTH = 1_000;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function validateSpecification(specification) {
    for (const digest of [
        specification.itemIdSha256,
        specification.currentRevisionIdSha256,
        specification.knowledgeEvidenceDigest,
    ])
        if (!isDigest(digest))
            throw new Error("unsafe trace rewrite specification digest is invalid");
    if (!["segment_oversized_result", "extract_durable_result"].includes(specification.rewriteDesign)) {
        throw new Error("unsafe trace rewrite specification design is invalid");
    }
    if (!["covered_by_existing_truth", "materially_new_bounded_truth"].includes(specification.knowledgeCoverage)) {
        throw new Error("unsafe trace rewrite knowledge coverage is invalid");
    }
    if (!Array.isArray(specification.proposedContents) || specification.proposedContents.length === 0) {
        throw new Error("unsafe trace rewrite specification requires proposed content");
    }
    const maximum = specification.rewriteDesign === "segment_oversized_result" ? 4 : 1;
    if (specification.proposedContents.length > maximum) {
        throw new Error("unsafe trace rewrite proposal exceeds its bounded output count");
    }
    for (const content of specification.proposedContents) {
        if (typeof content !== "string"
            || content !== content.trim()
            || content.length < MIN_PROPOSED_CONTENT_LENGTH
            || content.length > MAX_PROPOSED_CONTENT_LENGTH)
            throw new Error("unsafe trace rewrite content is outside the bounded prose contract");
    }
}
export function planCandidateUnsafeTraceRewriteProposalV1(rows, specifications, corpusContents) {
    if (rows.length !== EXPECTED_REWRITE_ROWS
        || new Set(rows.map((row) => row.itemIdSha256)).size !== EXPECTED_REWRITE_ROWS
        || rows.filter((row) => row.rewriteDesign === "segment_oversized_result").length !== EXPECTED_OVERSIZED_ROWS
        || rows.filter((row) => row.rewriteDesign === "extract_durable_result").length
            !== EXPECTED_REWRITE_ROWS - EXPECTED_OVERSIZED_ROWS)
        throw new Error("unsafe trace rewrite proposal requires the exact 7/25 rewrite lane");
    for (const row of rows) {
        if (row.proposedAction !== "hold_for_separate_bounded_rewrite_proposal"
            || row.mutationReady !== false
            || row.proposedLifecycle !== "candidate"
            || row.proposedVerification !== "unverified"
            || row.removeCommandAndToolEnvelope !== true
            || row.requireCaptureSafetyPass !== true
            || row.requireCorpusDeduplication !== true
            || row.maximumProposedRows !== (row.rewriteDesign === "segment_oversized_result" ? 4 : 1))
            throw new Error("unsafe trace rewrite target is outside the protected design lane");
    }
    const specificationsByItem = new Map();
    for (const specification of specifications) {
        validateSpecification(specification);
        if (specificationsByItem.has(specification.itemIdSha256)) {
            throw new Error("unsafe trace rewrite specifications must be unique");
        }
        specificationsByItem.set(specification.itemIdSha256, specification);
    }
    if (specificationsByItem.size !== rows.length) {
        throw new Error("unsafe trace rewrite specifications must cover every held row");
    }
    const corpusDigests = new Map();
    for (const content of corpusContents) {
        const digest = hash(normalizeCandidateContentV1(content));
        corpusDigests.set(digest, (corpusDigests.get(digest) ?? 0) + 1);
    }
    const proposedDigests = new Set();
    const plannedRows = [];
    for (const row of [...rows].sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256))) {
        const specification = specificationsByItem.get(row.itemIdSha256);
        if (!specification
            || specification.currentRevisionIdSha256 !== row.currentRevisionIdSha256
            || specification.rewriteDesign !== row.rewriteDesign)
            throw new Error("unsafe trace rewrite specification no longer matches its held row");
        const outputs = specification.proposedContents.map((content, index) => {
            const safety = evaluateCaptureSafety(content);
            if (!safety.allowed)
                throw new Error("unsafe trace rewrite proposal still contains capture-unsafe material");
            const normalizedDigest = hash(normalizeCandidateContentV1(content));
            if (normalizedDigest === row.normalizedContentDigest) {
                throw new Error("unsafe trace rewrite proposal did not change the unsafe normalized content");
            }
            if ((corpusDigests.get(normalizedDigest) ?? 0) !== 0) {
                throw new Error("unsafe trace rewrite proposal collides with current corpus content");
            }
            if (proposedDigests.has(normalizedDigest)) {
                throw new Error("unsafe trace rewrite proposals must be mutually distinct");
            }
            proposedDigests.add(normalizedDigest);
            return {
                ordinal: index + 1,
                proposedContentDigest: hash(content),
                proposedNormalizedContentDigest: normalizedDigest,
                proposedContentLength: content.length,
                captureSafetyAllowed: true,
                corpusCollisionRows: 0,
            };
        });
        plannedRows.push({
            itemIdSha256: row.itemIdSha256,
            currentRevisionIdSha256: row.currentRevisionIdSha256,
            contentDigest: row.contentDigest,
            normalizedContentDigest: row.normalizedContentDigest,
            sourceLineageReceiptDigest: row.sourceLineageReceiptDigest,
            category: row.category,
            captureSafetyPattern: row.captureSafetyPattern,
            captureSafetyLane: row.captureSafetyLane,
            reason: row.reason,
            resultDigest: row.resultDigest,
            rewriteDesign: row.rewriteDesign,
            knowledgeCoverage: specification.knowledgeCoverage,
            knowledgeEvidenceDigest: specification.knowledgeEvidenceDigest,
            outputs,
            proposedOutputRows: outputs.length,
            maximumProposedRows: row.maximumProposedRows,
            removeCommandAndToolEnvelope: true,
            requireCaptureSafetyPass: true,
            requireCorpusDeduplication: true,
            proposedAction: "hold_for_separate_exact_rewrite_apply",
            mutationReady: false,
            proposedLifecycle: "candidate",
            proposedVerification: "unverified",
        });
    }
    for (const itemIdSha256 of specificationsByItem.keys()) {
        if (!rows.some((row) => row.itemIdSha256 === itemIdSha256)) {
            throw new Error("unsafe trace rewrite specification targets an unknown row");
        }
    }
    return {
        summary: {
            targetRows: plannedRows.length,
            oversizedSegmentationRows: plannedRows.filter((row) => row.rewriteDesign === "segment_oversized_result").length,
            semanticExtractionRows: plannedRows.filter((row) => row.rewriteDesign === "extract_durable_result").length,
            proposedDurableRows: plannedRows.reduce((total, row) => total + row.proposedOutputRows, 0),
            captureSafeProposals: plannedRows.reduce((total, row) => total + row.outputs.length, 0),
            coveredByExistingTruthRows: plannedRows.filter((row) => row.knowledgeCoverage === "covered_by_existing_truth").length,
            materiallyNewTruthRows: plannedRows.filter((row) => row.knowledgeCoverage === "materially_new_bounded_truth").length,
            corpusCollisionRows: 0,
            mutationReadyRows: 0,
        },
        rows: plannedRows,
    };
}
