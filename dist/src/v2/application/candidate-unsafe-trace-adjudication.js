import { createHash } from "node:crypto";
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function extractResult(content) {
    const matches = [...content.matchAll(/^Result:\s*/gim)];
    if (matches.length === 0)
        return "";
    const match = matches[matches.length - 1];
    return content.slice((match.index ?? 0) + match[0].length)
        .replace(/\|\s*status=(?:completed|failed|running|cancelled)[\s\S]*$/i, "")
        .trim();
}
function lengthBand(length) {
    if (length === 0)
        return "empty";
    if (length <= 200)
        return "le200";
    if (length <= 1_000)
        return "le1000";
    if (length <= 4_000)
        return "le4000";
    return "gt4000";
}
function reasonFor(input, result) {
    if (input.review.oversized) {
        return { disposition: "bounded_rewrite_hold", reason: "oversized_trace_requires_segmentation" };
    }
    if (!result)
        return { disposition: "soft_archive_proposal", reason: "pure_operational_trace" };
    if (/^(?:我)?(?:先|现在|继续|马上|接下来)?(?:开始|正在|继续|准备|会|把|先把).{0,80}(?:排查|定位|读取|检查|修改|修复|验证|审计|同步|跑测试|收口)/u.test(result)
        || /Reasoning stream enabled|PROGRESS_SMOKE_OK/i.test(result))
        return { disposition: "soft_archive_proposal", reason: "progress_or_smoke_noise" };
    if (/Phase\s*(?:[0-9]+[A-Z]?|[A-Z])|完整记录|运行报告|TODO、|迁移计划|项目交接|release gate|全量测试|提交[：:]|pack\s*\d+/iu.test(result))
        return { disposition: "soft_archive_proposal", reason: "project_report_covered_by_durable_artifact" };
    if (/最新稳定版|当前装的是|截至我刚查|盘口|赔率|比赛|GitHub Releases|npm\s+.*latest|缺\s*`?\d+`?\s*个提交/iu.test(result))
        return { disposition: "soft_archive_proposal", reason: "stale_external_snapshot" };
    if (/Gateway|healthz|NRestarts|PID\s*`?\d+|active\/running|当前会话|当前 live|刚实测|当前配置|当前状态/iu.test(result))
        return { disposition: "soft_archive_proposal", reason: "transient_runtime_state" };
    if (/已按授权处理完|归档到了|安装好了|装好了|已接上中断任务|已排好|不需要重启|可以直接列入|建好了/iu.test(result))
        return { disposition: "soft_archive_proposal", reason: "operation_completion_trace" };
    return { disposition: "bounded_rewrite_hold", reason: "semantic_result_requires_rewrite_review" };
}
export function adjudicateCandidateUnsafeTracesV1(inputs) {
    const seen = new Set();
    const rows = inputs.map((input) => {
        const review = input.review;
        if (seen.has(review.itemIdSha256))
            throw new Error("unsafe trace adjudication rows must be unique");
        if (review.captureSafetyReason !== "operational-trace"
            || !["command-hints-block", "tool-fields-block"].includes(review.captureSafetyPattern)
            || review.proposedLifecycle !== "candidate"
            || review.proposedVerification !== "unverified") {
            throw new Error("unsafe trace adjudication accepts conservative capture-safety rows only");
        }
        seen.add(review.itemIdSha256);
        const result = extractResult(input.content);
        return {
            itemIdSha256: review.itemIdSha256,
            currentRevisionIdSha256: review.currentRevisionIdSha256,
            contentDigest: review.contentDigest,
            normalizedContentDigest: review.normalizedContentDigest,
            sourceLineageReceiptDigest: review.sourceLineageReceiptDigest,
            category: review.category,
            captureSafetyPattern: review.captureSafetyPattern,
            captureSafetyLane: review.lane,
            oversized: review.oversized,
            resultDigest: hash(result),
            resultLengthBand: lengthBand(result.length),
            ...reasonFor(input, result),
            proposedLifecycle: "candidate",
            proposedVerification: "unverified",
            mutationReady: false,
        };
    }).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    const dispositions = ["soft_archive_proposal", "bounded_rewrite_hold"];
    const reasons = [
        "pure_operational_trace",
        "progress_or_smoke_noise",
        "project_report_covered_by_durable_artifact",
        "stale_external_snapshot",
        "transient_runtime_state",
        "operation_completion_trace",
        "oversized_trace_requires_segmentation",
        "semantic_result_requires_rewrite_review",
    ];
    const counts = Object.fromEntries(dispositions.map((disposition) => [disposition,
        rows.filter((row) => row.disposition === disposition).length]));
    const reasonCounts = Object.fromEntries(reasons.map((reason) => [reason,
        rows.filter((row) => row.reason === reason).length]));
    return {
        counts,
        reasons: reasonCounts,
        summary: {
            targetRows: rows.length,
            softArchiveProposalRows: counts.soft_archive_proposal,
            boundedRewriteHoldRows: counts.bounded_rewrite_hold,
            oversizedHoldRows: reasonCounts.oversized_trace_requires_segmentation,
            mutationReadyRows: 0,
        },
        rows,
    };
}
