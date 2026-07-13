function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function laneFor(row) {
    const duplicate = row.targetDuplicateGroupSize > 1 || row.corpusDuplicateGroupSize > 1;
    if (duplicate) {
        return {
            lane: "exact_duplicate_operational_trace_review",
            requiredActions: [
                "review_exact_duplicate_group",
                "reject_noise_or_extract_one_rewritten_candidate",
                "operator_decision_required",
                "keep_candidate_until_decided",
            ],
        };
    }
    if (row.contentLengthBand === "gt4000") {
        return {
            lane: "oversized_operational_trace_rewrite_review",
            requiredActions: [
                "inspect_for_durable_fact_segments",
                "reject_noise_or_propose_bounded_rewrite",
                "operator_decision_required",
                "keep_candidate_until_decided",
            ],
        };
    }
    if (row.captureSafety.pattern === "tool-fields-block") {
        return {
            lane: "tool_payload_rejection_review",
            requiredActions: [
                "confirm_tool_payload_noise",
                "reject_noise_or_propose_bounded_rewrite",
                "operator_decision_required",
                "keep_candidate_until_decided",
            ],
        };
    }
    return {
        lane: "command_trace_rejection_review",
        requiredActions: [
            "confirm_command_trace_noise",
            "reject_noise_or_propose_bounded_rewrite",
            "operator_decision_required",
            "keep_candidate_until_decided",
        ],
    };
}
export function planCandidateCaptureSafetyReviewV1(rows) {
    const seen = new Set();
    const reviewed = rows.map((row) => {
        if (row.lane !== "capture_safety_reject_review"
            || row.captureSafety.allowed !== false
            || row.captureSafety.reason !== "operational-trace"
            || !["command-hints-block", "tool-fields-block"].includes(row.captureSafety.pattern ?? "")
            || row.postLifecycle !== "candidate"
            || row.postVerification !== "unverified")
            throw new Error("capture-safety review accepts exact operational-trace candidate rows only");
        for (const digest of [
            row.itemIdSha256,
            row.currentRevisionIdSha256,
            row.contentDigest,
            row.normalizedContentDigest,
            row.sourceLineageReceiptDigest,
        ]) {
            if (!isDigest(digest))
                throw new Error("capture-safety review row digest is invalid");
        }
        if (seen.has(row.itemIdSha256))
            throw new Error("capture-safety review rows must be unique");
        seen.add(row.itemIdSha256);
        const exactDuplicate = row.targetDuplicateGroupSize > 1 || row.corpusDuplicateGroupSize > 1;
        const oversized = row.contentLengthBand === "gt4000";
        return {
            itemIdSha256: row.itemIdSha256,
            currentRevisionIdSha256: row.currentRevisionIdSha256,
            contentDigest: row.contentDigest,
            normalizedContentDigest: row.normalizedContentDigest,
            sourceLineageReceiptDigest: row.sourceLineageReceiptDigest,
            category: row.category,
            captureSafetyReason: "operational-trace",
            captureSafetyPattern: row.captureSafety.pattern,
            exactDuplicate,
            oversized,
            ...laneFor(row),
            proposedLifecycle: "candidate",
            proposedVerification: "unverified",
        };
    });
    const lanes = [
        "exact_duplicate_operational_trace_review",
        "oversized_operational_trace_rewrite_review",
        "command_trace_rejection_review",
        "tool_payload_rejection_review",
    ];
    const counts = Object.fromEntries(lanes.map((lane) => [lane, reviewed.filter((row) => row.lane === lane).length]));
    return {
        counts,
        summary: {
            targetRows: reviewed.length,
            exactDuplicateRows: reviewed.filter((row) => row.exactDuplicate).length,
            oversizedRows: reviewed.filter((row) => row.oversized).length,
            duplicateAndOversizedRows: reviewed.filter((row) => row.exactDuplicate && row.oversized).length,
            uniqueOversizedRows: reviewed.filter((row) => !row.exactDuplicate && row.oversized).length,
            directTraceReviewRows: counts.command_trace_rejection_review + counts.tool_payload_rejection_review,
            automaticArchiveRows: 0,
            mutationReadyRows: 0,
        },
        rows: reviewed.sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256)),
    };
}
