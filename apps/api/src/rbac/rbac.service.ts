import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/database.service';
import { Grant, Scope, UNIVERSITY_SCOPE } from './scope';

@Injectable()
export class RbacService {
  /** Permissions effectives d'un utilisateur, avec leur portée. RLS active : tx doit être tenant. */
  async loadGrants(tx: Tx, userId: string): Promise<{ roles: string[]; grants: Grant[] }> {
    const res = await tx.query<{ role_key: string; permission: string; scope_type: Scope['type']; scope_id: string | null }>(
      `SELECT r.key AS role_key, rp.permission, ra.scope_type, ra.scope_id
         FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ra.user_id = $1`,
      [userId],
    );
    const roles = [...new Set(res.rows.map((r) => r.role_key))].sort();
    const grants = res.rows.map((r) => ({ permission: r.permission, scope: { type: r.scope_type, id: r.scope_id } }));
    return { roles, grants };
  }

  /** La cible puis ses ancêtres, jusqu'à l'université. */
  async scopeChain(tx: Tx, target: Scope): Promise<Scope[]> {
    if (target.type === 'university') return [UNIVERSITY_SCOPE];
    if (target.type === 'department' && target.id) {
      const res = await tx.query<{ faculty_id: string }>('SELECT faculty_id FROM departments WHERE id = $1', [target.id]);
      const facultyId = res.rows[0]?.faculty_id;
      return facultyId
        ? [target, { type: 'faculty', id: facultyId }, UNIVERSITY_SCOPE]
        : [target, UNIVERSITY_SCOPE];
    }
    if (target.type === 'course' && target.id) {
      // Portée « course » = une offre de cours ; on remonte offre → département → faculté.
      const res = await tx.query<{ department_id: string; faculty_id: string }>(
        `SELECT c.department_id, d.faculty_id
           FROM course_offerings o
           JOIN courses c ON c.id = o.course_id
           JOIN departments d ON d.id = c.department_id
          WHERE o.id = $1`,
        [target.id],
      );
      const row = res.rows[0];
      return row
        ? [target, { type: 'department', id: row.department_id }, { type: 'faculty', id: row.faculty_id }, UNIVERSITY_SCOPE]
        : [target, UNIVERSITY_SCOPE];
    }
    return [target, UNIVERSITY_SCOPE];
  }
}
