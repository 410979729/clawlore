function common(row) {
    return {
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
    };
}
export function planCandidateUnsafeTraceDispositionV1(rows) {
    if (rows.length === 0)
        throw new Error("unsafe trace disposition requires at least one row");
    if (new Set(rows.map((row) => row.itemIdSha256)).size !== rows.length) {
        throw new Error("unsafe trace disposition rows must be unique");
    }
    const archiveRows = rows.filter((row) => row.disposition === "soft_archive_proposal")
        .map((row) => {
        if (row.oversized || row.mutationReady !== false || row.proposedLifecycle !== "candidate"
            || row.proposedVerification !== "unverified") {
            throw new Error("unsafe trace archive target is outside the conservative adjudication boundary");
        }
        return {
            ...common(row),
            proposedAction: "soft_archive_under_separate_exact_apply",
            mutationReady: false,
            proposedLifecycle: "archived",
            proposedVerification: "unverified",
        };
    })
        .sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    const rewriteDesigns = rows.filter((row) => row.disposition === "bounded_rewrite_hold")
        .map((row) => {
        if (row.mutationReady !== false || row.proposedLifecycle !== "candidate"
            || row.proposedVerification !== "unverified") {
            throw new Error("unsafe trace rewrite target is outside the conservative adjudication boundary");
        }
        const oversized = row.reason === "oversized_trace_requires_segmentation";
        if (oversized !== row.oversized) {
            throw new Error("unsafe trace rewrite segmentation design does not match the adjudication");
        }
        return {
            ...common(row),
            rewriteDesign: oversized ? "segment_oversized_result" : "extract_durable_result",
            maximumProposedRows: oversized ? 4 : 1,
            removeCommandAndToolEnvelope: true,
            requireCaptureSafetyPass: true,
            requireCorpusDeduplication: true,
            proposedAction: "hold_for_separate_bounded_rewrite_proposal",
            mutationReady: false,
            proposedLifecycle: "candidate",
            proposedVerification: "unverified",
        };
    })
        .sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    if (archiveRows.length + rewriteDesigns.length !== rows.length) {
        throw new Error("unsafe trace disposition does not cover the complete adjudication");
    }
    return {
        summary: {
            targetRows: rows.length,
            softArchiveRows: archiveRows.length,
            boundedRewriteRows: rewriteDesigns.length,
            oversizedSegmentationRows: rewriteDesigns.filter((row) => row.rewriteDesign === "segment_oversized_result").length,
            semanticExtractionRows: rewriteDesigns.filter((row) => row.rewriteDesign === "extract_durable_result").length,
            mutationReadyRows: 0,
        },
        archiveRows,
        rewriteDesigns,
    };
}
