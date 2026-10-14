import { getUnreadCount } from '@/lib/api';
import { portalRequest } from '@/lib/request';
import { readAccess } from '@/lib/session';

/** Cloche de l'en-tête : nombre de notifications non lues, lien vers la boîte de réception. */
export async function NotificationBell() {
  const { host } = await portalRequest();
  const access = await readAccess(host);
  if (!access) return null;
  // Le compteur est un confort : une erreur de l'API ne doit pas casser la page.
  const count = await getUnreadCount(host, access.accessToken)
    .then((r) => r.count)
    .catch(() => 0);
  const label = count === 0 ? 'Notifications' : `Notifications, ${count} non lue${count > 1 ? 's' : ''}`;
  return (
    <a className="bell" href="/espace/notifications" aria-label={label} title={label}>
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 && <span className="bell-count">{count > 99 ? '99+' : count}</span>}
    </a>
  );
}

export function SpaceHeaderActions() {
  return (
    <div className="header-actions">
      <NotificationBell />
      <form action="/auth/logout" method="post">
        <button type="submit" className="button button-outline-dark">
          Se déconnecter
        </button>
      </form>
    </div>
  );
}
