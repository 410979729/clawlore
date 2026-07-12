import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WORD_RE = /[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
export const LEGACY_SEARCH_FIELD_ALLOWLIST_V1 = [
    "l0_abstract",
    "l1_overview",
    "l2_content",
    "keywords",
    "entities",
    "tags",
    "category",
    "tier",
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
function stringValues(value) {
    return (Array.isArray(value) ? value : [value])
        .filter((entry) => typeof entry === "string" && Boolean(entry.trim()))
        .map((entry) => entry.trim().slice(0, 4096));
}
export function projectLegacySearchMetadataV1(metadata) {
    if (!metadata)
        return "";
    return LEGACY_SEARCH_FIELD_ALLOWLIST_V1
        .flatMap((field) => stringValues(metadata[field]))
        .join("\n");
}
function overlap(left, right) {
    if (left.length === 0 && right.length === 0)
        return 1;
    const rightIds = new Set(right);
    return left.filter((id) => rightIds.has(id)).length / Math.max(left.length, right.length, 1);
}
function rankAgreement(left, right) {
    if (left.length === 0 && right.length === 0)
        return 1;
    const rightRanks = new Map(right.map((id, index) => [id, index]));
    const shared = left.map((id, index) => ({ left: index, right: rightRanks.get(id) }))
        .filter((entry) => entry.right !== undefined);
    if (shared.length === 0)
        return 0;
    const span = Math.max(left.length, right.length, 2) - 1;
    return shared.reduce((sum, entry) => sum + (1 - Math.abs(entry.left - entry.right) / span), 0)
        / Math.max(left.length, right.length, 1);
}
function rank(db, table, queryText, limit) {
    const match = ftsQuery(queryText);
    if (!match)
        return [];
    return db.prepare(`SELECT f.row_id FROM ${table} f JOIN ranking_rows r ON r.row_id=f.row_id
    WHERE ${table} MATCH ? ORDER BY bm25(${table}),r.observed_at DESC,f.row_id LIMIT ?`)
        .all(match, limit).map((row) => row.row_id);
}
export function evaluateFixtureRankingCompatibilityV1(input) {
    if (input.rows.length === 0)
        throw new Error("ranking fixture requires at least one row");
    if (input.queries.length === 0)
        throw new Error("ranking fixture requires at least one query");
    const ids = new Set();
    for (const row of input.rows) {
        if (!row.id.trim() || ids.has(row.id))
            throw new Error("ranking fixture row ids must be unique and non-empty");
        ids.add(row.id);
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`CREATE TABLE ranking_rows(row_id TEXT PRIMARY KEY,observed_at REAL NOT NULL);
      CREATE VIRTUAL TABLE v1_fts USING fts5(row_id UNINDEXED,content,metadata_text);
      CREATE VIRTUAL TABLE current_v2_fts USING fts5(row_id UNINDEXED,content,category);
      CREATE VIRTUAL TABLE compat_v2_fts USING fts5(row_id UNINDEXED,content,metadata_text);`);
        const rowInsert = db.prepare("INSERT INTO ranking_rows VALUES (?,?)");
        const v1Insert = db.prepare("INSERT INTO v1_fts VALUES (?,?,?)");
        const currentInsert = db.prepare("INSERT INTO current_v2_fts VALUES (?,?,?)");
        const compatInsert = db.prepare("INSERT INTO compat_v2_fts VALUES (?,?,?)");
        let ignoredMetadataFieldCount = 0;
        const allowed = new Set(LEGACY_SEARCH_FIELD_ALLOWLIST_V1);
        for (const row of input.rows) {
            const metadataText = projectLegacySearchMetadataV1(row.legacyMetadata);
            ignoredMetadataFieldCount += Object.keys(row.legacyMetadata ?? {}).filter((field) => !allowed.has(field)).length;
            rowInsert.run(row.id, row.observedAt);
            v1Insert.run(row.id, row.content, metadataText);
            currentInsert.run(row.id, row.content, row.category);
            compatInsert.run(row.id, row.content, metadataText);
        }
        const queries = input.queries.map((query) => {
            if (!query.queryText.trim())
                throw new Error("ranking fixture query cannot be blank");
            const limit = Math.min(20, Math.max(1, Math.floor(query.limit ?? 10)));
            const v1 = rank(db, "v1_fts", query.queryText, limit);
            const current = rank(db, "current_v2_fts", query.queryText, limit);
            const compat = rank(db, "compat_v2_fts", query.queryText, limit);
            return {
                querySha256: hash(query.queryText.trim()),
                limit,
                v1Discovered: v1.length,
                currentV2Discovered: current.length,
                compatibilityV2Discovered: compat.length,
                currentV2TopKOverlap: overlap(v1, current),
                compatibilityV2TopKOverlap: overlap(v1, compat),
                compatibilityV2RankAgreement: rankAgreement(v1, compat),
            };
        });
        const minimum = (field) => Math.min(...queries.map((row) => row[field]));
        const aggregate = {
            minimumCurrentV2TopKOverlap: minimum("currentV2TopKOverlap"),
            minimumCompatibilityV2TopKOverlap: minimum("compatibilityV2TopKOverlap"),
            minimumCompatibilityV2RankAgreement: minimum("compatibilityV2RankAgreement"),
        };
        const blockers = [];
        if (aggregate.minimumCompatibilityV2TopKOverlap < 0.8)
            blockers.push("compatibility_overlap_below_0_8");
        if (aggregate.minimumCompatibilityV2RankAgreement < 0.8)
            blockers.push("compatibility_rank_agreement_below_0_8");
        return {
            schemaVersion: 1,
            phase: "clawlore-fixture-ranking-compatibility",
            fixtureOnly: true,
            readOnlyDesign: true,
            emitsFixtureContent: false,
            compatibilityProjection: {
                canonicalTruthChanged: false,
                sourceOfTruth: "memory_items",
                bootstrapSource: "memory_truth.metadata_text",
                requiresOneTimeBackfill: true,
                rebuildableProjection: "memory_fts_compat_v2",
                indexedLegacyMetadataFields: [...LEGACY_SEARCH_FIELD_ALLOWLIST_V1],
                rawLegacyMetadataCopied: false,
                ignoredMetadataFieldCount,
            },
            queries,
            aggregate,
            decision: {
                compatibilityDesignReady: blockers.length === 0,
                blockers,
                authorizesLiveSchemaChange: false,
                authorizesLiveReindex: false,
                authorizesFinalRecallCutover: false,
            },
        };
    }
    finally {
        db.close();
    }
}
