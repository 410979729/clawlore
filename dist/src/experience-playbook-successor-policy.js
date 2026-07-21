/**
 * Validate a supersession edge and its existing chain before storage mutates
 * either the playbook row or its version history.
 */
export function validatePlaybookSuccessor(playbook, supersededBy, resolve) {
    if (!supersededBy)
        return "superseded_by_required";
    if (supersededBy === playbook.id)
        return "superseded_by_self";
    const successor = resolve(supersededBy);
    if (!successor)
        return "superseded_by_not_found";
    if (successor.scope_id !== playbook.scope_id
        || successor.shared_scope_id !== playbook.shared_scope_id) {
        return "superseded_by_scope_mismatch";
    }
    if (["superseded", "quarantined"].includes(successor.status)) {
        return "superseded_by_lifecycle_invalid";
    }
    const visited = new Set([playbook.id]);
    let cursor = successor;
    while (cursor?.superseded_by) {
        if (visited.has(cursor.superseded_by))
            return "superseded_by_cycle";
        visited.add(cursor.id);
        cursor = resolve(cursor.superseded_by);
        if (!cursor)
            return "superseded_by_chain_broken";
    }
    return null;
}
