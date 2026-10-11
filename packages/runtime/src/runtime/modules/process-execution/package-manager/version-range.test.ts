import { expect, test } from 'vitest';

import { nearestVersion, sameMajorLine } from './version-range';

test('picks the candidate closest by major, then minor, then patch', () => {
  const published = ['0.0.1', '0.22.0', '0.23.1', '0.25.0', '0.25.12', '1.0.0'];

  expect(nearestVersion('0.19.12', published)).toBe('0.22.0');
  expect(nearestVersion('0.25.4', published)).toBe('0.25.0');
  expect(nearestVersion('0.25.9', published)).toBe('0.25.12');
  expect(nearestVersion('0.30.0', published)).toBe('0.25.12');
  expect(nearestVersion('2.1.0', published)).toBe('1.0.0');
});

test('prefers the newer of two equally distant candidates and skips prereleases', () => {
  expect(nearestVersion('2.5.3', ['2.5.2', '2.5.4'])).toBe('2.5.4');
  expect(nearestVersion('2.4.1', ['2.4.2-alpha.0', '2.4.0'])).toBe('2.4.0');
  expect(nearestVersion('2.4.1', ['2.4.2-alpha.0'])).toBeUndefined();
  expect(nearestVersion('not-a-version', ['1.0.0'])).toBeUndefined();
});

test('keeps the candidates of the same major line, without prereleases', () => {
  expect(sameMajorLine('4.62.4', ['3.29.4', '4.0.0', '4.64.0', '5.0.0-beta.1', '5.0.0'])).toEqual(['4.0.0', '4.64.0']);
  expect(sameMajorLine('3.29.4', ['4.0.0', '4.64.0'])).toEqual([]);
  expect(sameMajorLine('not-a-version', ['1.0.0'])).toEqual([]);
});
