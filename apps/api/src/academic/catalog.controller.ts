import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';

const createTermSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(200),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  })
  .refine((t) => t.endsOn > t.startsOn, { message: 'La fin doit suivre le début', path: ['endsOn'] });

const createCourseSchema = z.object({
  code: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(200),
  credits: z.number().positive().max(999),
});

const createOfferingSchema = z.object({
  courseId: z.uuid(),
  termId: z.uuid(),
  section: z.string().trim().min(1).max(16).default('A'),
  capacity: z.number().int().positive().max(10_000).nullable().default(null),
});

const TERM_COLUMNS = `id, code, name, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn"`;
const COURSE_COLUMNS = `id, department_id AS "departmentId", code, title, credits::float AS credits`;

/** Calendrier académique : périodes (semestres, années). */
@Controller('v1/terms')
export class TermsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('academic:structure:read', 'any')
  list(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (await tx.query(`SELECT ${TERM_COLUMNS} FROM academic_terms ORDER BY starts_on DESC`)).rows;
    });
  }

  @Post()
  @RequirePermission('academic:calendar:write')
  create(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(createTermSchema)) body: z.infer<typeof createTermSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const term = (
        await tx.query(
          `INSERT INTO academic_terms (tenant_id, code, name, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5)
           RETURNING ${TERM_COLUMNS}`,
          [tenant.id, body.code, body.name, body.startsOn, body.endsOn],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'term.created',
        entityType: 'academic_term',
        entityId: term.id,
        after: term,
        ip: req.ip,
      });
      return term;
    });
  }
}

/** Catalogue d'un département : cours et offres (cours donné pendant une période). */
@Controller('v1/departments/:departmentId')
export class CatalogController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get('courses')
  @RequirePermission('academic:structure:read', { type: 'department', param: 'departmentId' })
  courses(@CurrentTenant() tenant: Tenant, @Param('departmentId', ParseUUIDPipe) departmentId: string) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT ${COURSE_COLUMNS} FROM courses WHERE department_id = $1 AND deleted_at IS NULL ORDER BY code`,
          [departmentId],
        )
      ).rows;
    });
  }

  @Post('courses')
  @RequirePermission('academic:structure:write', { type: 'department', param: 'departmentId' })
  createCourse(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Body(new ZodPipe(createCourseSchema)) body: z.infer<typeof createCourseSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const course = (
        await tx.query(
          `INSERT INTO courses (tenant_id, department_id, code, title, credits) VALUES ($1, $2, $3, $4, $5)
           RETURNING ${COURSE_COLUMNS}`,
          [tenant.id, departmentId, body.code, body.title, body.credits],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'course.created',
        entityType: 'course',
        entityId: course.id,
        after: course,
        ip: req.ip,
      });
      return course;
    });
  }

  @Get('offerings')
  @RequirePermission('academic:structure:read', { type: 'department', param: 'departmentId' })
  offerings(
    @CurrentTenant() tenant: Tenant,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Query('termId', new ParseUUIDPipe({ optional: true })) termId?: string,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT o.id, c.code AS "courseCode", c.title AS "courseTitle", t.code AS "termCode", o.section,
                  o.capacity, o.grades_status AS "gradesStatus",
                  (SELECT count(*)::int FROM enrollments e WHERE e.offering_id = o.id) AS "enrolledCount"
             FROM course_offerings o
             JOIN courses c ON c.id = o.course_id
             JOIN academic_terms t ON t.id = o.term_id
            WHERE c.department_id = $1 AND ($2::uuid IS NULL OR o.term_id = $2)
            ORDER BY t.starts_on DESC, c.code, o.section`,
          [departmentId, termId ?? null],
        )
      ).rows;
    });
  }

  @Post('offerings')
  @RequirePermission('courses:offerings:write', { type: 'department', param: 'departmentId' })
  createOffering(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Body(new ZodPipe(createOfferingSchema)) body: z.infer<typeof createOfferingSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      // La permission porte sur le département de l'URL : le cours doit lui appartenir.
      const course = await tx.query('SELECT 1 FROM courses WHERE id = $1 AND department_id = $2 AND deleted_at IS NULL', [
        body.courseId,
        departmentId,
      ]);
      if (!course.rowCount) throw new NotFoundException('Cours introuvable dans ce département');
      const offering = (
        await tx.query(
          `INSERT INTO course_offerings (tenant_id, course_id, term_id, section, capacity) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, course_id AS "courseId", term_id AS "termId", section, capacity, grades_status AS "gradesStatus"`,
          [tenant.id, body.courseId, body.termId, body.section, body.capacity],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'offering.created',
        entityType: 'course_offering',
        entityId: offering.id,
        after: offering,
        ip: req.ip,
      });
      return offering;
    });
  }
}
