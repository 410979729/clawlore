import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { diagnosticTextSummary } from "./diagnostic-redaction.js";
/**
 * Sanitizes capture candidates before the optional provider-backed noise lane.
 * Unsafe text is dropped even when the prototype bank is disabled so callers
 * never receive an unsanitized value from this boundary.
 */
export async function filterEmbeddingNoiseInputs(params) {
    const safeTexts = params.texts.flatMap((rawText) => {
        const text = sanitizeCaptureText(rawText);
        const safety = evaluateCaptureSafety(text);
        if (!safety.allowed) {
            params.debugLog(`clawlore: smart-extractor: embedding noise input skipped ` +
                `reason=${safety.reason} pattern=${safety.pattern ?? "unknown"}`);
            return [];
        }
        return [text];
    });
    if (!params.noiseBank?.initialized)
        return safeTexts;
    const result = [];
    for (const text of safeTexts) {
        if (text.length <= 8 || text.length > 300) {
            result.push(text);
            continue;
        }
        try {
            const vector = await params.embed(text);
            if (!vector?.length || !params.noiseBank.isNoise(vector)) {
                result.push(text);
            }
            else {
                params.debugLog(`clawlore: smart-extractor: embedding noise filtered: ${diagnosticTextSummary(text)}`);
            }
        }
        catch {
            result.push(text);
        }
    }
    return result;
}
