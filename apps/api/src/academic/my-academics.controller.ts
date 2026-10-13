import { BadRequestException, Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { DatabaseService } from '../db/database.service';
import { grantsAllow, Scope, UNIVERSITY_SCOPE } from '../rbac/scope';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { GradesStatus, termResult } from './grade-workflow';

/** Vues personnelles : cours et notes de l'étudiant, enseignements du professeur. */
@Controller('v1/me')
export class MyAcademicsController {
  constructor(private readonly db: DatabaseService) {}

  @Get('courses')
  @RequirePermission('self:courses:read')
  courses(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT e.id AS "enrollmentId", o.id AS "offeringId", c.code AS "courseCode", c.title AS "courseTitle",
                  c.credits::float AS credits, t.code AS "termCode", t.name AS "termName", o.section,
                  (o.grades_status = 'published') AS "gradesPublished"
             FROM enrollments e
             JOIN course_offerings o ON o.id = e.offering_id
             JOIN courses c ON c.id = o.course_id
             JOIN academic_terms t ON t.id = o.term_id
            WHERE e.student_user_id = $1
            ORDER BY t.starts_on DESC, c.code`,
          [user.id],
        )
      ).rows;
    });
  }

  /** Notes publiées uniquement, avec la moyenne pondérée et les crédits par période. */
  @Get('grades')
  @RequirePermission('self:grades:read')
  grades(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const rows = (
        await tx.query<{
          courseCode: string;
          courseTitle: string;
          credits: number;
          termCode: string;
          termName: string;
          score: number;
          publishedAt: Date;
        }>(
          `SELECT c.code AS "courseCode", c.title AS "courseTitle", c.credits::float AS credits,
                  t.code AS "termCode", t.name AS "termName", g.score::float AS score,
                  o.grades_published_at AS "publishedAt"
             FROM enrollments e
             JOIN course_offerings o ON o.id = e.offering_id AND o.grades_status = 'published'
             JOIN grades g ON g.enrollment_id = e.id
             JOIN courses c ON c.id = o.course_id
             JOIN academic_terms t ON t.id = o.term_id
            WHERE e.student_user_id = $1
            ORDER BY t.starts_on DESC, c.code`,
          [user.id],
        )
      ).rows;
      const terms = new Map<string, { termCode: string; termName: string; grades: typeof rows }>();
      for (const row of rows) {
        const term = terms.get(row.termCode) ?? { termCode: row.termCode, termName: row.termName, grades: [] };
        term.grades.push(row);
        terms.set(row.termCode, term);
      }
      return [...terms.values()].map((t) => ({
        ...termResult(t.termCode, t.grades),
        termName: t.termName,
        grades: t.grades.map(({ courseCode, courseTitle, credits, score, publishedAt }) => ({
          courseCode,
          courseTitle,
          credits,
          score,
          publishedAt,
        })),
      }));
    });
  }

  /** Offres dont l'utilisateur est enseignant (rôle attribué sur l'offre). */
  @Get('teaching')
  teaching(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT o.id, c.code AS "courseCode", c.title AS "courseTitle", t.code AS "termCode", o.section,
                  o.grades_status AS "gradesStatus", o.return_reason AS "returnReason",
                  count(e.id)::int AS "enrolledCount", count(g.enrollment_id)::int AS "gradedCount"
             FROM course_offerings o
             JOIN courses c ON c.id = o.course_id
             JOIN academic_terms t ON t.id = o.term_id
             LEFT JOIN enrollments e ON e.offering_id = o.id
             LEFT JOIN grades g ON g.enrollment_id = e.id
            WHERE o.id IN (SELECT scope_id FROM role_assignments WHERE user_id = $1 AND scope_type = 'course')
            GROUP BY o.id, c.code, c.title, t.code, t.starts_on
            ORDER BY t.starts_on DESC, c.code, o.section`,
          [user.id],
        )
      ).rows;
    });
  }
}

const REVIEW_STATUSES: readonly GradesStatus[] = ['submitted', 'approved'];

/**
 * Feuilles de notes à traiter par le SG académique : soumises (à approuver)
 * ou approuvées (à publier), limitées à sa portée (université ou faculté).
 */
@Controller('v1/grade-sheets')
export class GradeSheetsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  list(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status: string = 'submitted',
  ) {
    if (!REVIEW_STATUSES.includes(status as GradesStatus)) throw new BadRequestException('Statut invalide');
    const permission = status === 'submitted' ? 'grades:approve' : 'grades:publish';
    if (!user.grants.some((g) => g.permission === permission)) {
      throw new ForbiddenException(`Permission requise : ${permission}`);
    }
    return this.db.withTenant(tenant.id, async (tx) => {
      const rows = (
        await tx.query<{ id: string; departmentId: string; facultyId: string } & Record<string, unknown>>(
          `SELECT o.id, c.code AS "courseCode", c.title AS "courseTitle", t.code AS "termCode", o.section,
                  o.grades_status AS "gradesStatus", o.grades_submitted_at AS "submittedAt",
                  o.grades_approved_at AS "approvedAt", u.full_name AS "submittedBy",
                  d.id AS "departmentId", d.faculty_id AS "facultyId", d.name AS "departmentName",
                  (SELECT count(*)::int FROM enrollments e WHERE e.offering_id = o.id) AS "enrolledCount"
             FROM course_offerings o
             JOIN courses c ON c.id = o.course_id
             JOIN departments d ON d.id = c.department_id
             JOIN academic_terms t ON t.id = o.term_id
             LEFT JOIN users u ON u.id = o.grades_submitted_by
            WHERE o.grades_status = $1
            ORDER BY o.grades_submitted_at`,
          [status],
        )
      ).rows;
      return rows
        .filter((r) => {
          const chain: Scope[] = [
            { type: 'course', id: r.id },
            { type: 'department', id: r.departmentId },
            { type: 'faculty', id: r.facultyId },
            UNIVERSITY_SCOPE,
          ];
          return grantsAllow(user.grants, permission, chain);
        })
        .map(({ facultyId: _f, ...rest }) => rest);
    });
  }
}
