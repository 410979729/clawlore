import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WORD_RE = /[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
const REQUIRED_TABLES = [
    "memory_truth",
    "memory_truth_fts",
    "memory_items",
    "memory_sources",
    "memory_fts_v2",
    "memory_vector_projection_v2",
];
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function tokens(value) {
    const seen = new Set();
    const result = [];
    for (const match of value.toLowerCase().matchAll(WORD_RE)) {
        if (seen.has(match[0]))
            continue;
        seen.add(match[0]);
        result.push(match[0]);
    }
    return result;
}
function ftsQuery(value) {
    return tokens(value).slice(0, 12).map((token) => `"${token.replace(/"/g, " ")}"`).join(" OR ");
}
function lexicalScore(query, row) {
    const queryTokens = new Set(tokens(query));
    if (queryTokens.size === 0)
        return 0;
    const documentTokens = new Set(tokens(`${row.text}\n${row.category}`));
    let overlap = 0;
    for (const token of queryTokens)
        if (documentTokens.has(token))
            overlap += 1;
    const phrase = `${row.text}\n${row.category}`.toLowerCase().includes(query.trim().toLowerCase()) ? 0.35 : 0;
    return Math.min(1, (overlap / queryTokens.size) * 0.68 + phrase);
}
function commonRank(query, rows, limit) {
    return rows
        .map((row) => ({ row, score: lexicalScore(query, row) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score
        || right.row.observedAt - left.row.observedAt
        || left.row.id.localeCompare(right.row.id))
        .slice(0, limit)
        .map((entry) => entry.row);
}
function overlap(left, right) {
    if (left.length === 0 && right.length === 0)
        return 1;
    const denominator = Math.max(left.length, right.length, 1);
    const rightIds = new Set(right.map((row) => row.id));
    return left.filter((row) => rightIds.has(row.id)).length / denominator;
}
function rankAgreement(left, right) {
    if (left.length === 0 && right.length === 0)
        return 1;
    const rightRank = new Map(right.map((row, index) => [row.id, index]));
    const shared = left.map((row, index) => ({ left: index, right: rightRank.get(row.id) }))
        .filter((entry) => entry.right !== undefined);
    if (shared.length === 0)
        return 0;
    const span = Math.max(left.length, right.length, 2) - 1;
    return shared.reduce((sum, entry) => sum + (1 - Math.abs(entry.left - entry.right) / span), 0)
        / Math.max(left.length, right.length, 1);
}
function parseAddress(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
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
function digest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
/**
 * Content parity may intentionally diverge after a bounded governance rewrite.
 * Only a receipt bound to both the legacy and current content digests can make
 * that divergence comparable-safe; a label or rollout id alone is insufficient.
 */
function governanceRewriteAuthorized(v1, v2) {
    const evidence = parseRecord(v2.evidence);
    for (const key of ["unsafeTraceRewriteReceiptV1", "durableRewriteReceiptV1"]) {
        const receipt = evidence[key];
        if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
            continue;
        const value = receipt;
        if (value.schemaVersion === 1
            && typeof value.rolloutId === "string"
            && value.rolloutId.length >= 8
            && digest(value.planDigest)
            && digest(value.sourceLineageReceiptDigest)
            // The legacy migration's only pre-rewrite normalization is trim().
            && (value.previousContentDigest === hash(v1.text)
                || value.previousContentDigest === hash(v1.text.trim()))
            && value.rewrittenContentDigest === hash(v2.text)
            && value.preservesCurrentLifecycle === true
            && value.preservesVerification === true
            && value.preservesAddress === true)
            return true;
    }
    return false;
}
function policyEligible(row, actor) {
    const address = row.address;
    if (!address || address.tenantId !== actor.tenantId || address.agentId !== actor.agentId)
        return false;
    if (address.workspaceId && address.workspaceId !== actor.workspaceId)
        return false;
    if (address.threadId && address.threadId !== actor.threadId)
        return false;
    switch (address.visibility) {
        case "global": return true;
        case "private": return address.principalId === actor.principalId;
        case "conversation": return Boolean(address.conversationId && address.conversationId === actor.conversationId);
        case "project": return Boolean(address.projectId && address.projectId === actor.projectId);
        default: return false;
    }
}
function injectable(row, actor) {
    return policyEligible(row, actor)
        && row.lifecycle === "active"
        && row.verification !== "unverified"
        && row.verification !== "disputed";
}
function v1Inactive(metadata) {
    try {
        const value = JSON.parse(metadata || "{}");
        return ["archived", "rejected", "superseded", "purged"]
            .includes(String(value.state ?? value.lifecycle ?? "").toLowerCase());
    }
    catch {
        return false;
    }
}
function scalar(db, sql, ...args) {
    const row = db.prepare(sql).get(...args);
    return Number(Object.values(row)[0] ?? 0);
}
function logicalDigest(db) {
    const rows = db.prepare(`SELECT id,text,category,scope,metadata FROM memory_truth ORDER BY id`).all();
    const v2 = db.prepare(`SELECT item_id,current_revision_id,content,category,address_json,lifecycle,verification
    FROM memory_items ORDER BY item_id`).all();
    return hash(JSON.stringify({ rows, v2 }));
}
function assertTables(db) {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((table) => !names.has(table));
    if (missing.length > 0)
        throw new Error(`recall parity requires tables: ${missing.join(",")}`);
}
function corpusRows(db) {
    const v1 = db.prepare(`SELECT id,text,category,scope,timestamp,metadata FROM memory_truth ORDER BY id`).all().map((row) => ({
        id: String(row.id), text: String(row.text), category: String(row.category),
        scope: String(row.scope), metadata: String(row.metadata || "{}"), observedAt: Number(row.timestamp || 0),
    }));
    const v2 = db.prepare(`SELECT s.external_id AS id,i.content AS text,i.category,i.address_json,
      i.lifecycle,i.verification,s.observed_at,s.evidence_json
    FROM memory_items i JOIN memory_sources s ON s.revision_id=i.current_revision_id AND s.source_type='legacy'
    ORDER BY s.external_id`).all().map((row) => ({
        id: String(row.id), text: String(row.text), category: String(row.category),
        address: parseAddress(String(row.address_json)), lifecycle: String(row.lifecycle),
        verification: String(row.verification), evidence: String(row.evidence_json || "{}"),
        observedAt: Date.parse(String(row.observed_at)) || 0,
    }));
    return { v1, v2 };
}
function nativeV1(db, query, limit) {
    const match = ftsQuery(query.queryText);
    if (!match || query.legacyScopes.length === 0)
        return [];
    const placeholders = query.legacyScopes.map(() => "?").join(",");
    return db.prepare(`SELECT m.id,m.text,m.category,m.scope,m.timestamp,m.metadata
      FROM memory_truth_fts f JOIN memory_truth m ON m.id=f.memory_id
      WHERE memory_truth_fts MATCH ? AND m.scope IN (${placeholders})
      AND (json_valid(m.metadata)=0 OR lower(coalesce(
        json_extract(m.metadata,'$.state'),json_extract(m.metadata,'$.lifecycle'),''
      )) NOT IN ('archived','rejected','superseded','purged'))
      ORDER BY bm25(memory_truth_fts),m.timestamp DESC,m.id LIMIT ?`)
        .all(match, ...query.legacyScopes, limit)
        .map((row) => ({ id: String(row.id), text: String(row.text), category: String(row.category),
        scope: String(row.scope), metadata: String(row.metadata || "{}"), observedAt: Number(row.timestamp || 0) }))
        .filter((row) => !v1Inactive(row.metadata));
}
function nativeV2(db, query, limit) {
    const match = ftsQuery(query.queryText);
    if (!match || query.legacyScopes.length === 0)
        return [];
    const placeholders = query.legacyScopes.map(() => "?").join(",");
    return db.prepare(`SELECT s.external_id AS id,i.content AS text,i.category,i.address_json,
      i.lifecycle,i.verification,s.observed_at
      FROM memory_fts_v2 f JOIN memory_items i ON i.item_id=f.item_id
      JOIN memory_sources s ON s.revision_id=i.current_revision_id AND s.source_type='legacy'
      JOIN memory_vector_projection_v2 v ON v.item_id=i.item_id AND v.legacy_id=s.external_id
      JOIN memory_truth legacy ON legacy.id=v.legacy_id
      WHERE memory_fts_v2 MATCH ? AND legacy.scope IN (${placeholders}) AND i.lifecycle!='archived'
      ORDER BY bm25(memory_fts_v2),s.observed_at DESC,s.external_id LIMIT ?`)
        .all(match, ...query.legacyScopes, limit).map((row) => ({
        id: String(row.id), text: String(row.text), category: String(row.category),
        address: parseAddress(String(row.address_json)), lifecycle: String(row.lifecycle),
        verification: String(row.verification), observedAt: Date.parse(String(row.observed_at)) || 0,
    }));
}
export function inspectLiveV1V2RecallParityV1(input) {
    if (input.queries.length === 0)
        throw new Error("at least one recall parity query is required");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sqlitePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; BEGIN");
        assertTables(db);
        const before = logicalDigest(db);
        const rows = corpusRows(db);
        const v1ById = new Map(rows.v1.map((row) => [row.id, row]));
        const v2ById = new Map(rows.v2.map((row) => [row.id, row]));
        const duplicateLegacyMappings = rows.v2.length - v2ById.size;
        let contentNormalizationOnlyRows = 0;
        let substantiveContentMismatches = 0;
        let governanceAuthorizedContentRewrites = 0;
        let unauthorizedSubstantiveContentMismatches = 0;
        let categoryMismatches = 0;
        const authorizedRewriteIds = new Set();
        for (const [id, v1] of v1ById) {
            const v2 = v2ById.get(id);
            if (!v2)
                continue;
            if (hash(v1.text) !== hash(v2.text)) {
                if (hash(v1.text.trim()) === hash(v2.text))
                    contentNormalizationOnlyRows += 1;
                else {
                    substantiveContentMismatches += 1;
                    if (governanceRewriteAuthorized(v1, v2)) {
                        governanceAuthorizedContentRewrites += 1;
                        authorizedRewriteIds.add(id);
                    }
                    else {
                        unauthorizedSubstantiveContentMismatches += 1;
                    }
                }
            }
            if (v1.category !== v2.category)
                categoryMismatches += 1;
        }
        const governanceArchivedV2Rows = rows.v2.filter((row) => row.lifecycle === "archived"
            && !v1Inactive(v1ById.get(row.id)?.metadata)).length;
        const policyComparableIds = new Set(rows.v2.filter((row) => {
            const v1 = v1ById.get(row.id);
            return Boolean(v1 && !v1Inactive(v1.metadata) && row.lifecycle !== "archived"
                && !authorizedRewriteIds.has(row.id));
        }).map((row) => row.id));
        const queryResults = input.queries.map((query) => {
            const limit = Math.min(20, Math.max(1, Math.floor(query.limit ?? 10)));
            if (!query.queryText.trim())
                throw new Error("recall parity query cannot be blank");
            const v1Native = nativeV1(db, query, limit);
            const v2Native = nativeV2(db, query, limit);
            const allowedV1 = rows.v1.filter((row) => query.legacyScopes.includes(row.scope || "") && !v1Inactive(row.metadata));
            const allowedLegacyIds = new Set(allowedV1.map((row) => row.id));
            const visibleV2 = rows.v2.filter((row) => allowedLegacyIds.has(row.id) && row.lifecycle !== "archived");
            const comparableV1 = allowedV1.filter((row) => policyComparableIds.has(row.id));
            const comparableV2 = visibleV2.filter((row) => policyComparableIds.has(row.id));
            const v1Common = commonRank(query.queryText, comparableV1, limit);
            const v2Common = commonRank(query.queryText, comparableV2, limit);
            const v1PolicyLane = commonRank(query.queryText, allowedV1, limit);
            const v2PolicyLane = commonRank(query.queryText, visibleV2, limit);
            const v2Policy = v2PolicyLane.filter((row) => policyEligible(row, query.actor));
            const v2Injectable = v2PolicyLane.filter((row) => injectable(row, query.actor));
            const v1OutsidePolicy = v1PolicyLane.filter((row) => {
                const mapped = v2ById.get(row.id);
                return mapped ? !policyEligible(mapped, query.actor) : true;
            });
            return {
                querySha256: hash(query.queryText.trim()),
                scopeSetSha256: hash(JSON.stringify([...query.legacyScopes].sort())),
                limit,
                v1Discovered: v1Native.length,
                v2Discovered: v2Native.length,
                nativeTopKOverlap: overlap(v1Native, v2Native),
                commonLaneTopKOverlap: overlap(v1Common, v2Common),
                commonLaneRankAgreement: rankAgreement(v1Common, v2Common),
                v1WouldExposeOutsideV2Policy: v1OutsidePolicy.length,
                v2PolicyEligible: v2Policy.length,
                v2Injectable: v2Injectable.length,
                v2ForbiddenScopeLeakage: v2Policy.filter((row) => !policyEligible(row, query.actor)).length,
                v1TopIdDigests: v1Native.map((row) => hash(row.id)),
                v2TopIdDigests: v2Native.map((row) => hash(row.id)),
            };
        });
        const corpus = {
            v1Rows: rows.v1.length,
            v2Rows: rows.v2.length,
            missingV2Rows: [...v1ById.keys()].filter((id) => !v2ById.has(id)).length,
            duplicateLegacyMappings,
            contentNormalizationOnlyRows,
            substantiveContentMismatches,
            governanceAuthorizedContentRewrites,
            unauthorizedSubstantiveContentMismatches,
            governanceArchivedV2Rows,
            policyComparableRows: policyComparableIds.size,
            categoryMismatches,
            v1FtsRows: scalar(db, "SELECT COUNT(*) FROM memory_truth_fts"),
            v2FtsRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_v2"),
            vectorFallbackRows: scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE state='fallback_verified'"),
            invalidVectorFallbackRows: scalar(db, `SELECT COUNT(*) FROM memory_vector_projection_v2 v
        LEFT JOIN memory_items i ON i.item_id=v.item_id
        WHERE i.item_id IS NULL OR v.legacy_id!=substr(v.item_id,8) OR v.backend!='v1-lancedb-fallback'`),
            active: rows.v2.filter((row) => row.lifecycle === "active").length,
            candidate: rows.v2.filter((row) => row.lifecycle === "candidate").length,
            archived: rows.v2.filter((row) => row.lifecycle === "archived").length,
        };
        const after = logicalDigest(db);
        if (before !== after)
            throw new Error("read-only recall parity source changed during snapshot");
        const minimum = (field) => Math.min(...queryResults.map((row) => row[field]));
        const aggregate = {
            queryCount: queryResults.length,
            minimumNativeTopKOverlap: minimum("nativeTopKOverlap"),
            minimumCommonLaneTopKOverlap: minimum("commonLaneTopKOverlap"),
            minimumCommonLaneRankAgreement: minimum("commonLaneRankAgreement"),
            v2ForbiddenScopeLeakage: queryResults.reduce((sum, row) => sum + row.v2ForbiddenScopeLeakage, 0),
            v2InjectableResults: queryResults.reduce((sum, row) => sum + row.v2Injectable, 0),
        };
        const structural = corpus.v1Rows === corpus.v2Rows
            && corpus.missingV2Rows === 0
            && corpus.duplicateLegacyMappings === 0
            && corpus.unauthorizedSubstantiveContentMismatches === 0
            && corpus.categoryMismatches === 0
            && corpus.v1FtsRows === corpus.v1Rows
            && corpus.v2FtsRows === corpus.v2Rows
            && corpus.vectorFallbackRows === corpus.v2Rows
            && corpus.invalidVectorFallbackRows === 0;
        const shadowReadReady = structural
            && aggregate.minimumCommonLaneTopKOverlap === 1
            && aggregate.minimumCommonLaneRankAgreement === 1
            && aggregate.v2ForbiddenScopeLeakage === 0;
        const shadowBlockers = shadowReadReady ? [] : ["shadow_read_parity_failed"];
        const cutoverBlockers = [...shadowBlockers];
        if (corpus.active === 0)
            cutoverBlockers.push("no_active_v2_memory");
        if (aggregate.v2InjectableResults === 0)
            cutoverBlockers.push("no_injectable_v2_recall_evidence");
        if (aggregate.minimumNativeTopKOverlap < 0.8
            && corpus.governanceAuthorizedContentRewrites === 0
            && corpus.governanceArchivedV2Rows === 0) {
            cutoverBlockers.push("native_ranking_overlap_below_0_8");
        }
        const cutoverReady = shadowReadReady && cutoverBlockers.length === 0;
        const report = {
            schemaVersion: 1,
            phase: "clawlore-v1-v2-recall-parity",
            readOnly: true,
            emitsMemoryContent: false,
            sourceUnchanged: true,
            corpus,
            queries: queryResults,
            aggregate,
            decision: {
                shadowReadReady,
                cutoverReady,
                authorizesRuntimeChange: false,
                authorizesContextEngine: false,
                authorizesFinalRecallCutover: false,
                shadowBlockers,
                cutoverBlockers,
            },
        };
        db.exec("ROLLBACK");
        return report;
    }
    finally {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* transaction may already be closed */ }
        db.close();
    }
}
