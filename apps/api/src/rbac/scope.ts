export type ScopeType = 'university' | 'faculty' | 'department' | 'course';

export interface Scope {
  type: ScopeType;
  /** null pour la portée université. */
  id: string | null;
}

export const UNIVERSITY_SCOPE: Scope = { type: 'university', id: null };

export interface Grant {
  permission: string;
  scope: Scope;
}

/**
 * Vrai si l'une des attributions couvre la permission sur la cible.
 * `targetChain` liste la cible puis ses ancêtres, jusqu'à l'université
 * (département → faculté → université) : un SG-Acad de faculté couvre
 * ainsi les départements de sa faculté.
 */
export function grantsAllow(grants: readonly Grant[], permission: string, targetChain: readonly Scope[]): boolean {
  return grants.some(
    (g) =>
      g.permission === permission &&
      (g.scope.type === 'university' || targetChain.some((s) => s.type === g.scope.type && s.id === g.scope.id)),
  );
}
