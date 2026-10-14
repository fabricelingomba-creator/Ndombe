import type { Announcement, MyInvoice, TermGrades } from '@elongo/shared/types';
import { navFor } from '@elongo/shared/navigation';
import { formatMoney, totalsByCurrency } from '@elongo/shared/payments';
import { formatScore } from '@elongo/shared/grades';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSession } from '@/session/session';
import { useResource } from '@/session/use-resource';
import { useUnread } from '@/session/unread';
import { Body, Button, Card, Heading, Row, Screen, Title } from '@/ui/components';
import { formatDateTime, formatDay } from '@/ui/format';

/** Accueil : ce qui demande l'attention de l'utilisateur, en un coup d'œil. */
export default function Home() {
  const { me, tenant } = useSession();
  const { count } = useUnread();
  const can = (p: string) => me?.permissions.includes(p) ?? false;
  const invoices = useResource<MyInvoice[]>('invoices', can('self:payments:write') ? '/v1/me/invoices' : null);
  const grades = useResource<TermGrades[]>('grades', can('self:grades:read') ? '/v1/me/grades' : null);
  const news = useResource<Announcement[]>('announcements', '/v1/announcements?limit=10');

  const open = (invoices.data ?? []).filter((i) => i.status === 'open');
  const next = [...open].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
  const latestTerm = grades.data?.find((g) => g.average !== null);
  const staffSections = navFor(me?.permissions ?? [], me?.grants ?? []).filter((s) => s.key !== 'student');
  const refreshing = invoices.loading || news.loading;
  const offlineSince = invoices.offlineSince ?? news.offlineSince ?? grades.offlineSince;

  return (
    <Screen
      refreshing={refreshing && !!news.data}
      onRefresh={() => void Promise.all([invoices.reload(), grades.reload(), news.reload()])}
      offlineSince={offlineSince}
    >
      <Title>Bonjour {me?.fullName.split(' ')[0]}</Title>

      {count > 0 && (
        <Card accent>
          <Body bold>{count === 1 ? '1 notification non lue' : `${count} notifications non lues`}</Body>
          <Button title="Voir" variant="outline" onPress={() => router.navigate('/notifications')} />
        </Card>
      )}

      {invoices.data && (
        <Card accent={open.length > 0}>
          <Heading>Frais académiques</Heading>
          {open.length === 0 ? (
            <Body muted>Vous êtes à jour. Aucune facture à payer.</Body>
          ) : (
            <>
              {totalsByCurrency(open).map((t) => (
                <Body key={t.currency} bold>
                  Reste à payer : {formatMoney(t.outstanding, t.currency)}
                </Body>
              ))}
              {next && <Body muted>Prochaine échéance : {formatDay(next.dueOn)} ({next.feeName})</Body>}
              <Button title="Payer" onPress={() => router.navigate('/paiements')} />
            </>
          )}
        </Card>
      )}

      {latestTerm && (
        <Card>
          <Heading>Résultats</Heading>
          <Row>
            <Body>{latestTerm.termName}</Body>
            <Body bold>{formatScore(latestTerm.average)} / 20</Body>
          </Row>
          <Body muted>
            {latestTerm.creditsEarned} crédits obtenus sur {latestTerm.creditsAttempted}
          </Body>
          <Button title="Voir mes notes" variant="outline" onPress={() => router.navigate('/etudes')} />
        </Card>
      )}

      {staffSections.length > 0 && (
        <Card>
          <Heading>Mes tâches</Heading>
          <Body muted>Ces écrans s’ouvrent sur le portail web de l’université.</Body>
          {staffSections.flatMap((s) =>
            s.items
              .filter((i) => !i.upcoming)
              .map((i) => (
                <Button
                  key={i.key}
                  title={i.label}
                  variant="outline"
                  onPress={() => void WebBrowser.openBrowserAsync(`${tenant?.portalUrl}${i.href}`)}
                />
              )),
          )}
        </Card>
      )}

      {news.data && news.data.length > 0 && (
        <>
          <Heading>Annonces</Heading>
          {news.data.slice(0, 3).map((a) => (
            <Card key={a.id}>
              <Body bold>{a.title}</Body>
              <Body muted>{formatDateTime(a.publishedAt)}</Body>
              <Body>{a.body}</Body>
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
