import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService, Tx } from '../db/database.service';
import { RbacService } from '../rbac/rbac.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { GradeAction, GradesStatus, isEditable, nextStatus } from './grade-workflow';

const userRefSchema = z.object({ userId: z.uuid() });

const enterGradesSchema = z.object({
  grades: z
    .array(
      z.object({
        enrollmentId: z.uuid(),
        // Note sur 20, au centième ; null efface la note.
        score: z.number().min(0).max(20).multipleOf(0.01).nullable(),
      }),
    )
    .min(1)
    .max(2000),
});

const returnSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

interface LockedOffering {
  id: string;
  grades_status: GradesStatus;
  capacity: number | null;
  grades_submitted_by: string | null;
}

const AUDIT_ACTIONS: Record<GradeAction, string> = {
  submit: 'grades.submitted',
  approve: 'grades.approved',
  return: 'grades.returned',
  publish: 'grades.published',
};

const COURSE_SCOPE = { type: 'course', param: 'offeringId' } as const;

/**
 * Une offre de cours et sa feuille de notes. La portée « course » vaut pour
 * l'offre : un professeur n'agit que sur les offres qui lui sont attribuées,
 * un SG de faculté sur celles de sa faculté.
 */
@Controller('v1/offerings/:offeringId')
export class OfferingsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  @Get()
  @RequirePermission('courses:roster:read', COURSE_SCOPE)
  sheet(@CurrentTenant() tenant: Tenant, @Param('offeringId', ParseUUIDPipe) offeringId: string) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const offering = (
        await tx.query(
          `SELECT o.id, c.code AS "courseCode", c.title AS "courseTitle", c.credits::float AS credits,
                  t.code AS "termCode", t.name AS "termName", o.section, o.capacity,
                  o.grades_status AS "gradesStatus", o.return_reason AS "returnReason",
                  o.grades_submitted_at AS "submittedAt", o.grades_approved_at AS "approvedAt",
                  o.grades_published_at AS "publishedAt"
             FROM course_offerings o
             JOIN courses c ON c.id = o.course_id
             JOIN academic_terms t ON t.id = o.term_id
            WHERE o.id = $1`,
          [offeringId],
        )
      ).rows[0];
      if (!offering) throw new NotFoundException('Offre introuvable');
      const instructors = (
        await tx.query(
          `SELECT DISTINCT u.id, u.full_name AS "fullName", u.email
             FROM role_assignments ra
             JOIN users u ON u.id = ra.user_id
            WHERE ra.scope_type = 'course' AND ra.scope_id = $1
            ORDER BY "fullName"`,
          [offeringId],
        )
      ).rows;
      const roster = (
        await tx.query(
          `SELECT e.id AS "enrollmentId", u.id AS "studentId", u.full_name AS "fullName", u.email,
                  g.score::float AS score
             FROM enrollments e
             JOIN users u ON u.id = e.student_user_id
             LEFT JOIN grades g ON g.enrollment_id = e.id
            WHERE e.offering_id = $1
            ORDER BY u.full_name, u.email`,
          [offeringId],
        )
      ).rows;
      return { ...offering, instructors, roster };
    });
  }

  @Post('instructors')
  @HttpCode(204)
  @RequirePermission('courses:offerings:write', COURSE_SCOPE)
  async addInstructor(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Body(new ZodPipe(userRefSchema)) body: z.infer<typeof userRefSchema>,
    @Req() req: Request,
  ) {
    await this.db.withTenant(tenant.id, async (tx) => {
      await this.lockOffering(tx, offeringId);
      const inserted = await tx.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, granted_by)
         SELECT $1, u.id, r.id, 'course', $3, $4
           FROM users u, roles r
          WHERE u.id = $2 AND u.deleted_at IS NULL AND r.key = 'professor'
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [tenant.id, body.userId, offeringId, user.id],
      );
      if (!inserted.rowCount) {
        const exists = await tx.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [body.userId]);
        if (!exists.rowCount) throw new NotFoundException('Utilisateur introuvable');
        return; // Déjà enseignant de cette offre.
      }
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'offering.instructor_added',
        entityType: 'course_offering',
        entityId: offeringId,
        after: { userId: body.userId },
        ip: req.ip,
      });
    });
  }

  @Post('enrollments')
  @RequirePermission('enrollments:override', COURSE_SCOPE)
  enroll(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Body(new ZodPipe(userRefSchema)) body: z.infer<typeof userRefSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const offering = await this.lockOffering(tx, offeringId);
      if (!isEditable(offering.grades_status)) {
        throw new ConflictException('Feuille de notes soumise : inscriptions fermées');
      }
      // Seul un compte étudiant (qui peut consulter ses propres cours) s'inscrit.
      const student = await tx.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [body.userId]);
      if (!student.rowCount) throw new NotFoundException('Utilisateur introuvable');
      const { grants } = await this.rbac.loadGrants(tx, body.userId);
      if (!grants.some((g) => g.permission === 'self:courses:read')) {
        throw new UnprocessableEntityException("Ce compte n'est pas un compte étudiant");
      }
      if (offering.capacity !== null) {
        const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM enrollments WHERE offering_id = $1', [
          offeringId,
        ]);
        if (count.rows[0].n >= offering.capacity) throw new ConflictException('Capacité atteinte');
      }
      const enrollment = (
        await tx.query(
          `INSERT INTO enrollments (tenant_id, offering_id, student_user_id, created_by) VALUES ($1, $2, $3, $4)
           RETURNING id, offering_id AS "offeringId", student_user_id AS "studentId"`,
          [tenant.id, offeringId, body.userId, user.id],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'enrollment.created',
        entityType: 'enrollment',
        entityId: enrollment.id,
        after: enrollment,
        ip: req.ip,
      });
      return enrollment;
    });
  }

  @Delete('enrollments/:enrollmentId')
  @HttpCode(204)
  @RequirePermission('enrollments:override', COURSE_SCOPE)
  async unenroll(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Req() req: Request,
  ) {
    await this.db.withTenant(tenant.id, async (tx) => {
      const offering = await this.lockOffering(tx, offeringId);
      if (!isEditable(offering.grades_status)) {
        throw new ConflictException('Feuille de notes soumise : inscriptions fermées');
      }
      const removed = await tx.query(
        `DELETE FROM enrollments WHERE id = $1 AND offering_id = $2
         RETURNING id, student_user_id AS "studentId"`,
        [enrollmentId, offeringId],
      );
      if (!removed.rowCount) throw new NotFoundException('Inscription introuvable');
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'enrollment.deleted',
        entityType: 'enrollment',
        entityId: enrollmentId,
        before: removed.rows[0],
        ip: req.ip,
      });
    });
  }

  /** Saisie ou correction de notes, tant que la feuille n'est pas soumise. */
  @Put('grades')
  @RequirePermission('grades:enter', COURSE_SCOPE)
  enterGrades(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Body(new ZodPipe(enterGradesSchema)) body: z.infer<typeof enterGradesSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const offering = await this.lockOffering(tx, offeringId);
      if (!isEditable(offering.grades_status)) {
        throw new ConflictException(`Feuille de notes verrouillée (${offering.grades_status})`);
      }
      const ids = body.grades.map((g) => g.enrollmentId);
      if (new Set(ids).size !== ids.length) throw new UnprocessableEntityException('Inscription en double');

      const current = await tx.query<{ id: string; score: number | null }>(
        `SELECT e.id, g.score::float AS score
           FROM enrollments e LEFT JOIN grades g ON g.enrollment_id = e.id
          WHERE e.offering_id = $1 AND e.id = ANY($2::uuid[])`,
        [offeringId, ids],
      );
      if (current.rowCount !== ids.length) throw new NotFoundException("Inscription absente de cette offre");
      const before = new Map(current.rows.map((r) => [r.id, r.score]));

      const changes = body.grades.filter((g) => before.get(g.enrollmentId) !== g.score);
      for (const g of changes) {
        if (g.score === null) {
          await tx.query('DELETE FROM grades WHERE enrollment_id = $1', [g.enrollmentId]);
        } else {
          await tx.query(
            `INSERT INTO grades (enrollment_id, tenant_id, score, entered_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (enrollment_id) DO UPDATE SET score = EXCLUDED.score, entered_by = EXCLUDED.entered_by, updated_at = now()`,
            [g.enrollmentId, tenant.id, g.score, user.id],
          );
        }
      }
      if (changes.length > 0) {
        await this.audit.record(tx, tenant.id, {
          actorUserId: user.id,
          action: 'grades.entered',
          entityType: 'course_offering',
          entityId: offeringId,
          before: Object.fromEntries(changes.map((g) => [g.enrollmentId, before.get(g.enrollmentId)])),
          after: Object.fromEntries(changes.map((g) => [g.enrollmentId, g.score])),
          ip: req.ip,
        });
      }
      return { updated: changes.length };
    });
  }

  @Post('grades/submit')
  @HttpCode(200)
  @RequirePermission('grades:submit', COURSE_SCOPE)
  submit(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Req() req: Request,
  ) {
    return this.transition(tenant, user, offeringId, 'submit', req, async (tx) => {
      const counts = await tx.query<{ enrolled: number; graded: number }>(
        `SELECT count(*)::int AS enrolled, count(g.enrollment_id)::int AS graded
           FROM enrollments e LEFT JOIN grades g ON g.enrollment_id = e.id
          WHERE e.offering_id = $1`,
        [offeringId],
      );
      const { enrolled, graded } = counts.rows[0];
      if (enrolled === 0) throw new UnprocessableEntityException('Aucun étudiant inscrit');
      if (graded < enrolled) throw new UnprocessableEntityException(`${enrolled - graded} note(s) manquante(s)`);
    });
  }

  @Post('grades/approve')
  @HttpCode(200)
  @RequirePermission('grades:approve', COURSE_SCOPE)
  approve(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Req() req: Request,
  ) {
    return this.transition(tenant, user, offeringId, 'approve', req, async (_tx, offering) => {
      // Principe des quatre yeux : on n'approuve pas sa propre feuille.
      if (offering.grades_submitted_by === user.id) {
        throw new ForbiddenException("La personne qui a soumis les notes ne peut pas les approuver");
      }
    });
  }

  @Post('grades/return')
  @HttpCode(200)
  @RequirePermission('grades:approve', COURSE_SCOPE)
  sendBack(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Body(new ZodPipe(returnSchema)) body: z.infer<typeof returnSchema>,
    @Req() req: Request,
  ) {
    return this.transition(tenant, user, offeringId, 'return', req, undefined, body.reason);
  }

  @Post('grades/publish')
  @HttpCode(200)
  @RequirePermission('grades:publish', COURSE_SCOPE)
  publish(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Req() req: Request,
  ) {
    return this.transition(tenant, user, offeringId, 'publish', req);
  }

  private async lockOffering(tx: Tx, offeringId: string): Promise<LockedOffering> {
    const res = await tx.query<LockedOffering>(
      'SELECT id, grades_status, capacity, grades_submitted_by FROM course_offerings WHERE id = $1 FOR UPDATE',
      [offeringId],
    );
    if (!res.rowCount) throw new NotFoundException('Offre introuvable');
    return res.rows[0];
  }

  private transition(
    tenant: Tenant,
    user: AuthenticatedUser,
    offeringId: string,
    action: GradeAction,
    req: Request,
    check?: (tx: Tx, offering: LockedOffering) => Promise<void>,
    reason?: string,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const offering = await this.lockOffering(tx, offeringId);
      const to = nextStatus(action, offering.grades_status);
      if (!to) throw new ConflictException(`Action « ${action} » impossible depuis l'état ${offering.grades_status}`);
      await check?.(tx, offering);

      const stamp: Record<GradeAction, { set: string; value: unknown }> = {
        submit: { set: 'grades_submitted_by = $3, grades_submitted_at = now(), return_reason = NULL', value: user.id },
        approve: { set: 'grades_approved_by = $3, grades_approved_at = now()', value: user.id },
        return: { set: 'return_reason = $3', value: reason },
        publish: { set: 'grades_published_by = $3, grades_published_at = now()', value: user.id },
      };
      await tx.query(`UPDATE course_offerings SET grades_status = $2, ${stamp[action].set} WHERE id = $1`, [
        offeringId,
        to,
        stamp[action].value,
      ]);

      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: AUDIT_ACTIONS[action],
        entityType: 'course_offering',
        entityId: offeringId,
        before: { gradesStatus: offering.grades_status },
        after: { gradesStatus: to, ...(reason ? { reason } : {}) },
        ip: req.ip,
      });
      return { id: offeringId, gradesStatus: to };
    });
  }
}
