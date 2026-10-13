import { STATUS_LABELS } from '@/lib/grades';
import type { GradesStatus } from '@/lib/types';

export function StatusBadge({ status }: { status: GradesStatus }) {
  return <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>;
}
