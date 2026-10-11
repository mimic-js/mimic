import { describe, expect, it } from 'vitest';

import {
  parseJsonEvidence,
  parseJsonEvidenceRecord,
  requireEvidenceArray,
  requireEvidenceNumber,
  requireEvidenceRecord,
  requireEvidenceString
} from '../e2e/json-evidence-decoder';

describe('JSON evidence decoder', () => {
  it('keeps parsed JSON unknown until a maintained guard narrows it', () => {
    const value = parseJsonEvidence('{"items":["ok"],"count":1}', 'claim evidence');
    const record = requireEvidenceRecord(value, 'claim evidence');

    expect(requireEvidenceArray(record.items, 'claim evidence items')).toEqual(['ok']);
    expect(requireEvidenceNumber(record.count, 'claim evidence count')).toBe(1);
    expect(
      requireEvidenceString(
        requireEvidenceArray(record.items, 'claim evidence items')[0],
        'claim evidence item'
      )
    ).toBe('ok');
  });

  it('retains the evidence description for invalid JSON and invalid shapes', () => {
    expect(() => parseJsonEvidence('{', 'optimizer metadata')).toThrow(
      'optimizer metadata must be valid JSON'
    );
    expect(() => parseJsonEvidenceRecord('[]', 'replacement provenance')).toThrow(
      'replacement provenance must be an object'
    );
    expect(() => requireEvidenceNumber(Number.POSITIVE_INFINITY, 'Catalog version')).toThrow(
      'Catalog version must be a finite number'
    );
  });
});
