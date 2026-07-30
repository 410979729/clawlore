/**
 * Runtime features share one configured LLM transport, but their feature
 * switches remain independent. Task-experience review must not silently stop
 * merely because smart memory extraction is disabled.
 */
export function requiresBackgroundLlmRuntime(config) {
    return config.smartExtraction === true
        || config.taskExperienceCapture?.enabled === true;
}
