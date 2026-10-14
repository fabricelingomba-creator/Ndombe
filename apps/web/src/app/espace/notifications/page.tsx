import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { FormattedDate } from '@/components/date';
import { SpaceShell } from '@/components/space-shell';
import { getManifest, getNotificationPreferences, getNotifications } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { portalRequest } from '@/lib/request';
import type { AppNotification, NotificationCategory } from '@/lib/types';
import { markAllNotificationsRead, openNotification, saveNotificationPreferences } from '../actions';

export const metadata: Metadata = { title: 'Notifications' };

const CATEGORY_TAGS: Record<NotificationCategory, string> = {
  finance: 'Paiements',
  academic: 'Études',
  tasks: 'À traiter',
  announcements: 'Annonce',
};

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

/** Boîte de réception de l'utilisateur et choix des e-mails reçus. */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ avant?: string }> }) {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { accessToken } = await requireUser(host, '/espace/notifications');
  const { avant } = await searchParams;
  const before = avant && ISO.test(avant) ? avant : undefined;
  const [inbox, preferences] = await Promise.all([
    getNotifications(host, accessToken, before),
    getNotificationPreferences(host, accessToken),
  ]);
  const last = inbox.items.at(-1);

  return (
    <SpaceShell manifest={manifest} title="Notifications">
      <div className="inbox-head">
        <p className="muted">
          {inbox.unreadCount === 0
            ? 'Tout est lu.'
            : `${inbox.unreadCount} notification${inbox.unreadCount > 1 ? 's' : ''} non lue${inbox.unreadCount > 1 ? 's' : ''}.`}
        </p>
        {inbox.unreadCount > 0 && (
          <ActionForm action={markAllNotificationsRead}>
            <SubmitButton variant="outline">Tout marquer comme lu</SubmitButton>
          </ActionForm>
        )}
      </div>

      {inbox.items.length === 0 ? (
        <p className="muted">{before ? 'Aucune notification plus ancienne.' : 'Aucune notification pour le moment.'}</p>
      ) : (
        <ul className="inbox">
          {inbox.items.map((n) => (
            <NotificationItem key={n.id} n={n} locale={manifest.locale} />
          ))}
        </ul>
      )}
      {inbox.items.length === 30 && last && (
        <p>
          <a href={`/espace/notifications?avant=${encodeURIComponent(last.createdAt)}`}>Voir les plus anciennes</a>
        </p>
      )}

      <section className="section-tight" aria-labelledby="preferences">
        <h2 id="preferences">Recevoir aussi par e-mail</h2>
        <p className="muted small">Les notifications restent toujours visibles ici ; ces choix ne concernent que les e-mails.</p>
        <ActionForm action={saveNotificationPreferences} className="preferences">
          {preferences.map((p) => (
            <label key={p.category} className="check">
              <input type="hidden" name="shown" value={p.category} />
              <input type="checkbox" name={`email:${p.category}`} defaultChecked={p.email} /> {p.label}
            </label>
          ))}
          <SubmitButton>Enregistrer</SubmitButton>
        </ActionForm>
      </section>
    </SpaceShell>
  );
}

function NotificationItem({ n, locale }: { n: AppNotification; locale: string }) {
  return (
    <li className={n.readAt ? 'inbox-item' : 'inbox-item unread'}>
      <form action={openNotification.bind(null, n.id)}>
        <button type="submit" className="inbox-open">
          <span className="inbox-meta">
            {!n.readAt && <span className="dot" aria-label="Non lue" />}
            <span className="tag">{CATEGORY_TAGS[n.category]}</span>
            <FormattedDate iso={n.createdAt} locale={locale} />
          </span>
          <strong className="inbox-title">{n.title}</strong>
          {n.body && <span className="inbox-body">{n.body}</span>}
        </button>
      </form>
    </li>
  );
}
