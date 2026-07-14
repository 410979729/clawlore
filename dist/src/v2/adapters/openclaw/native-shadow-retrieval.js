import { createRequire } from "node:module";
import { decideMemoryAccess } from "../../application/policy-decision.js";
const require = createRequire(import.meta.url);
const WORD_RE = /[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
const BOUNDARY_SQL = `i.tenant_id=? AND i.agent_id=? AND (
  (i.visibility='private' AND i.principal_id=?) OR
  (i.visibility='conversation' AND i.conversation_id=? AND (i.thread_id IS NULL OR i.thread_id=?)) OR
  (i.visibility='project' AND i.project_id=?)
)`;
function abortError() {
    const error = new Error("ClawLore shadow retrieval aborted");
    error.name = "AbortError";
    return error;
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
function ftsQuery(value) {
    const seen = new Set();
    const tokens = [];
    for (const match of value.toLowerCase().matchAll(WORD_RE)) {
        if (seen.has(match[0]))
            continue;
        seen.add(match[0]);
        tokens.push(match[0]);
        if (tokens.length >= 12)
            break;
    }
    return tokens.map((token) => `"${token.replace(/"/g, " ")}"`).join(" OR ");
}
function actorAddress(request) {
    return {
        schemaVersion: 2,
        ...request.boundary,
        retention: "working",
    };
}
function boundaryArgs(request) {
    const boundary = request.boundary;
    return [
        boundary.tenantId,
        boundary.agentId,
        boundary.principalId,
        boundary.conversationId ?? null,
        boundary.threadId ?? null,
        boundary.projectId ?? null,
    ];
}
function sectionFor(category) {
    switch (category.trim().toLowerCase()) {
        case "profile":
        case "preference":
        case "preferences":
        case "entity":
        case "entities":
            return "profile";
        case "decision":
        case "decisions":
        case "event":
        case "events":
            return "activeDecisions";
        case "task":
        case "tasks":
        case "commitment":
        case "commitments":
            return "taskContext";
        case "playbook":
        case "playbooks":
            return "playbooks";
        default:
            return "projectFacts";
    }
}
function candidate(row, score, now) {
    let address;
    try {
        address = JSON.parse(String(row.address_json));
    }
    catch {
        return undefined;
    }
    const validUntil = row.valid_until ? Date.parse(String(row.valid_until)) : Number.NaN;
    const stale = Number.isFinite(validUntil) && validUntil <= now;
    return {
        id: String(row.item_id),
        section: sectionFor(String(row.category)),
        text: String(row.content),
        targetAddress: address,
        lifecycle: row.lifecycle,
        verification: row.verification,
        freshness: stale ? "stale" : "current",
        ...(stale ? { freshnessReason: "validity_window_expired" } : {}),
        citation: {
            sourceType: "clawlore_v2",
            observedAt: String(row.updated_at),
        },
        score,
        confidence: row.verification === "unverified" ? 0.4 : 0.9,
    };
}
export function createNativeShadowCandidateRetrieverV1(dependencies) {
    const limit = Math.max(1, Math.min(20, Math.floor(dependencies.candidateLimit)));
    return async (request) => {
        const query = request.queryText.trim();
        if (!query)
            return [];
        throwIfAborted(request.signal);
        const vectorPromise = dependencies.retrieveVectorCandidates
            ? dependencies.retrieveVectorCandidates({ request, limit: limit * 3, signal: request.signal })
            : Promise.resolve([]);
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(dependencies.sqlitePath, { readOnly: true });
        let lexicalRows = [];
        try {
            db.exec("PRAGMA query_only=ON");
            const match = ftsQuery(query);
            if (match) {
                lexicalRows = db.prepare(`SELECT i.item_id,i.content,i.category,i.address_json,
            i.lifecycle,i.verification,i.valid_until,i.updated_at
          FROM memory_fts_v2 f JOIN memory_items i ON i.item_id=f.item_id
          WHERE memory_fts_v2 MATCH ? AND ${BOUNDARY_SQL}
          ORDER BY bm25(memory_fts_v2),i.updated_at DESC,i.item_id LIMIT ?`)
                    .all(match, ...boundaryArgs(request), limit * 3);
            }
        }
        finally {
            db.close();
        }
        const vectorHits = await vectorPromise;
        throwIfAborted(request.signal);
        const legacyIds = [...new Set(vectorHits.map((hit) => hit.legacyId).filter(Boolean))];
        let vectorRows = [];
        if (legacyIds.length > 0) {
            const vectorDb = new DatabaseSync(dependencies.sqlitePath, { readOnly: true });
            try {
                vectorDb.exec("PRAGMA query_only=ON");
                const placeholders = legacyIds.map(() => "?").join(",");
                vectorRows = vectorDb.prepare(`SELECT i.item_id,i.content,i.category,i.address_json,
            i.lifecycle,i.verification,i.valid_until,i.updated_at,v.legacy_id
          FROM memory_vector_projection_v2 v JOIN memory_items i ON i.item_id=v.item_id
          WHERE v.state='fallback_verified' AND v.legacy_id IN (${placeholders}) AND ${BOUNDARY_SQL}`)
                    .all(...legacyIds, ...boundaryArgs(request));
            }
            finally {
                vectorDb.close();
            }
        }
        throwIfAborted(request.signal);
        const rank = new Map();
        lexicalRows.forEach((row, index) => {
            rank.set(String(row.item_id), { row, score: 1 / (60 + index + 1) });
        });
        const vectorRank = new Map(vectorHits.map((hit, index) => [hit.legacyId, { index, score: hit.score }]));
        for (const row of vectorRows) {
            const hit = vectorRank.get(String(row.legacy_id));
            if (!hit)
                continue;
            const score = 1 / (60 + hit.index + 1) + Math.max(0, Math.min(1, hit.score ?? 0)) / 100;
            const existing = rank.get(String(row.item_id));
            rank.set(String(row.item_id), { row, score: score + (existing?.score ?? 0) });
        }
        const maximum = Math.max(...[...rank.values()].map((entry) => entry.score), 1);
        const actor = actorAddress(request);
        const now = Date.now();
        return [...rank.values()]
            .sort((left, right) => right.score - left.score || String(left.row.item_id).localeCompare(String(right.row.item_id)))
            .map((entry) => candidate(entry.row, entry.score / maximum, now))
            .filter((entry) => Boolean(entry))
            .filter((entry) => {
            const policy = decideMemoryAccess({
                actor,
                target: entry.targetAddress,
                operation: "recall",
                mode: "automatic",
            });
            return policy.allowed && policy.injectable;
        })
            .slice(0, limit);
    };
}
