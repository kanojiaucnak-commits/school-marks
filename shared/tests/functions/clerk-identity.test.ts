import { describe, expect, it, vi } from 'vitest';

/**
 * `_shared/auth.ts` reaches Postgres through `runPrivileged`, which is what lets it
 * read the caller's profile without a PostgREST round trip. That module imports the
 * Deno Postgres driver, which must never be resolved under Node — a test that did so
 * would open a real connection. Mocked outright, following the same reasoning as
 * `sql.test.ts`: the driver exists only to connect, and a test must not connect.
 */
vi.mock('../../../supabase/functions/_shared/postgres.ts', () => ({
  runPrivileged: vi.fn(),
}));

// A type cannot be pulled out of a dynamic import, so it is imported separately. Being
// type-only, the import is erased at build time and does not load the module.
import type { ClerkUserAccount } from '../../../supabase/functions/_shared/auth';

const { readClerkIdentity } = await import('../../../supabase/functions/_shared/auth');

import realUser from './fixtures/clerk-user.json';

/**
 * Regression tests for extracting an identity from a Clerk user object.
 *
 * ── Why these exist ────────────────────────────────────────────────────────────
 *
 * This is the third bug in this project caused by an assumed third-party response
 * shape rather than a verified one. The other two:
 *
 *   1. `getRpcArgs` selected `p.proname` (the function's *name*) where it needed
 *      `u.name` (the argument's name), breaking every named RPC.
 *   2. The embedded-resource link column was guessed by singularising the table
 *      name, so `sections` linked on `profile_id` instead of the real `teacher_id`.
 *
 * This one: Clerk keeps addresses in `email_addresses` (plural array). The
 * singular `email_address` is `null`, and `primary_email_address` is **not
 * expanded** in a plain `GET /v1/users/{id}` response — only
 * `primary_email_address_id` is present. Code reading the natural-looking field
 * therefore concluded that a user with a verified email had no email at all, and
 * refused to provision them, locking them out of the entire application.
 *
 * The fixture is a real response captured from this project's Clerk instance, so
 * the shape under test is the shape that actually arrives. It contains no
 * credentials.
 */
describe('readClerkIdentity', () => {
  describe('against a real captured Clerk response', () => {
    it('finds the email that the live instance actually reports', () => {
      const { email } = readClerkIdentity(realUser as unknown as ClerkUserAccount);

      expect(email).toBe('lgwebosutkarsh@gmail.com');
    });

    it('does not read the singular field, which is null in the real payload', () => {
      // Guards the specific trap: this is null on the wire, so any implementation
      // reading it finds nothing.
      expect((realUser as { email_address?: unknown }).email_address).toBeNull();
    });

    it('does not read an expanded primary_email_address, which is absent on the wire', () => {
      // There is no `primary_email_address` key at all in a plain user fetch.
      expect('primary_email_address' in realUser).toBe(false);
      expect((realUser as { primary_email_address_id?: unknown }).primary_email_address_id).toBe(
        'idn_3KGfYirke2Fp3xP4PfySEvNqnTe',
      );
    });

    it('survives a null `identities` collection without throwing', () => {
      // Clerk serialises an absent collection as `null`. A naive `.map` over it, or
      // over an array containing a null, throws inside authentication.
      const account = realUser as unknown as ClerkUserAccount;
      account.identities = null as unknown as ClerkUserAccount['identities'];

      expect(() => readClerkIdentity(account)).not.toThrow();
      expect(readClerkIdentity(account).email).toBe('lgwebosutkarsh@gmail.com');
    });

    it('survives a null entry inside the arrays', () => {
      const account = {
        email_addresses: [null, { id: 'idn_1', email_address: 'a@b.test' }],
        identities: [null, { email_address: 'c@d.test' }],
      } as unknown as ClerkUserAccount;

      expect(() => readClerkIdentity(account)).not.toThrow();
      expect(readClerkIdentity(account).email).toBe('a@b.test');
    });
  });

  describe('address preference order', () => {
    it('prefers the primary address over a verified secondary one', () => {
      const { email } = readClerkIdentity({
        primary_email_address_id: 'idn_second',
        email_addresses: [
          { id: 'idn_first', email_address: 'first@test', verification: { status: 'verified' } },
          { id: 'idn_second', email_address: 'second@test' },
        ],
      });

      expect(email).toBe('second@test');
    });

    it('falls back to a verified address when the primary id is unknown', () => {
      const { email } = readClerkIdentity({
        primary_email_address_id: 'idn_does_not_exist',
        email_addresses: [
          { id: 'idn_a', email_address: 'unverified@test', verification: { status: 'unverified' } },
          { id: 'idn_b', email_address: 'verified@test', verification: { status: 'verified' } },
        ],
      });

      expect(email).toBe('verified@test');
    });

    it('accepts an unverified address when it is the only one', () => {
      // Clerk verification is not what authorises a profile. The token signature is.
      const { email } = readClerkIdentity({
        email_addresses: [{ email_address: 'pending@test', verification: { status: 'unverified' } }],
      });

      expect(email).toBe('pending@test');
    });

    it('falls back to an identity when there are no email addresses', () => {
      const { email } = readClerkIdentity({
        identities: [{ email_address: 'google-only@test' }],
      });

      expect(email).toBe('google-only@test');
    });

    it('ignores whitespace-only addresses', () => {
      const { email } = readClerkIdentity({
        email_addresses: [{ email_address: '   ' }, { email_address: '  real@test  ' }],
      });

      expect(email).toBe('real@test');
    });
  });

  describe('names', () => {
    it('joins first and last name', () => {
      expect(readClerkIdentity({ first_name: 'Ada', last_name: 'Lovelace' }).fullName).toBe(
        'Ada Lovelace',
      );
    });

    it('uses a lone first name', () => {
      expect(readClerkIdentity({ first_name: 'Ada', last_name: null }).fullName).toBe('Ada');
    });

    it('falls back to the username when there is no name', () => {
      expect(readClerkIdentity({ first_name: null, last_name: null, username: 'ada' }).fullName).toBe(
        'ada',
      );
    });

    it('returns null when there is nothing to build a name from', () => {
      expect(
        readClerkIdentity({ first_name: null, last_name: null, username: null }).fullName,
      ).toBeNull();
    });

    it('does not produce a name of only whitespace', () => {
      expect(
        readClerkIdentity({ first_name: '  ', last_name: '\t', username: 'ada' }).fullName,
      ).toBe('ada');
    });
  });

  describe('accounts that genuinely have no address', () => {
    it('returns null rather than an empty string', () => {
      // The caller distinguishes "cannot create a profile" from success on this, so
      // an empty string must not be mistaken for an address.
      expect(readClerkIdentity({}).email).toBeNull();
      expect(readClerkIdentity({ email_addresses: [] }).email).toBeNull();
      expect(readClerkIdentity({ email_addresses: [{ email_address: '' }] }).email).toBeNull();
    });
  });
});