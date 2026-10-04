/**
 * Compile-time assertion: auto-role-on-join is not expressible.
 *
 * The rule "roles are granted only through five explicit workflows" is only
 * real if the forbidden case is IMPOSSIBLE TO WRITE. A comment saying "don't
 * add ON_JOIN" is a convention; a type union that rejects it is a guarantee.
 *
 * This runs `tsc --noEmit` over a fixture that attempts an ON_JOIN assignment
 * and asserts the compiler REJECTS it, then asserts the permitted workflows
 * compile cleanly so the union is not simply empty.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const srcRoot = projectRoot.replace(/\\/g, '/');

function typecheck(source: string, prefix: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const file = join(dir, 'fixture.ts');
    writeFileSync(file, source, 'utf8');

    try {
      const stdout = execFileSync(
        process.execPath,
        [
          join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
          // TS6 refuses files-on-commandline alongside a tsconfig (TS5112);
          // the fixture supplies its own flags instead.
          '--ignoreConfig',
          '--noEmit',
          '--strict',
          '--target', 'ES2024',
          '--module', 'NodeNext',
          '--moduleResolution', 'NodeNext',
          '--skipLibCheck',
          file,
        ],
        { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { ok: true, output: stdout };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ON_JOIN_FIXTURE = `
import { authorizeRoleAssignment, type RoleWorkflow } from '${srcRoot}/src/features/roles/workflows.js';

// The forbidden case: granting a role merely because someone joined.
const joinWorkflow: RoleWorkflow = 'ON_JOIN';

export function onMemberJoin(): void {
  authorizeRoleAssignment({
    guildId: '1',
    userId: '2',
    roleId: '3',
    workflow: joinWorkflow,
    intent: 'GRANT',
  });
}
`;

const PERMITTED_FIXTURE = `
import { authorizeRoleAssignment, type RoleWorkflow } from '${srcRoot}/src/features/roles/workflows.js';

const all: RoleWorkflow[] = [
  'VERIFICATION',
  'APPLICATION_APPROVAL',
  'ROLE_PURCHASE',
  'SELF_ASSIGN',
  'LEVEL_REWARD',
];

export function applyEveryWorkflow(): void {
  for (const workflow of all) {
    authorizeRoleAssignment({ guildId: '1', userId: '2', roleId: '3', workflow, intent: 'GRANT' });
  }
}
`;

describe('auto-role-on-join is unexpressible (compile-time)', () => {
  it('tsc rejects an ON_JOIN role workflow', () => {
    const { ok, output } = typecheck(ON_JOIN_FIXTURE, 'redoubt-join-');
    expect(
      ok,
      'tsc must reject an ON_JOIN role workflow. If this passes, auto-role-on-join ' +
        'has become expressible again.',
    ).toBe(false);
    // The error must be about the literal, proving the union rejected it.
    expect(output).toMatch(/ON_JOIN/);
  });

  it('tsc accepts all five permitted workflows', () => {
    const { ok, output } = typecheck(PERMITTED_FIXTURE, 'redoubt-roles-');
    expect(output).toBe('');
    expect(ok, 'the permitted workflows must compile').toBe(true);
  });
});
