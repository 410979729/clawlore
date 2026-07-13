function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function validateDecision(decision) {
    if (!isDigest(decision.normalizedContentDigest) || !isDigest(decision.evidenceDigest)) {
        throw new Error("duplicate-trace decision digests are invalid");
    }
    if (!Number.isInteger(decision.expectedGroupSize) || decision.expectedGroupSize < 2) {
        throw new Error("duplicate-trace decision group size is invalid");
    }
    if (decision.disposition === "propose_soft_archive") {
        if (!["covered_by_existing_truth", "transient_operational_trace"].includes(decision.basis)) {
            throw new Error("soft-archive proposal requires existing truth or transient-trace evidence");
        }
        return;
    }
    if (decision.disposition !== "hold_for_bounded_rewrite" || decision.basis !== "durable_fact_requires_rewrite") {
        throw new Error("rewrite hold requires durable-fact evidence");
    }
}
export function adjudicateCandidateDuplicateTracesV1(rows, decisions) {
    const duplicateRows = rows.filter((row) => row.lane === "exact_duplicate_operational_trace_review");
    if (duplicateRows.length === 0 || duplicateRows.length !== rows.length) {
        throw new Error("duplicate-trace adjudication accepts the exact duplicate lane only");
    }
    const groups = new Map();
    for (const row of duplicateRows) {
        if (row.captureSafetyReason !== "operational-trace"
            || !["command-hints-block", "tool-fields-block"].includes(row.captureSafetyPattern)
            || row.exactDuplicate !== true
            || row.proposedLifecycle !== "candidate"
            || row.proposedVerification !== "unverified")
            throw new Error("duplicate-trace row is outside the protected lane");
        for (const digest of [
            row.itemIdSha256,
            row.currentRevisionIdSha256,
            row.contentDigest,
            row.normalizedContentDigest,
            row.sourceLineageReceiptDigest,
        ])
            if (!isDigest(digest))
                throw new Error("duplicate-trace row digest is invalid");
        const group = groups.get(row.normalizedContentDigest) ?? [];
        group.push(row);
        groups.set(row.normalizedContentDigest, group);
    }
    for (const group of groups.values()) {
        if (group.length < 2)
            throw new Error("duplicate-trace group is not duplicated inside the exact lane");
    }
    const decisionsByDigest = new Map();
    for (const decision of decisions) {
        validateDecision(decision);
        if (decisionsByDigest.has(decision.normalizedContentDigest)) {
            throw new Error("duplicate-trace decisions must be unique");
        }
        decisionsByDigest.set(decision.normalizedContentDigest, decision);
    }
    if (decisionsByDigest.size !== groups.size) {
        throw new Error("duplicate-trace decisions must cover every exact group");
    }
    for (const [digest, group] of groups) {
        const decision = decisionsByDigest.get(digest);
        if (!decision || decision.expectedGroupSize !== group.length) {
            throw new Error("duplicate-trace decision no longer matches the exact group");
        }
    }
    for (const digest of decisionsByDigest.keys()) {
        if (!groups.has(digest))
            throw new Error("duplicate-trace decision targets an unknown group");
    }
    const orderedGroups = [...decisions].sort((left, right) => left.normalizedContentDigest.localeCompare(right.normalizedContentDigest));
    const adjudicatedRows = duplicateRows.map((row) => {
        const decision = decisionsByDigest.get(row.normalizedContentDigest);
        return {
            itemIdSha256: row.itemIdSha256,
            currentRevisionIdSha256: row.currentRevisionIdSha256,
            contentDigest: row.contentDigest,
            normalizedContentDigest: row.normalizedContentDigest,
            sourceLineageReceiptDigest: row.sourceLineageReceiptDigest,
            category: row.category,
            captureSafetyReason: "operational-trace",
            captureSafetyPattern: row.captureSafetyPattern,
            duplicateGroupSize: decision.expectedGroupSize,
            oversized: row.oversized,
            disposition: decision.disposition,
            basis: decision.basis,
            evidenceDigest: decision.evidenceDigest,
            proposedNextAction: decision.disposition === "propose_soft_archive"
                ? "soft_archive_under_separate_exact_apply"
                : "bounded_rewrite_under_separate_review",
            mutationReady: false,
            proposedLifecycle: "candidate",
            proposedVerification: "unverified",
        };
    }).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    const softArchiveGroups = orderedGroups.filter((group) => group.disposition === "propose_soft_archive");
    const rewriteHoldGroups = orderedGroups.filter((group) => group.disposition === "hold_for_bounded_rewrite");
    return {
        summary: {
            targetGroups: groups.size,
            targetRows: adjudicatedRows.length,
            softArchiveGroups: softArchiveGroups.length,
            softArchiveRows: adjudicatedRows.filter((row) => row.disposition === "propose_soft_archive").length,
            rewriteHoldGroups: rewriteHoldGroups.length,
            rewriteHoldRows: adjudicatedRows.filter((row) => row.disposition === "hold_for_bounded_rewrite").length,
            mutationReadyRows: 0,
        },
        groups: orderedGroups,
        rows: adjudicatedRows,
    };
}
