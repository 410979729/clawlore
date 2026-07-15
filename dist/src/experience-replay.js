/**
 * Experience Kernel - Replay Testing
 *
 * Ported from Hermes scope-recall experience_replay.py
 * Validates playbooks against test cases to ensure they work correctly.
 */
import { getPlaybook } from "./experience-store.js";
// ============================================================================
// Helper Functions
// ============================================================================
function cleanTerm(term) {
    return term.trim().toLowerCase().split(/\s+/).join(" ");
}
function containsTerm(text, term) {
    const normalizedText = text.toLowerCase();
    const normalizedTerm = cleanTerm(term);
    if (!normalizedTerm)
        return false;
    return normalizedText.includes(normalizedTerm);
}
function coverageHits(text, requiredTerms) {
    const normalizedTerms = requiredTerms.map(cleanTerm);
    return normalizedTerms.filter((term) => containsTerm(text, term));
}
function coverageRatio(hits, requiredTerms) {
    const terms = requiredTerms.map(cleanTerm).filter((t) => t.length > 0);
    if (terms.length === 0)
        return 1.0;
    const uniqueHits = new Set(hits);
    return Math.round((uniqueHits.size / terms.length) * 10000) / 10000;
}
function playbookText(playbook) {
    const parts = [];
    if (playbook.trigger)
        parts.push(String(playbook.trigger));
    if (playbook.goal)
        parts.push(String(playbook.goal));
    const steps = playbook.steps;
    if (steps) {
        for (const step of steps) {
            if (step.action)
                parts.push(step.action);
            if (step.why)
                parts.push(step.why);
            if (step.evidence_required)
                parts.push(step.evidence_required);
        }
    }
    const pitfalls = playbook.pitfalls;
    if (pitfalls) {
        for (const pitfall of pitfalls) {
            if (pitfall.signal)
                parts.push(pitfall.signal);
            if (pitfall.mistake)
                parts.push(pitfall.mistake);
            if (pitfall.correction)
                parts.push(pitfall.correction);
        }
    }
    const verification = playbook.verification;
    if (verification) {
        parts.push(...verification);
    }
    return parts.join(" ");
}
// ============================================================================
// Replay Case Loading
// ============================================================================
export function loadReplayCases(cases) {
    const validated = [];
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        if (!c.id && !c.name) {
            throw new Error(`Replay case at index ${i} missing id or name`);
        }
        if (!c.required_terms || !Array.isArray(c.required_terms) || c.required_terms.length === 0) {
            throw new Error(`Replay case ${c.id || c.name} has no required_terms`);
        }
        validated.push({
            id: c.id || `case-${i + 1}`,
            name: c.name || c.id,
            description: c.description,
            required_terms: c.required_terms,
            expected_steps: c.expected_steps,
            expected_pitfalls: c.expected_pitfalls,
            negative_terms: c.negative_terms,
        });
    }
    return validated;
}
// ============================================================================
// Replay Execution
// ============================================================================
export function runReplayCase(db, playbookId, replayCase, scopeIds) {
    const playbook = getPlaybook(db, playbookId, scopeIds);
    if (!playbook) {
        return {
            case_id: replayCase.id,
            case_name: replayCase.name,
            playbook_id: playbookId,
            passed: false,
            coverage_ratio: 0,
            hits: [],
            misses: replayCase.required_terms.map(cleanTerm),
            negative_hits: [],
            details: `Playbook ${playbookId} not found`,
        };
    }
    const text = playbookText(playbook);
    // Check coverage
    const hits = coverageHits(text, replayCase.required_terms);
    const misses = replayCase.required_terms
        .map(cleanTerm)
        .filter((term) => !hits.includes(term));
    const ratio = coverageRatio(hits, replayCase.required_terms);
    // Check negative terms (should NOT be present)
    const negativeHits = [];
    if (replayCase.negative_terms) {
        for (const neg of replayCase.negative_terms) {
            if (containsTerm(text, neg)) {
                negativeHits.push(cleanTerm(neg));
            }
        }
    }
    // Check step coverage
    let stepCoverage;
    if (replayCase.expected_steps) {
        const steps = playbook.steps || [];
        const coveredSteps = replayCase.expected_steps.filter((n) => n <= steps.length);
        stepCoverage = coveredSteps.length / replayCase.expected_steps.length;
    }
    // Determine pass/fail
    const passed = ratio >= 0.8 && negativeHits.length === 0;
    const details = passed
        ? `✅ Passed: ${Math.round(ratio * 100)}% coverage, no negative hits`
        : `❌ Failed: ${Math.round(ratio * 100)}% coverage, ${negativeHits.length} negative hits`;
    return {
        case_id: replayCase.id,
        case_name: replayCase.name,
        playbook_id: playbookId,
        passed,
        coverage_ratio: ratio,
        hits,
        misses,
        negative_hits: negativeHits,
        step_coverage: stepCoverage,
        details,
    };
}
export function runReplaySuite(db, playbookId, cases, scopeIds) {
    const results = [];
    let passed = 0;
    let failed = 0;
    for (const c of cases) {
        const result = runReplayCase(db, playbookId, c, scopeIds);
        results.push(result);
        if (result.passed) {
            passed++;
        }
        else {
            failed++;
        }
    }
    return {
        results,
        passed,
        failed,
        total: cases.length,
    };
}
