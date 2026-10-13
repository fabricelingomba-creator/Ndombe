import { StatusBadge } from '@/components/status-badge';
import type { GradeSheet } from '@/lib/types';

/** En-tête d'une feuille de notes : cours, période, enseignants, statut. */
export function SheetSummary({ sheet }: { sheet: GradeSheet }) {
  return (
    <div className="sheet-head">
      <p className="muted">
        {sheet.termName} · section {sheet.section} · {sheet.credits} crédits
        {sheet.instructors.length > 0 && <> · {sheet.instructors.map((i) => i.fullName).join(', ')}</>}
      </p>
      <p>
        Statut : <StatusBadge status={sheet.gradesStatus} />
      </p>
      {sheet.gradesStatus === 'returned' && sheet.returnReason && (
        <p className="alert">
          <strong>Renvoyée par le secrétariat académique :</strong> {sheet.returnReason}
        </p>
      )}
    </div>
  );
}
