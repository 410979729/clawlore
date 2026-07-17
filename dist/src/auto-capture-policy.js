import { evaluateCaptureSafety } from "./capture-safety.js";
const MEMORY_TRIGGERS = [
    /zapamatuj si|pamatuj|remember/i,
    /preferuji|radši|nechci|prefer/i,
    /rozhodli jsme|budeme používat/i,
    /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
    /\+\d{10,}/,
    /[\w.-]+@[\w.-]+\.\w+/,
    /můj\s+\w+\s+je|je\s+můj/i,
    /my\s+\w+\s+is|is\s+my/i,
    /i (like|prefer|hate|love|want|need|care)/i,
    /always|never|important/i,
    /記住|记住|記一下|记一下|別忘了|别忘了|備註|备注/,
    /偏好|喜好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/,
    /決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用/,
    /我的\S+是|叫我|稱呼|称呼/,
    /老是|講不聽|總是|总是|從不|从不|一直|每次都/,
    /重要|關鍵|关键|注意|千萬別|千万别/,
    /幫我|筆記|存檔|存起來|存一下|重點|原則|底線/,
];
const CAPTURE_EXCLUDE_PATTERNS = [
    /\b(scope-recall|memory-pro|memory_store|memory_recall|memory_forget|memory_update)\b/i,
    /\bopenclaw\s+(scope-recall|memory-pro)\b/i,
    /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
    /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
    /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
    /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
];
/**
 * Decide whether the compatibility regex lane should consider a text durable.
 * This is a conservative signal gate, not storage authorization: callers must
 * still enforce runtime scope, workspace boundaries, dedupe, and lifecycle.
 */
export function shouldCapture(text) {
    let normalized = text.trim();
    const metadataPattern = /^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim;
    normalized = normalized.replace(metadataPattern, "");
    const hasCjk = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(normalized);
    const minLength = hasCjk ? 4 : 10;
    if (normalized.length < minLength || normalized.length > 500)
        return false;
    if (!evaluateCaptureSafety(normalized).allowed)
        return false;
    if (normalized.includes("<relevant-memories>"))
        return false;
    if (normalized.startsWith("<") && normalized.includes("</"))
        return false;
    if (normalized.includes("**") && normalized.includes("\n-"))
        return false;
    const emojiCount = (normalized.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
    if (emojiCount > 3)
        return false;
    if (CAPTURE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(normalized)))
        return false;
    return MEMORY_TRIGGERS.some((pattern) => pattern.test(normalized));
}
/** Classify a regex-lane capture without changing its lifecycle or scope. */
export function detectCategory(text) {
    const lower = text.toLowerCase();
    if (/prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/i.test(lower)) {
        return "preference";
    }
    if (/rozhodli|decided|we decided|will use|we will use|we'?ll use|switch(ed)? to|migrate(d)? to|going forward|from now on|budeme|決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用|規則|流程|SOP/i.test(lower)) {
        return "decision";
    }
    if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|我的\S+是|叫我|稱呼|称呼/i.test(lower)) {
        return "entity";
    }
    if (/\b(is|are|has|have|je|má|jsou)\b|總是|总是|從不|从不|一直|每次都|老是/i.test(lower)) {
        return "fact";
    }
    return "other";
}
