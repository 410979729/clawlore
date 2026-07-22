import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, extractTaskExperienceTranscript, finalAssistantClaimsVerifiedSuccess, finalAssistantLooksUnsuccessful, shouldAttemptTaskExperienceCapture, } from "../../task-experience.js";
const require = createRequire(import.meta.url);
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_CORRELATION_DELAY_SECONDS = 60 * 60;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function normalizedRole(message) {
    return String(message.role ?? message.type ?? "").trim().toLowerCase().replace(/[ _-]+/g, "");
}
function timestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value > 10_000_000_000 ? value : value * 1000;
    if (typeof value !== "string")
        return Number.NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}
function transcriptFiles(directories) {
    const files = [];
    for (const directory of directories.map((path) => resolve(path))) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile())
                continue;
            const name = entry.name;
            if (!name.includes(".jsonl") || name.includes(".trajectory") || name.includes("codex-app-server"))
                continue;
            const path = join(directory, name);
            const info = statSync(path);
            if (info.size <= 0 || info.size > MAX_TRANSCRIPT_BYTES)
                continue;
            files.push(path);
        }
    }
    return [...new Set(files)].sort();
}
function readTranscript(path) {
    const bytes = readFileSync(path);
    const content = path.includes(".jsonl.gz") ? gunzipSync(bytes) : bytes;
    if (content.length > MAX_TRANSCRIPT_BYTES)
        throw new Error("transcript exceeds the bounded replay size");
    return content.toString("utf8");
}
function hasAssistantText(message) {
    const content = message.content;
    if (typeof content === "string")
        return Boolean(content.trim());
    if (!Array.isArray(content))
        return false;
    return content.some((block) => {
        if (typeof block === "string")
            return Boolean(block.trim());
        if (!block || typeof block !== "object")
            return false;
        const record = block;
        const type = String(record.type ?? "").toLowerCase();
        return (type === "text" || type === "output_text") && typeof record.text === "string" && Boolean(record.text.trim());
    });
}
function assistantMayEndTurn(message) {
    if (normalizedRole(message) !== "assistant" || !hasAssistantText(message))
        return false;
    const stop = String(message.stopReason ?? message.stop_reason ?? "").toLowerCase().replace(/[ _-]+/g, "");
    return !["tooluse", "toolcall", "toolcalls", "functioncall"].includes(stop);
}
function turnsFromTranscript(path) {
    const result = [];
    const records = [];
    for (const line of readTranscript(path).split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue;
        }
        records.push(record);
    }
    const byId = new Map(records.filter((record) => record.id).map((record) => [record.id, record]));
    for (const end of records) {
        if (!end.message || !assistantMayEndTurn(end.message))
            continue;
        const endAtMs = timestampMs(end.timestamp ?? end.message.timestamp);
        if (!Number.isFinite(endAtMs))
            continue;
        const ancestry = [];
        const seen = new Set();
        let cursor = end;
        let foundUser = false;
        for (let depth = 0; cursor && depth < 200; depth++) {
            const cursorKey = cursor.id ?? `${depth}:${String(cursor.timestamp ?? "")}`;
            if (seen.has(cursorKey))
                break;
            seen.add(cursorKey);
            if (cursor.message && typeof cursor.message === "object") {
                ancestry.push({ record: cursor, message: cursor.message });
                if (normalizedRole(cursor.message) === "user") {
                    foundUser = true;
                    break;
                }
            }
            cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        if (!foundUser)
            continue;
        ancestry.reverse();
        const messages = ancestry.map(({ message }) => message);
        const userMessages = ancestry.filter(({ message }) => normalizedRole(message) === "user").map(({ message }) => message);
        const recordKeys = ancestry.map(({ record, message }) => ({
            id: record.id ?? "",
            timestamp: record.timestamp ?? message.timestamp ?? "",
            role: normalizedRole(message),
        }));
        result.push({
            endAtMs,
            messages,
            surfaceBlob: JSON.stringify(userMessages),
            fileName: basename(path),
            turnDigest: hash(JSON.stringify(recordKeys)),
        });
    }
    return result;
}
function surfaceMatches(sessionKey, turn) {
    const numericTokens = sessionKey.match(/-?\d{7,}/g) ?? [];
    if (numericTokens.length > 0)
        return numericTokens.every((token) => turn.surfaceBlob.includes(token));
    const safeKey = sessionKey.replace(/[^A-Za-z0-9_-]+/g, "_");
    return turn.fileName.startsWith(`${safeKey}.`);
}
function increment(target, key) {
    target[key] = (target[key] ?? 0) + 1;
}
function reportCore(value) {
    return {
        source: value.source,
        correlation: value.correlation,
        historical: value.historical,
        candidateGate: value.candidateGate,
        safety: value.safety,
        rows: value.rows,
    };
}
export function replayHistoricalTaskExperienceCaptureV1(input) {
    if (!input.transcriptDirectories.length)
        throw new Error("at least one transcript directory is required");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    let events;
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        events = db.prepare(`SELECT id,session_id,reason,created_at,metadata FROM task_experience_capture_events
      ORDER BY created_at,id`).all();
        const episodeGoals = new Map(db.prepare("SELECT id,task_goal FROM task_episodes").all().map((row) => [row.id, row.task_goal]));
        for (const event of events) {
            let metadata = {};
            try {
                metadata = JSON.parse(event.metadata || "{}");
            }
            catch { /* invalid legacy metadata */ }
            const episodeId = typeof metadata.episode_id === "string" ? metadata.episode_id : "";
            const episodeGoal = episodeGoals.get(episodeId);
            if (episodeGoal)
                event.episodeGoal = episodeGoal;
        }
    }
    finally {
        db.close();
    }
    const files = transcriptFiles(input.transcriptDirectories);
    const allTurns = [];
    let rejectedFiles = 0;
    const seenTurns = new Set();
    for (const file of files) {
        try {
            for (const turn of turnsFromTranscript(file)) {
                if (seenTurns.has(turn.turnDigest))
                    continue;
                seenTurns.add(turn.turnDigest);
                allTurns.push(turn);
            }
        }
        catch {
            rejectedFiles++;
        }
    }
    allTurns.sort((left, right) => left.endAtMs - right.endAtMs || left.turnDigest.localeCompare(right.turnDigest));
    const usedTurns = new Set();
    const transcriptCache = new Map();
    const transcriptFor = (turn) => {
        const cached = transcriptCache.get(turn.turnDigest);
        if (cached)
            return cached;
        const transcript = extractTaskExperienceTranscript(turn.messages, DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxInputChars);
        transcriptCache.set(turn.turnDigest, transcript);
        return transcript;
    };
    const rows = [];
    const historicalReasons = {};
    const newReasons = {};
    let unmatchedRows = 0;
    for (const event of events) {
        increment(historicalReasons, event.reason || "none");
        const eventAtMs = timestampMs(event.created_at);
        const temporal = allTurns
            .filter((turn) => !usedTurns.has(turn.turnDigest))
            .map((turn) => ({ turn, delta: (eventAtMs - turn.endAtMs) / 1000 }))
            .filter(({ delta }) => delta >= -5 && delta <= MAX_CORRELATION_DELAY_SECONDS)
            .sort((left, right) => Math.abs(left.delta) - Math.abs(right.delta) || right.turn.endAtMs - left.turn.endAtMs);
        const goalMatches = event.episodeGoal
            ? temporal.filter(({ turn }) => transcriptFor(turn).userGoal === event.episodeGoal)
            : [];
        const surfaceCandidates = temporal.filter(({ turn }) => surfaceMatches(event.session_id, turn));
        let candidate;
        let correlationMethod;
        if (goalMatches.length > 0) {
            candidate = goalMatches[0];
            correlationMethod = "episode_goal";
        }
        else if (surfaceCandidates.length > 0) {
            candidate = surfaceCandidates[0];
            correlationMethod = "surface";
        }
        else if (temporal[0] && Math.abs(temporal[0].delta) <= 30
            && (!temporal[1] || Math.abs(temporal[1].delta) - Math.abs(temporal[0].delta) >= 2)) {
            candidate = temporal[0];
            correlationMethod = "time_unique";
        }
        if (!candidate) {
            unmatchedRows++;
            continue;
        }
        usedTurns.add(candidate.turn.turnDigest);
        const transcript = transcriptFor(candidate.turn);
        const gate = shouldAttemptTaskExperienceCapture(transcript, {
            ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
            enabled: true,
        }, { success: true });
        const newGate = gate.ok ? "reviewer" : "skipped";
        const newReason = gate.ok ? "reviewer_required" : gate.reason;
        increment(newReasons, newReason);
        rows.push({
            eventRef: `event_${hash(event.id).slice(0, 20)}`,
            sessionRef: `session_${hash(event.session_id).slice(0, 20)}`,
            transcriptDigest: hash(transcript.text),
            correlationMethod: correlationMethod,
            historicalReason: event.reason,
            newGate,
            newReason,
            correlationDelaySeconds: Math.max(0, Math.round(candidate.delta * 1000) / 1000),
            messageCount: transcript.messageCount,
            toolLikeCount: transcript.toolLikeCount,
            structuredToolResultCount: transcript.structuredToolResultCount,
            successfulToolResultCount: transcript.successfulToolResultCount,
            failedToolResultCount: transcript.failedToolResultCount,
            lastStructuredToolOutcome: transcript.lastStructuredToolOutcome,
            resolvedFailureToolCount: transcript.resolvedFailureToolCount,
            unresolvedFailureToolCount: transcript.unresolvedFailureToolCount,
            finalClaimsVerifiedSuccess: finalAssistantClaimsVerifiedSuccess(transcript.finalAssistantText),
            finalLooksUnsuccessful: finalAssistantLooksUnsuccessful(transcript.finalAssistantText),
        });
    }
    const matchedRows = rows.length;
    const admitted = rows.filter((row) => row.newGate === "reviewer");
    const structuredFailureRowsAdmitted = admitted.filter((row) => row.unresolvedFailureToolCount > 0).length;
    const unsuccessfulFinalRowsAdmitted = admitted.filter((row) => row.finalLooksUnsuccessful).length;
    if (structuredFailureRowsAdmitted !== 0 || unsuccessfulFinalRowsAdmitted !== 0) {
        throw new Error("task-experience shadow replay violated the fail-closed success boundary");
    }
    const correlation = {
        matchedRows,
        unmatchedRows,
        matchRate: events.length > 0 ? Math.round((matchedRows / events.length) * 10_000) / 10_000 : 0,
        within5Seconds: rows.filter((row) => row.correlationDelaySeconds <= 5).length,
        within30Seconds: rows.filter((row) => row.correlationDelaySeconds <= 30).length,
        within5Minutes: rows.filter((row) => row.correlationDelaySeconds <= 300).length,
        within1Hour: rows.filter((row) => row.correlationDelaySeconds <= 3600).length,
        episodeGoalMatches: rows.filter((row) => row.correlationMethod === "episode_goal").length,
        surfaceMatches: rows.filter((row) => row.correlationMethod === "surface").length,
        uniqueTimeMatches: rows.filter((row) => row.correlationMethod === "time_unique").length,
    };
    const partial = {
        source: {
            captureEventRows: events.length,
            uniqueSessionKeys: new Set(events.map((event) => event.session_id)).size,
            transcriptFilesScanned: files.length,
            transcriptFilesRejected: rejectedFiles,
            transcriptTurns: allTurns.length,
        },
        correlation,
        historical: { reasonCounts: historicalReasons },
        candidateGate: {
            admittedToReviewerRows: admitted.length,
            skippedRows: rows.length - admitted.length,
            reasonCounts: newReasons,
            historicalFinalFailureReclassifiedToReviewer: admitted.filter((row) => row.historicalReason === "final_answer_not_successful").length,
            historicalReviewerRejectStillReachesReviewer: admitted.filter((row) => row.historicalReason === "review_invalid_or_low_confidence").length,
            historicalReviewerRejectBlockedBeforeReviewer: rows.filter((row) => row.historicalReason === "review_invalid_or_low_confidence" && row.newGate === "skipped").length,
            admittedWithResolvedFailureRows: admitted.filter((row) => row.resolvedFailureToolCount > 0).length,
            admittedWithoutExplicitFinalVerificationRows: admitted.filter((row) => !row.finalClaimsVerifiedSuccess).length,
        },
        safety: {
            unresolvedStructuredFailureRowsAdmittedToReviewer: 0,
            unsuccessfulFinalRowsAdmittedToReviewer: 0,
            automaticMemoryWrites: 0,
            automaticPlaybookPromotions: 0,
        },
        rows,
    };
    const status = correlation.matchRate >= 0.75 ? "pass" : "insufficient_correlation";
    return {
        schemaVersion: 1,
        phase: "clawlore-task-experience-historical-shadow-replay",
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        status,
        readOnly: true,
        queryOnly: true,
        emitsTranscriptContent: false,
        emitsRawIdentifiers: false,
        emitsContentDigests: true,
        invokesReviewer: false,
        writesEpisodes: false,
        writesMemories: false,
        promotesPlaybooks: false,
        ...partial,
        reportDigest: hash(JSON.stringify(reportCore(partial))),
    };
}
