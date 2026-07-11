export function contextPackItemCount(pack) {
    return pack.profile.length
        + pack.projectFacts.length
        + pack.activeDecisions.length
        + pack.taskContext.length
        + pack.playbooks.length;
}
