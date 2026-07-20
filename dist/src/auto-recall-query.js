function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
export function cleanUserRecallQuery(value) {
    if (typeof value !== "string")
        return "";
    return compactWhitespace(value.replace(/^(?:@\S+\s*|<@!?\d+>\s*)+/, ""));
}
export function selectAutoRecallQuery(input) {
    const maxChars = Math.max(1, Math.trunc(input.maxChars ?? 1_000));
    const cached = cleanUserRecallQuery(input.cachedUserMessage);
    const source = cached ? "cached-user-message" : "empty";
    const rawQuery = cached;
    const originalLength = rawQuery.length;
    const truncated = originalLength > maxChars;
    return {
        query: truncated ? rawQuery.slice(0, maxChars).trimEnd() : rawQuery,
        source,
        originalLength,
        truncated,
    };
}
