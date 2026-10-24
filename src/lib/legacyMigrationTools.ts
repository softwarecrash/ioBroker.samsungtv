export function shouldMigrateLegacySamsung(instance: unknown): boolean {
    return Number(instance) === 0;
}
