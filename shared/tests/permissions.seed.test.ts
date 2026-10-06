import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION_EXEMPTIONS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} from '../src/permissions.js';
import { ROLES, type Role } from '../src/constants.js';

/**
 * Keeps the two sources of the permission model from drifting apart.
 *
 * The role/permission matrix is duplicated on purpose:
 *
 *   - `ROLE_PERMISSIONS` here — what the React app uses to decide what to render
 *   - `role_permissions` rows under supabase/migrations/ — what `has_permission()`
 *     reads, and therefore what RLS actually enforces
 *
 * RLS is authoritative, so drift is not a security hole: a user cannot gain
 * access the database refuses. It is a correctness bug in the other direction
 * that matters more in practice — the UI would offer a teacher a button that
 * then fails, or hide a button an admin is entitled to use. This test is the
 * guard against that.
 *
 * Every migration is scanned, not just the first one. 0008 added permissions with
 * a different insert shape (`cross join (values ...)` rather than
 * `unnest(array[...])`), and a test pinned to one file and one syntax would have
 * missed it entirely.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../supabase/migrations');

const ROLE_IDS: Record<Role, string> = {
  [ROLES.ADMIN]: 'role_admin',
  [ROLES.TEACHER]: 'role_teacher',
  [ROLES.REVIEWER]: 'role_reviewer',
};

function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ name: file, sql: readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8') }));
}

/**
 * Collects role -> permission[] across every migration, handling both insert
 * shapes used in this repo:
 *
 *   select 'role_teacher', p from unnest(array[ 'a', 'b' ])      -- 0003
 *   ('role_teacher', 'a'), ('role_admin', 'b')                  -- 0008
 *
 * Later migrations win, so an insert that adds a permission is layered on top of
 * the original seed rather than replacing it.
 */
function parseSeededPermissions(migrations: { name: string; sql: string }[]): Map<string, string[]> {
  const found = new Map<string, string[]>();

  const record = (roleId: string, permission: string) => {
    const existing = found.get(roleId) ?? [];
    if (!existing.includes(permission)) existing.push(permission);
    found.set(roleId, existing);
  };

  for (const { sql } of migrations) {
    for (const match of sql.matchAll(
      /select\s+'(role_\w+)',\s*p\s+from\s+unnest\(array\[([\s\S]*?)\]\)/g,
    )) {
      const roleId = match[1]!;
      for (const permission of match[2]!.matchAll(/'([^']+)'/g)) record(roleId, permission[1]!);
    }

    for (const match of sql.matchAll(/\(\s*'(role_\w+)'\s*,\s*'([a-z_]+:[a-z_]+)'\s*\)/g)) {
      record(match[1]!, match[2]!);
    }
  }

  return found;
}

describe('permission seed parity', () => {
  const migrations = readMigrations();
  const seeded = parseSeededPermissions(migrations);

  it('finds migrations to scan', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('parses all three role blocks across the migrations', () => {
    expect([...seeded.keys()].sort()).toEqual(
      Object.values(ROLE_IDS).sort(),
      'the migrations must grant permissions to role_admin, role_teacher and role_reviewer',
    );
  });

  for (const role of Object.values(ROLES)) {
    it(`${role} grants exactly the same permissions in SQL and TypeScript`, () => {
      const roleId = ROLE_IDS[role];
      const fromSql = (seeded.get(roleId) ?? []).slice().sort();
      const fromTs = ROLE_PERMISSIONS[role].slice().sort();

      expect(fromSql).toEqual(fromTs);
    });
  }

  it('gives admin every catalogue permission except the declared exemptions', () => {
    // Catches a permission added to PERMISSIONS but never seeded: admin would
    // silently lose it and lock its own administrators out of a feature.
    const expected = Object.values(PERMISSIONS)
      .filter((permission) => !ADMIN_PERMISSION_EXEMPTIONS.includes(permission))
      .sort();

    const adminSeeded = (seeded.get(ROLE_IDS[ROLES.ADMIN]) ?? []).slice().sort();

    expect(adminSeeded).toEqual(expected);
  });

  it('keeps the admin exemption list free of stale entries', () => {
    // If a permission is exempted from admin but never existed, the list has
    // drifted and the test above would still pass.
    for (const permission of ADMIN_PERMISSION_EXEMPTIONS) {
      expect(Object.values(PERMISSIONS)).toContain(permission);
    }
  });

  it('seeds only permissions that exist in the catalogue', () => {
    const known = new Set<string>(Object.values(PERMISSIONS));

    for (const [roleId, permissions] of seeded) {
      for (const permission of permissions) {
        expect(
          known.has(permission),
          `${roleId} seeds unknown permission "${permission}"`,
        ).toBe(true);
      }
    }
  });

  it('gives no non-admin role a permission admin lacks', () => {
    // "An admin can always do anything a lesser role can" is a support-friendly
    // invariant: an admin must never be the reason a user is stuck. It has one
    // declared exception. `assignment:request` is not a capability admin is
    // missing — it is a self-service action that `assignment:manage` strictly
    // supersedes, since an admin assigns people directly instead of asking.
    const adminSeeded = new Set(seeded.get(ROLE_IDS[ROLES.ADMIN]) ?? []);
    const exempt = new Set<string>(ADMIN_PERMISSION_EXEMPTIONS);

    for (const role of [ROLES.TEACHER, ROLES.REVIEWER]) {
      for (const permission of seeded.get(ROLE_IDS[role]) ?? []) {
        if (exempt.has(permission)) continue;

        expect(
          adminSeeded.has(permission),
          `${role} has "${permission}" but admin does not, and it is not a declared exemption`,
        ).toBe(true);
      }
    }
  });

  it('holds no more than one admin exemption, so the invariant stays meaningful', () => {
    // If the exemption list grows, admins quietly stop being all-powerful and the
    // test above stops catching much. Force that to be a deliberate decision.
    expect(ADMIN_PERMISSION_EXEMPTIONS.length).toBeLessThanOrEqual(1);
  });
});