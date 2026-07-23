/**
 * Compatibility facade for the historical `MemoryStore` API.
 *
 * Application and adapter code can continue to depend on this stable class,
 * while storage behavior is supplied through explicit truth, retrieval,
 * projection, and transaction ports. The optional port injection exists for
 * characterization tests and future adapter replacement; production builds
 * use the current SQL-truth/vector-companion runtime.
 */
export class MemoryStoreFacade {
    ports;
    constructor(ports) {
        this.ports = ports;
    }
    get dbPath() { return this.ports.dbPath; }
    get hasFtsSupport() { return this.ports.hasFtsSupport; }
    get lastFtsError() { return this.ports.lastFtsError; }
    reopenAfterRecovery() { return this.ports.reopenAfterRecovery(); }
    close() { return this.ports.close(); }
    store(entry) {
        return this.ports.store(entry);
    }
    importEntry(entry) {
        return this.ports.importEntry(entry);
    }
    hasId(id) { return this.ports.hasId(id); }
    getById(id, scopeFilter) {
        return this.ports.getById(id, scopeFilter);
    }
    vectorSearch(vector, limit, minScore, scopeFilter, options) {
        return this.ports.vectorSearch(vector, limit, minScore, scopeFilter, options);
    }
    bm25Search(query, limit, scopeFilter, options) {
        return this.ports.bm25Search(query, limit, scopeFilter, options);
    }
    deleteVectorCompanion(id, operation) {
        return this.ports.deleteVectorCompanion(id, operation);
    }
    getVectorEntryById(id) {
        return this.ports.getVectorEntryById(id);
    }
    delete(id, scopeFilter) {
        return this.ports.delete(id, scopeFilter);
    }
    list(scopeFilter, category, limit, offset) {
        return this.ports.list(scopeFilter, category, limit, offset);
    }
    stats(scopeFilter) {
        return this.ports.stats(scopeFilter);
    }
    update(id, updates, scopeFilter, options) {
        return this.ports.update(id, updates, scopeFilter, options);
    }
    supersede(id, replacement, scopeFilter) {
        return this.ports.supersede(id, replacement, scopeFilter);
    }
    patchMetadata(id, patch, scopeFilter) {
        return this.ports.patchMetadata(id, patch, scopeFilter);
    }
    bulkDelete(scopeFilter, beforeTimestamp) {
        return this.ports.bulkDelete(scopeFilter, beforeTimestamp);
    }
    getSqlTruthDb() { return this.ports.getSqlTruthDb(); }
    getFtsStatus() {
        return this.ports.getFtsStatus();
    }
    verifyFilePrivacy() { return this.ports.verifyFilePrivacy(); }
    getDiagnostics() { return this.ports.getDiagnostics(); }
    getVectorCompanionStatus() {
        return this.ports.getVectorCompanionStatus();
    }
    getVectorCompanionDriftReport(maxTruthRows) {
        return this.ports.getVectorCompanionDriftReport(maxTruthRows);
    }
    getVectorScopeCounts() {
        return this.ports.getVectorScopeCounts();
    }
    rebuildVectorCompanion(embedder, options) {
        return this.ports.rebuildVectorCompanion(embedder, options);
    }
    rebuildFtsIndex() {
        return this.ports.rebuildFtsIndex();
    }
    fetchForCompaction(maxTimestamp, scopeFilter, limit) {
        return this.ports.fetchForCompaction(maxTimestamp, scopeFilter, limit);
    }
}
