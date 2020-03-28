export default class MountPointEntry {
    constructor(readonly name: string, readonly mountPoint: string, referenceId: string) {
        this.references = [referenceId];
    }

    references: string[];
    
    hasReference(id: string): boolean {
        return !!this.references.find(refid => refid === id);
    }
}