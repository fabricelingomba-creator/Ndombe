import type { MyCourse, TermGrades, Transcript } from '@elongo/shared/types';
import { formatScore, PASSING_SCORE } from '@elongo/shared/grades';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { downloadAndShare } from '@/lib/download';
import { useSession } from '@/session/session';
import { useResource } from '@/session/use-resource';
import { Badge, Body, Button, Card, Heading, Loading, Notice, Row, Screen } from '@/ui/components';
import { formatDateTime } from '@/ui/format';

const TRANSCRIPT_LABELS: Record<Transcript['status'], string> = {
  requested: 'En cours de validation',
  validated: 'Validé',
  rejected: 'Refusé',
};

/** Cours de l'année, notes publiées et relevés officiels. */
export default function Studies() {
  const { me, api } = useSession();
  const can = (p: string) => me?.permissions.includes(p) ?? false;
  const courses = useResource<MyCourse[]>('courses', can('self:courses:read') ? '/v1/me/courses' : null);
  const grades = useResource<TermGrades[]>('grades', can('self:grades:read') ? '/v1/me/grades' : null);
  const transcripts = useResource<Transcript[]>('transcripts', can('self:grades:read') ? '/v1/me/transcripts' : null);
  const [result, setResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadAll = useCallback(() => {
    void courses.reload();
    void grades.reload();
    void transcripts.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses.reload, grades.reload, transcripts.reload]);
  useFocusEffect(reloadAll);

  const offline = courses.offlineSince ?? grades.offlineSince ?? transcripts.offlineSince;
  const waiting = transcripts.data?.some((t) => t.status === 'requested');

  const request = async () => {
    setBusy('request');
    setResult(null);
    try {
      await api!.post('/v1/me/transcripts');
      setResult({ kind: 'success', message: 'Demande envoyée au secrétariat académique.' });
      void transcripts.reload();
    } catch (err) {
      setResult({ kind: 'error', message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const download = async (t: Transcript) => {
    setBusy(t.id);
    setResult(null);
    try {
      await downloadAndShare(api!, `/v1/me/transcripts/${t.id}/pdf`, `releve-${t.verificationCode ?? t.id}.pdf`);
    } catch (err) {
      setResult({ kind: 'error', message: (err as Error).message || 'Téléchargement impossible.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen refreshing={courses.loading && !!courses.data} onRefresh={reloadAll} offlineSince={offline}>
      {result && <Notice kind={result.kind}>{result.message}</Notice>}

      {grades.data && (
        <>
          <Heading>Notes publiées</Heading>
          {grades.data.length === 0 && <Body muted>Aucune note publiée pour le moment.</Body>}
          {grades.data.map((term) => (
            <Card key={term.termCode}>
              <Row>
                <Body bold>{term.termName}</Body>
                {term.average !== null && <Badge label={`Moyenne ${formatScore(term.average)}`} tone={term.average >= PASSING_SCORE ? 'success' : 'danger'} />}
              </Row>
              <Body muted>
                {term.creditsEarned} crédits obtenus sur {term.creditsAttempted}
              </Body>
              {term.grades.map((g) => (
                <Row key={g.courseCode}>
                  <Body>
                    {g.courseCode} · {g.courseTitle}
                  </Body>
                  <Body bold>{formatScore(g.score)}</Body>
                </Row>
              ))}
            </Card>
          ))}
        </>
      )}

      {transcripts.data && (
        <>
          <Heading>Relevés officiels</Heading>
          {transcripts.data.map((t) => (
            <Card key={t.id}>
              <Row>
                <Body>Demandé le {formatDateTime(t.requestedAt)}</Body>
                <Badge label={TRANSCRIPT_LABELS[t.status]} tone={t.status === 'validated' ? 'success' : t.status === 'rejected' ? 'danger' : 'warning'} />
              </Row>
              {t.rejectReason && <Body>Motif : {t.rejectReason}</Body>}
              {t.status === 'validated' && (
                <>
                  <Body muted>Code de vérification : {t.verificationCode}</Body>
                  <Button title="Télécharger le PDF" variant="outline" onPress={() => void download(t)} busy={busy === t.id} disabled={!!offline} />
                </>
              )}
            </Card>
          ))}
          {!waiting && <Button title="Demander un relevé officiel" onPress={() => void request()} busy={busy === 'request'} disabled={!!offline} />}
        </>
      )}

      {courses.data && (
        <>
          <Heading>Mes cours</Heading>
          {courses.data.length === 0 && <Body muted>Aucun cours cette année.</Body>}
          {courses.data.map((c) => (
            <Card key={c.enrollmentId}>
              <Body bold>
                {c.courseCode} · {c.courseTitle}
              </Body>
              <Body muted>
                {c.termName} · section {c.section} · {c.credits} crédit{c.credits > 1 ? 's' : ''}
              </Body>
            </Card>
          ))}
        </>
      )}
      {!courses.data && !grades.data && (courses.loading || grades.loading) && <Loading />}
      {(courses.error || grades.error) && !courses.data && !grades.data && <Notice kind="error">{courses.error ?? grades.error}</Notice>}
    </Screen>
  );
}
