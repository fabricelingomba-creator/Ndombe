import type { AppNotification, NotificationCategory, NotificationInbox } from '@elongo/shared/types';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { linkTarget } from '@/lib/links';
import { useSession } from '@/session/session';
import { useResource } from '@/session/use-resource';
import { useUnread } from '@/session/unread';
import { Badge, Body, Button, Loading, Notice, Row, Screen } from '@/ui/components';
import { formatDateTime } from '@/ui/format';
import { useTheme } from '@/ui/theme';

const CATEGORY_TAGS: Record<NotificationCategory, string> = {
  finance: 'Paiements',
  academic: 'Études',
  tasks: 'À traiter',
  announcements: 'Annonce',
};

/** Boîte de réception. Marquer comme lu fonctionne aussi hors ligne (rejoué au retour du réseau). */
export default function Notifications() {
  const { sendOrQueue, tenant } = useSession();
  const unread = useUnread();
  const inbox = useResource<NotificationInbox>('notifications', '/v1/me/notifications?limit=30');
  const [readNow, setReadNow] = useState<Set<string>>(new Set());
  const [allRead, setAllRead] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { reload } = inbox;
  useFocusEffect(
    useCallback(() => {
      setAllRead(false);
      setReadNow(new Set());
      void reload();
    }, [reload]),
  );

  const items = (inbox.data?.items ?? []).map((n) => (allRead || readNow.has(n.id) ? { ...n, readAt: n.readAt ?? 'local' } : n));
  const unreadCount = items.filter((n) => !n.readAt).length;

  const openItem = async (n: AppNotification) => {
    setError(null);
    if (!n.readAt) {
      setReadNow((s) => new Set(s).add(n.id));
      unread.set(Math.max(0, unread.count - 1));
      sendOrQueue({ id: `read:${n.id}`, method: 'POST', path: `/v1/me/notifications/${n.id}/read` }).catch((err) =>
        setError((err as Error).message),
      );
    }
    const target = linkTarget(n.link, tenant?.portalUrl ?? '');
    if (target?.kind === 'app') router.navigate(target.href);
    else if (target?.kind === 'web') await WebBrowser.openBrowserAsync(target.url);
  };

  const markAll = () => {
    setAllRead(true);
    unread.set(0);
    sendOrQueue({ id: `read-all:${Date.now()}`, method: 'POST', path: '/v1/me/notifications/read-all' }).catch((err) =>
      setError((err as Error).message),
    );
  };

  return (
    <Screen refreshing={inbox.loading && !!inbox.data} onRefresh={() => void inbox.reload()} offlineSince={inbox.offlineSince}>
      {!inbox.data && inbox.loading && <Loading />}
      {inbox.error && !inbox.data && <Notice kind="error">{inbox.error}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {inbox.data && (
        <Row>
          <Body muted>{unreadCount === 0 ? 'Tout est lu.' : `${unreadCount} non lue${unreadCount > 1 ? 's' : ''}`}</Body>
          {unreadCount > 0 && <Button title="Tout marquer comme lu" variant="outline" onPress={markAll} />}
        </Row>
      )}
      {inbox.data && items.length === 0 && <Body muted>Aucune notification pour le moment.</Body>}
      {items.map((n) => (
        <NotificationRow key={n.id} n={n} onPress={() => void openItem(n)} />
      ))}
    </Screen>
  );
}

function NotificationRow({ n, onPress }: { n: AppNotification; onPress: () => void }) {
  const t = useTheme();
  const unread = !n.readAt;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? 'Non lue. ' : ''}${n.title}`}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: t.surface,
        borderColor: t.line,
        borderWidth: 1,
        borderLeftWidth: unread ? 4 : 1,
        borderLeftColor: unread ? t.primary : t.line,
        borderRadius: 12,
        padding: 14,
        gap: 6,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Badge label={CATEGORY_TAGS[n.category]} tone={n.category === 'tasks' ? 'warning' : 'neutral'} />
        <Text style={{ color: t.muted, fontSize: 12 }}>{formatDateTime(n.createdAt)}</Text>
      </View>
      <Text style={{ color: t.ink, fontSize: 16, fontWeight: unread ? '700' : '500' }}>{n.title}</Text>
      {!!n.body && <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>{n.body}</Text>}
    </Pressable>
  );
}
