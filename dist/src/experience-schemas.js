/**
 * Experience Kernel - Tool Schemas
 *
 * Defines the tool schemas for Experience Kernel operations
 */
export const PLAYBOOK_SEARCH_SCHEMA = {
    name: "playbook_search",
    description: "Search for reusable procedural playbooks by query, task class, or status. Returns matching playbooks with their steps, pitfalls, and verification methods. Use this before starting a task to find relevant experience.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query to match against playbook title, trigger, goal, and steps",
            },
            task_class: {
                type: "string",
                description: "Filter by exact task class (e.g., 'config_change', 'debugging', 'deployment')",
            },
            status: {
                type: "string",
                enum: ["candidate", "reviewed", "promoted", "needs_review", "quarantined"],
                description: "Filter by playbook status. Defaults to excluding quarantined and superseded.",
            },
            limit: {
                type: "number",
                description: "Maximum number of results to return (default: 20)",
            },
        },
    },
};
export const PLAYBOOK_INSPECT_SCHEMA = {
    name: "playbook_inspect",
    description: "Inspect a specific procedural playbook by ID. Returns the full playbook including all steps, pitfalls, verification methods, and recent run history.",
    parameters: {
        type: "object",
        properties: {
            playbook_id: {
                type: "string",
                description: "The ID of the playbook to inspect",
            },
        },
        required: ["playbook_id"],
    },
};
export const PLAYBOOK_CREATE_SCHEMA = {
    name: "playbook_create",
    description: "Create a new procedural playbook from a successful task episode. The playbook must follow the procedural_playbook.v1 schema with ordered steps, capability classes, and verification requirements. New playbooks start with status 'candidate'.",
    parameters: {
        type: "object",
        properties: {
            task_class: {
                type: "string",
                description: "Task classification (e.g., 'config_change', 'debugging', 'deployment', 'migration')",
            },
            title: {
                type: "string",
                description: "Short descriptive title for the playbook",
            },
            trigger: {
                type: "string",
                description: "When should this playbook be used? Describe the triggering conditions.",
            },
            goal: {
                type: "string",
                description: "What is the goal of following this playbook?",
            },
            preconditions: {
                type: "array",
                items: { type: "object" },
                description: "List of preconditions that must be true before starting (e.g., {check: 'service_running', service: 'gateway'})",
            },
            steps: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        number: { type: "number" },
                        capability_class: {
                            type: "string",
                            enum: [
                                "read_only",
                                "local_write",
                                "service_control",
                                "network_or_remote",
                                "cross_instance",
                                "credential_adjacent",
                                "destructive_or_irreversible",
                            ],
                        },
                        action: { type: "string" },
                        evidence_required: { type: "string" },
                        why: { type: "string" },
                        previous_mistakes: { type: "array", items: { type: "string" } },
                    },
                    required: ["number", "capability_class", "action", "evidence_required"],
                },
                description: "Ordered steps with capability classification and evidence requirements",
            },
            pitfalls: {
                type: "array",
                items: { type: "object" },
                description: "Known pitfalls and how to avoid them",
            },
            verification: {
                type: "array",
                items: { type: "string" },
                description: "How to verify the task was completed successfully",
            },
            cleanup: {
                type: "array",
                items: { type: "string" },
                description: "Cleanup steps to perform after task completion",
            },
            episode_id: {
                type: "string",
                description: "ID of the task episode this playbook was derived from",
            },
            scope: {
                type: "string",
                description: "Scope for this playbook (defaults to current agent scope)",
            },
        },
        required: ["task_class", "title", "trigger", "goal", "preconditions", "steps", "verification"],
    },
};
export const PLAYBOOK_FEEDBACK_SCHEMA = {
    name: "playbook_feedback",
    description: "Record feedback about a playbook after using it. Tracks success/failure to update playbook confidence and usage statistics.",
    parameters: {
        type: "object",
        properties: {
            playbook_id: {
                type: "string",
                description: "The ID of the playbook being reviewed",
            },
            outcome: {
                type: "string",
                enum: ["success", "failure", "partial"],
                description: "What was the outcome of following this playbook?",
            },
            outcome_reason: {
                type: "string",
                description: "Brief explanation of the outcome",
            },
            steps_completed: {
                type: "array",
                items: { type: "number" },
                description: "Which step numbers were completed",
            },
            evidence: {
                type: "array",
                items: { type: "string" },
                description: "Evidence collected during execution",
            },
        },
        required: ["playbook_id", "outcome"],
    },
};
export const EXPERIENCE_PREFLIGHT_SCHEMA = {
    name: "experience_preflight",
    description: "Check if there are relevant playbooks for a task before starting. Returns matching playbooks with their steps and verification methods. Use this to leverage accumulated experience.",
    parameters: {
        type: "object",
        properties: {
            task_description: {
                type: "string",
                description: "Description of the task you're about to perform",
            },
            task_class: {
                type: "string",
                description: "Optional task class filter",
            },
        },
        required: ["task_description"],
    },
};
export const EXPERIENCE_STATS_SCHEMA = {
    name: "experience_stats",
    description: "Get statistics about the Experience Kernel: episode counts, playbook counts by status, and run success rates.",
    parameters: {
        type: "object",
        properties: {
            scope: {
                type: "string",
                description: "Optional scope filter",
            },
        },
    },
};
export const EPISODE_CREATE_SCHEMA = {
    name: "episode_create",
    description: "Record the start of a task episode. Episodes track task execution for later playbook extraction. Call this at the start of a significant task.",
    parameters: {
        type: "object",
        properties: {
            task_goal: {
                type: "string",
                description: "What is the goal of this task?",
            },
            task_class: {
                type: "string",
                description: "Task classification (e.g., 'config_change', 'debugging', 'deployment')",
            },
            user_intent: {
                type: "string",
                description: "What the user asked for",
            },
        },
        required: ["task_goal"],
    },
};
export const EPISODE_COMPLETE_SCHEMA = {
    name: "episode_complete",
    description: "Mark a task episode as completed with its outcome. This enables the episode to be used for playbook extraction.",
    parameters: {
        type: "object",
        properties: {
            episode_id: {
                type: "string",
                description: "The ID of the episode to complete",
            },
            outcome: {
                type: "string",
                enum: ["success", "failure", "partial"],
                description: "The outcome of the task",
            },
            evidence: {
                type: "array",
                items: { type: "string" },
                description: "Evidence of task completion (test results, verification output, etc.)",
            },
            verification: {
                type: "array",
                items: { type: "string" },
                description: "Verification steps that were performed",
            },
            tool_names: {
                type: "array",
                items: { type: "string" },
                description: "Tools that were used during the task",
            },
        },
        required: ["episode_id", "outcome"],
    },
};
export const EXPERIENCE_PROMOTE_SCHEMA = {
    name: "experience_promote",
    description: "Automatically extract reusable playbooks from successful task episodes. Scans completed episodes, classifies risk, and creates structured playbooks. Low-risk playbooks are auto-promoted; high-risk ones are flagged for review. Use dry_run first to preview.",
    parameters: {
        type: "object",
        properties: {
            scope: {
                type: "string",
                description: "Optional scope filter to limit which episodes are scanned",
            },
            dry_run: {
                type: "boolean",
                description: "If true, only preview what would be created without actually creating anything (default: true)",
            },
            auto_promote_low_risk: {
                type: "boolean",
                description: "Auto-promote low-risk playbooks without manual review (default: true)",
            },
            max_episodes: {
                type: "number",
                description: "Maximum number of episodes to scan per run (default: 50)",
            },
        },
    },
};
export const FORGETTING_REPORT_SCHEMA = {
    name: "forgetting_report",
    description: "Identify stale or low-quality playbooks for cleanup. Finds superseded playbooks (newer version exists) and failing playbooks (high failure rate). Use dry_run first to preview.",
    parameters: {
        type: "object",
        properties: {
            scope: {
                type: "string",
                description: "Optional scope filter",
            },
            dry_run: {
                type: "boolean",
                description: "If true, only preview what would be cleaned up (default: true)",
            },
        },
    },
};
