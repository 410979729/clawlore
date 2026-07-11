export class OpenClawSubagentExperienceAdapterV2 {
    service;
    constructor(service) {
        this.service = service;
    }
    prepareSubagentSpawn(input) {
        return this.service.prepareSpawn(input);
    }
    onSubagentEnded(input) {
        return this.service.onSubagentEnded(input);
    }
}
