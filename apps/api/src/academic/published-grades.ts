import type { Tx } from '../db/database.service';
import { TermResult, termResult } from './grade-workflow';

export interface PublishedGrade {
  courseCode: string;
  courseTitle: string;
  credits: number;
  score: number;
  publishedAt: Date;
}

export interface TermGrades extends TermResult {
  termName: string;
  grades: PublishedGrade[];
}

/** Notes publiées d'un étudiant, regroupées par période (la plus récente d'abord). */
export async function publishedGradesByTerm(tx: Tx, studentId: string): Promise<TermGrades[]> {
  const rows = (
    await tx.query<PublishedGrade & { termCode: string; termName: string }>(
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
      [studentId],
    )
  ).rows;
  const terms = new Map<string, { termName: string; grades: PublishedGrade[] }>();
  for (const { termCode, termName, ...grade } of rows) {
    const term = terms.get(termCode) ?? { termName, grades: [] };
    term.grades.push(grade);
    terms.set(termCode, term);
  }
  return [...terms.entries()].map(([termCode, t]) => ({ ...termResult(termCode, t.grades), termName: t.termName, grades: t.grades }));
}
