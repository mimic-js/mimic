export function parseJsonEvidence(source: string, description: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${description} must be valid JSON`, { cause: error });
  }
}

export function parseJsonEvidenceRecord(
  source: string,
  description: string
): Readonly<Record<string, unknown>> {
  return requireEvidenceRecord(parseJsonEvidence(source, description), description);
}

export function requireEvidenceRecord(
  value: unknown,
  description: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

export function requireEvidenceArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${description} must be an array`);
  return value;
}

export function requireEvidenceString(value: unknown, description: string): string {
  if (typeof value !== 'string') throw new Error(`${description} must be a string`);
  return value;
}

export function requireEvidenceNumber(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${description} must be a finite number`);
  }
  return value;
}
