import { createHash, randomInt } from 'node:crypto';
import { canonicalJson } from '../audit/audit.service';
import { termResult } from '../academic/grade-workflow';
import type { TermGrades } from '../academic/published-grades';

/** Contenu figé d'un relevé officiel : c'est lui qui est haché et imprimé. */
export interface TranscriptSnapshot {
  university: { name: string; slug: string };
  student: { id: string; fullName: string; email: string };
  terms: {
    termCode: string;
    termName: string;
    average: number | null;
    creditsAttempted: number;
    creditsEarned: number;
    grades: { courseCode: string; courseTitle: string; credits: number; score: number }[];
  }[];
  /** Moyenne cumulée pondérée par les crédits, sur toutes les périodes. */
  summary: { average: number | null; creditsAttempted: number; creditsEarned: number };
  issuedAt: string;
  verificationCode: string;
  verifyUrl: string;
}

// Base 32 de Crockford : pas de I, L, O ni U, pour éviter les confusions à la saisie.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Code de 12 caractères (60 bits), présenté en trois groupes : 7K2M-9QXA-4TPD. */
export function newVerificationCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
}

/** Normalise un code saisi à la main (minuscules, espaces, O pour 0…). */
export function normalizeVerificationCode(raw: string): string | null {
  const compact = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}

export function buildSnapshot(input: {
  university: TranscriptSnapshot['university'];
  student: TranscriptSnapshot['student'];
  terms: TermGrades[];
  issuedAt: Date;
  verificationCode: string;
  verifyUrl: string;
}): TranscriptSnapshot {
  const allGrades = input.terms.flatMap((t) => t.grades);
  const total = termResult('total', allGrades);
  return {
    university: input.university,
    student: input.student,
    terms: input.terms.map((t) => ({
      termCode: t.termCode,
      termName: t.termName,
      average: t.average,
      creditsAttempted: t.creditsAttempted,
      creditsEarned: t.creditsEarned,
      grades: t.grades.map(({ courseCode, courseTitle, credits, score }) => ({ courseCode, courseTitle, credits, score })),
    })),
    summary: { average: total.average, creditsAttempted: total.creditsAttempted, creditsEarned: total.creditsEarned },
    issuedAt: input.issuedAt.toISOString(),
    verificationCode: input.verificationCode,
    verifyUrl: input.verifyUrl,
  };
}

/** Empreinte SHA-256 du contenu canonique : toute altération du relevé la change. */
export function snapshotHash(snapshot: TranscriptSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}
