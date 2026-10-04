/**
 * Environment configuration safety (Phase 0A).
 *
 * Properties under test:
 *  - the Discord token is REQUIRED and validated before startup
 *  - the failure message is actionable and NEVER contains the token
 *  - `.env` loading is NON-OVERRIDING (real env / test values win)
 *  - no secret is ever echoed into an error or a log
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOKEN_PLACEHOLDER,
  loadConfig,
  loadEnvFile,
  resetConfig,
} from '../../src/core/config/env.js';

const VALID = {
  DISCORD_TOKEN: 'a'.repeat(60),
  DISCORD_CLIENT_ID: '000000000000000000',
  DATABASE_URL: 'postgres://localhost:5432/redoubt_test',
} as NodeJS.ProcessEnv;

/** Writes a temporary .env and returns its path plus a cleanup function. */
function withEnvFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'redoubt-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, contents, 'utf8');
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

afterEach(() => resetConfig());

describe('the Discord token is validated before startup', () => {
  it('fails clearly when DISCORD_TOKEN is missing', () => {
    const source = { ...VALID };
    delete source.DISCORD_TOKEN;
    expect(() => loadConfig(source)).toThrow('DISCORD_TOKEN is not configured');
  });

  it('fails clearly when DISCORD_TOKEN is only the placeholder', () => {
    // A freshly cloned repo ships a placeholder; booting with it must fail
    // loudly rather than attempt a doomed login.
    expect(() => loadConfig({ ...VALID, DISCORD_TOKEN: TOKEN_PLACEHOLDER })).toThrow(
      'DISCORD_TOKEN is not configured',
    );
  });

  it('treats a whitespace-only token as unconfigured', () => {
    expect(() => loadConfig({ ...VALID, DISCORD_TOKEN: '   ' })).toThrow(
      'DISCORD_TOKEN is not configured',
    );
  });

  it('accepts a properly configured environment', () => {
    const config = loadConfig({ ...VALID });
    expect(config.discord.token).toBe(VALID.DISCORD_TOKEN);
  });

  it('never includes the token value in the error message', () => {
    const secret = 'SHOULD_NEVER_APPEAR_'.repeat(4);
    try {
      loadConfig({ ...VALID, DISCORD_TOKEN: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain(VALID.DISCORD_TOKEN ?? '');
      expect((error as Error).message).toBe(
        'DISCORD_TOKEN is not configured. Set it in your environment or in .env, then restart.',
      );
    }
  });
});

describe('other required variables are still validated', () => {
  it('reports a missing DATABASE_URL with the field name', () => {
    const source = { ...VALID };
    delete source.DATABASE_URL;
    expect(() => loadConfig(source)).toThrow(/DATABASE_URL/);
  });

  it('rejects a malformed Discord token', () => {
    expect(() => loadConfig({ ...VALID, DISCORD_TOKEN: 'too-short' })).toThrow(/DISCORD_TOKEN/);
  });
});

describe('AI stays optional', () => {
  it('reports AI unavailable with no key and still returns a config', () => {
    const source = { ...VALID };
    delete source.GEMINI_API_KEY;
    const config = loadConfig(source);
    expect(config.ai.available).toBe(false);
  });

  it('reports AI available when a key is present', () => {
    const config = loadConfig({ ...VALID, GEMINI_API_KEY: 'placeholder-key' });
    expect(config.ai.available).toBe(true);
  });
});

describe('.env loading never overrides the real environment', () => {
  const touched: string[] = [];
  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
  });

  it('does not let a .env file override an existing variable', () => {
    const { path, cleanup } = withEnvFile(`SHARD_TOTAL=7\nDISCORD_TOKEN=${TOKEN_PLACEHOLDER}\n`);
    try {
      // A real shell export must win over the file, even when the file holds
      // the unusable placeholder.
      touched.push('SHARD_TOTAL', 'DISCORD_TOKEN');
      process.env.SHARD_TOTAL = '9';
      process.env.DISCORD_TOKEN = VALID.DISCORD_TOKEN;

      loadEnvFile(path);

      expect(process.env.SHARD_TOTAL).toBe('9');
      expect(process.env.DISCORD_TOKEN).toBe(VALID.DISCORD_TOKEN);
    } finally {
      cleanup();
    }
  });

  it('loads a variable that is not already set', () => {
    const { path, cleanup } = withEnvFile('SHARD_TOTAL=7\n');
    try {
      touched.push('SHARD_TOTAL');
      loadEnvFile(path);
      expect(process.env.SHARD_TOTAL).toBe('7');
    } finally {
      cleanup();
    }
  });

  it('ignores comments and blank lines', () => {
    const { path, cleanup } = withEnvFile('# a comment\n\n   \nSHARD_TOTAL=3\n# another\n');
    try {
      touched.push('SHARD_TOTAL');
      loadEnvFile(path);
      expect(process.env.SHARD_TOTAL).toBe('3');
    } finally {
      cleanup();
    }
  });

  it('strips surrounding quotes from a value', () => {
    const { path, cleanup } = withEnvFile('SHARD_TOTAL="4"\n');
    try {
      touched.push('SHARD_TOTAL');
      loadEnvFile(path);
      expect(process.env.SHARD_TOTAL).toBe('4');
    } finally {
      cleanup();
    }
  });

  it('keeps a hash that is part of a value', () => {
    // A password may legitimately contain '#'; only a separated comment is
    // stripped, so the URL fragment survives.
    const { path, cleanup } = withEnvFile('DATABASE_URL=postgres://u:p#ss@localhost:5432/db\n');
    // tests/setup.ts sets this, and non-overriding means the file is skipped.
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      touched.push('DATABASE_URL');
      loadEnvFile(path);
      expect(process.env.DATABASE_URL).toBe('postgres://u:p#ss@localhost:5432/db');
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
      cleanup();
    }
  });

  it('strips a genuinely trailing comment', () => {
    const { path, cleanup } = withEnvFile('SHARD_TOTAL=5 # temporary\n');
    try {
      touched.push('SHARD_TOTAL');
      loadEnvFile(path);
      expect(process.env.SHARD_TOTAL).toBe('5');
    } finally {
      cleanup();
    }
  });

  it('is a clean no-op when the file does not exist', () => {
    expect(() =>
      loadEnvFile(join(tmpdir(), 'redoubt-env-absent', 'definitely-missing.env')),
    ).not.toThrow();
  });

  it('loads only once, so later changes cannot re-trigger it', () => {
    const { path, cleanup } = withEnvFile('SHARD_TOTAL=6\n');
    try {
      touched.push('SHARD_TOTAL');
      loadEnvFile(path);
      expect(process.env.SHARD_TOTAL).toBe('6');

      delete process.env.SHARD_TOTAL;
      loadEnvFile(path);
      // Second call is a no-op; the value is not resurrected.
      expect(process.env.SHARD_TOTAL).toBeUndefined();
    } finally {
      cleanup();
      resetConfig();
    }
  });
});
