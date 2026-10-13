import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Tx } from '../db/database.service';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  created_at: Date;
  prev_hash: string | null;
  hash: string;
}

/** JSON à clés triées, pour qu'un même contenu donne toujours le même hash. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function entryHash(prevHash: string | null, fields: Record<string, unknown>): string {
  return createHash('sha256')
    .update(prevHash ?? '')
    .update('\n')
    .update(canonicalJson(fields))
    .digest('hex');
}

/**
 * Journal d'audit en ajout seul. À appeler dans la même transaction que la
 * modification auditée : si l'une échoue, aucune des deux n'est enregistrée.
 * Chaque ligne contient le hash de la précédente (par université), ce qui rend
 * détectable toute suppression ou modification directe en base.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, tenantId: string, entry: AuditEntry): Promise<void> {
    // Sérialise les écritures d'une même université pour garder la chaîne linéaire.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('audit:' || $1))`, [tenantId]);
    const last = await tx.query<{ hash: string }>(
      'SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1',
      [tenantId],
    );
    const prevHash = last.rows[0]?.hash ?? null;
    const createdAt = new Date();
    const fields = {
      tenant_id: tenantId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      created_at: createdAt.toISOString(),
    };
    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, before, after, ip, created_at, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        fields.actor_user_id,
        fields.action,
        fields.entity_type,
        fields.entity_id,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ip ?? null,
        createdAt,
        prevHash,
        entryHash(prevHash, fields),
      ],
    );
  }

  /** Recalcule la chaîne ; renvoie l'id de la première ligne altérée, ou null si intacte. */
  async verifyChain(tx: Tx, tenantId: string): Promise<string | null> {
    const rows = (
      await tx.query<AuditRow>(
        `SELECT id, tenant_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, prev_hash, hash
           FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      )
    ).rows;
    let prev: string | null = null;
    for (const r of rows) {
      const expected = entryHash(prev, {
        tenant_id: r.tenant_id,
        actor_user_id: r.actor_user_id,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        before: r.before,
        after: r.after,
        created_at: new Date(r.created_at).toISOString(),
      });
      if (r.prev_hash !== prev || r.hash !== expected) return r.id;
      prev = r.hash;
    }
    return null;
  }

  async list(tx: Tx, limit: number) {
    return (
      await tx.query(
        `SELECT id, actor_user_id AS "actorUserId", action, entity_type AS "entityType", entity_id AS "entityId",
                before, after, ip, created_at AS "createdAt"
           FROM audit_log ORDER BY id DESC LIMIT $1`,
        [limit],
      )
    ).rows;
  }
}
