/**
 * Compile-time assertion harness for the AutoMod action ceiling.
 *
 * Runs `tsc --noEmit` over a small fixture that ATTEMPTS to call Kick, Ban,
 * and Jail through AutoMod's enforcer, and asserts the compiler REJECTS each
 * attempt. This turns "AutoMod can never kick/ban/jail" into something CI can
 * fail on, rather than a property a reviewer must verify by reading.
 *
 * SCOPE, STATED HONESTLY: this proves the members do not EXIST on the
 * narrowed interface. It does not — and cannot — prevent a deliberate
 * `as unknown as {...}` cast, which is legal TypeScript that defeats any type
 * system. That indirect path is closed by the eslint `no-restricted-imports`
 * rule in eslint.config.js, which bans importing the jail/ban/kick services
 * from `features/automod/**`. The two mechanisms are complementary: the type
 * removes the direct path, the lint rule removes the indirect one.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');

/** Fixture deliberately violating the ceiling; tsc must reject it. */
const VIOLATION_FIXTURE = `
import type { AutoModEnforcer } from '${projectRoot.replace(/\\/g, '/')}/src/features/automod/enforcer.js';

declare const enforcer: AutoModEnforcer;

export async function automodRemovesAMember(): Promise<void> {
  // Direct property access on the narrowed interface. These MUST be compile
  // errors, because AutoModEnforcer has no kick/ban/jail members at all.
  await enforcer.kick();
  await enforcer.ban();
  await enforcer.jail();
}
`;

describe('AutoMod cannot reach Kick/Ban/Jail (compile-time, v16 §T.11)', () => {
  it('tsc rejects a cast that attempts to reach kick/ban/jail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redoubt-typelevel-'));
    try {
      const file = join(dir, 'violation.ts');
      writeFileSync(file, VIOLATION_FIXTURE, 'utf8');

      let output = '';
      let rejected = false;
      try {
        execFileSync(
          process.execPath,
          [
            join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
            // TS6 refuses files-on-commandline alongside a tsconfig (TS5112).
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
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; status?: number };
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        rejected = true;
      }

      expect(
        rejected,
        'tsc must reject the violation fixture. If this passes, the AutoMod ' +
          'enforcer has grown a path to Kick/Ban/Jail.',
      ).toBe(true);

      // The rejection must name the offending properties, proving the error
      // comes from the missing members rather than unrelated breakage.
      expect(output).toMatch(/kick/i);
      expect(output).toMatch(/ban/i);
      expect(output).toMatch(/jail/i);
      expect(output).toMatch(/AutoModEnforcer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tsc accepts the real enforcer surface as used by production code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redoubt-typelevel-ok-'));
    try {
      const file = join(dir, 'valid.ts');
      writeFileSync(
        file,
        `
import type { AutoModEnforcer } from '${projectRoot.replace(/\\/g, '/')}/src/features/automod/enforcer.js';
declare const enforcer: AutoModEnforcer;
export async function apply(event: Parameters<AutoModEnforcer['log']>[0]): Promise<void> {
  await enforcer.log(event);
  await enforcer.delete(event);
  await enforcer.warn(event);
  await enforcer.mute(event, 600);
}
`,
        'utf8',
      );

      // Must NOT throw: the permitted surface is genuinely usable.
      expect(() =>
        execFileSync(
          process.execPath,
          [
            join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
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
        ),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});