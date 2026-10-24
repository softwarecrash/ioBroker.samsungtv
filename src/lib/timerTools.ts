export function boundedSeconds(value: unknown, fallback: number, minimum: number, maximum: number): number {
    // parseInt coerces its argument to a string, exactly like the former untyped call
    const parsed = Number.parseInt(value as string, 10);
    const seconds = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(maximum, Math.max(minimum, seconds));
}
