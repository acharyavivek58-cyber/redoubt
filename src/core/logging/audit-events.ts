/**
 * Centralized audit event registry (v14 §15, v16 §A).
 *
 * Event names live in one place so backup, template, jail, moderation, and
 * economy events cannot drift. v14 §15 requires DENIED attempts to be audited
 * too — a rejected owner attempt is precisely what an operator wants to find
 * afterwards — while never exposing unnecessary internal detail to the actor.
 */

import { getLogger } from './logger.js';

export const AUDIT_EVENTS = [
  // Backup / template — owner-gated (v14)
  'BACKUP_OWNER_AUTHORIZED',
  'BACKUP_OWNER_DENIED',
  'BACKUP_CREATED',
  'BACKUP_RESTORED',
  'BACKUP_DELETED',
  'TEMPLATE_OWNER_AUTHORIZED',
  'TEMPLATE_OWNER_DENIED',
  'TEMPLATE_CREATED',
  'TEMPLATE_LOADED',
  'TEMPLATE_EXPORTED',
  'TEMPLATE_DELETED',
  // Jail (v12 §J.20)
  'JAIL_CREATED',
  'JAIL_RELEASED',
  'JAIL_EXPIRED',
  'JAIL_REAPPLIED',
  'JAIL_FAILED',
  'JAIL_RECOVERY_REQUIRED',
  'JAIL_ROLE_RESTORE_PARTIAL',
  // Economy (v13 §15)
  'ECONOMY_TRANSACTION',
  'ECONOMY_RECOVERY_CREATED',
  'ECONOMY_RECOVERY_RESOLVED',
  // Leveling / rewards
  'LEVEL_REWARD_DELIVERED',
  'LEVEL_REWARD_FAILED',
  'SEASON_FINALIZED',
  // Command dispatch — a denied or exempted invocation is an auditable event,
  // because "who tried to do what they could not" is exactly what an operator
  // needs during an incident.
  'COMMAND_DENIED',
  'COMMAND_EXEMPTED',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export interface AuditRecord {
  readonly event: AuditEvent;
  readonly guildId: string;
  /** The user who performed (or attempted) the action. */
  readonly actorId: string;
  /** The CURRENT guild owner at the time of the record. */
  readonly currentOwnerId?: string;
  readonly operationId?: string;
  readonly resourceId?: string;
  readonly userId?: string;
  readonly caseId?: string;
  readonly result: 'SUCCESS' | 'DENIED' | 'FAILED' | 'PARTIAL';
  readonly reason?: string;
  readonly referenceId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: Date;
}

/**
 * Writes an audit record.
 *
 * `detailSafeForActor` marks a DENIED record: the record itself retains the
 * actor and outcome for operators, but any field that could teach an attacker
 * about the authorization decision is dropped from the user-facing echo.
 */
export function writeAudit(record: Omit<AuditRecord, 'timestamp'>): AuditRecord {
  const full: AuditRecord = { ...record, timestamp: new Date() };

  const log = getLogger().child({
    audit: full.event,
    guildId: full.guildId,
    actorId: full.actorId,
    result: full.result,
  });

  if (full.result === 'DENIED') {
    // v14 §15: log the denial, but never log the owner's id or the internal
    // reason that could leak how the decision was reached.
    log.warn(
      { resourceId: full.resourceId, referenceId: full.referenceId },
      'audit: authorization denied',
    );
  } else {
    log.info({ ...full.metadata, referenceId: full.referenceId }, `audit: ${full.event}`);
  }

  return full;
}

/**
 * The user-facing echo for a denied audit record.
 *
 * Deliberately omits actor, owner, and reason: the denied user learns only that
 * they may not perform the operation.
 */
export function deniedUserEcho(referenceId: string): string {
  return [
    'OWNER ACCESS REQUIRED',
    'Only the current server owner can perform this operation.',
    `Reference: ${referenceId}`,
  ].join('\n');
}