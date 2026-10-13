/**
 * Circuit d'une feuille de notes. Le professeur saisit puis soumet ; le SG
 * académique approuve ou renvoie avec un motif ; la publication rend les
 * notes visibles aux étudiants. Seuls draft et returned sont modifiables.
 */
export type GradesStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'published';

export type GradeAction = 'submit' | 'approve' | 'return' | 'publish';

export const EDITABLE_STATUSES: readonly GradesStatus[] = ['draft', 'returned'];

export const TRANSITIONS: Record<GradeAction, { from: readonly GradesStatus[]; to: GradesStatus }> = {
  submit: { from: EDITABLE_STATUSES, to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved' },
  return: { from: ['submitted'], to: 'returned' },
  publish: { from: ['approved'], to: 'published' },
};

export function isEditable(status: GradesStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

export function nextStatus(action: GradeAction, current: GradesStatus): GradesStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(current) ? t.to : null;
}

export interface TermResult {
  termCode: string;
  /** Moyenne sur 20 pondérée par les crédits, arrondie au centième. */
  average: number | null;
  creditsAttempted: number;
  /** Crédits des cours validés (note ≥ 10/20). */
  creditsEarned: number;
}

export const PASSING_SCORE = 10;

export function termResult(termCode: string, grades: readonly { score: number; credits: number }[]): TermResult {
  const creditsAttempted = grades.reduce((sum, g) => sum + g.credits, 0);
  const creditsEarned = grades.filter((g) => g.score >= PASSING_SCORE).reduce((sum, g) => sum + g.credits, 0);
  const weighted = grades.reduce((sum, g) => sum + g.score * g.credits, 0);
  return {
    termCode,
    average: creditsAttempted > 0 ? Math.round((weighted / creditsAttempted) * 100) / 100 : null,
    creditsAttempted,
    creditsEarned,
  };
}
