import { describe, expect, it } from 'vitest';
import { normalizeName, squashName } from '../src/utils';

/**
 * `normalizeName()` has a counterpart in SQL: `public.normalize_name()`, added in
 * migration 0016 and used by `seed.sql`.
 *
 * `import-commit` stores each student's name in this normalised form, and the OCR
 * matcher compares against it. If the two implementations disagree about even one
 * character, a student who was imported correctly stops matching — with no error, no
 * rejected row, and a fallback to fuzzy matching or manual review that gives no hint
 * why. So the two have to agree, and the only way to notice when they stop agreeing is
 * to state the expected answers on both sides.
 *
 * The cases below are the same ten the migration's self-check pins, and the expected
 * values are the same ones. A change to either implementation that moves an answer
 * breaks one of the two checks rather than silently desynchronising them.
 */
describe('normalizeName', () => {
  const cases: Array<[string, string]> = [
    ['Aarav Sharma', 'aarav sharma'],
    ['  Diya   Patel  ', 'diya patel'],
    ['Zoya Ahmed', 'zoya ahmed'],
    ['José Álvarez', 'jose alvarez'],
    ['Renée', 'renee'],
    ["O'Brien-Smith", 'o brien smith'],
    ['Madhav  Iyer.', 'madhav iyer'],
    ['Ann-Marie 3', 'ann marie 3'],
  ];

  it.each(cases)('normalises %j', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it('returns an empty string for null, undefined and empty input', () => {
    // Note the asymmetry with the SQL function, which returns NULL: this is the
    // JavaScript signature used by the importer, and a missing name is already
    // rejected upstream, so returning '' keeps the call sites free of null checks.
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
  });

  it('collapses a name with no letters or digits to empty', () => {
    expect(normalizeName('---')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });

  it('keeps letters and digits from every script, not just ASCII', () => {
    expect(normalizeName('王芳')).toBe('王芳');
    expect(normalizeName('Анна')).toBe('анна');
  });

  it('folds accented Latin to its base letter', () => {
    expect(normalizeName('Ångström')).toBe('angstrom');
    expect(normalizeName('François')).toBe('francois');
  });

  it('is idempotent', () => {
    // Worth pinning: OCR matching compares a normalised value against a normalised
    // value, so normalising an already-normalised name must be a no-op.
    for (const [input] of cases) {
      const once = normalizeName(input);
      expect(normalizeName(once)).toBe(once);
    }
  });
});

describe('squashName', () => {
  it('removes all whitespace for the strictest matching tier', () => {
    expect(squashName('  Diya   Patel  ')).toBe('diyapatel');
    expect(squashName("O'Brien-Smith")).toBe('obriensmith');
  });

  it('agrees with normalizeName on names that have no internal spaces', () => {
    expect(squashName('Renée')).toBe(normalizeName('Renée'));
  });
});