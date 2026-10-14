import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import type { ColorValue } from 'react-native';
import { linkTarget } from '@/lib/links';
import { PushData, usePushReceived, usePushTap } from '@/lib/push';
import { useSession } from '@/session/session';
import { UnreadProvider, useUnread } from '@/session/unread';
import { useTheme } from '@/ui/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const icon = (name: IconName) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />;

export default function SpaceLayout() {
  return (
    <UnreadProvider>
      <PushHandler />
      <SpaceTabs />
    </UnreadProvider>
  );
}

/** Appui sur une notification push : elle est marquée lue et son écran s'ouvre. */
function PushHandler() {
  const { tenant, sendOrQueue } = useSession();
  const unread = useUnread();

  const onTap = useCallback(
    (data: PushData) => {
      // Notification d'une autre université (changement d'université entre-temps) : ignorée.
      if (!tenant || (data.tenant && data.tenant !== tenant.slug)) return;
      if (data.notificationId && /^[0-9a-f-]{36}$/.test(data.notificationId)) {
        void sendOrQueue({ id: `read:${data.notificationId}`, method: 'POST', path: `/v1/me/notifications/${data.notificationId}/read` })
          .then(() => unread.refresh())
          .catch(() => undefined);
      }
      const target = linkTarget(data.link ?? null, tenant.portalUrl);
      if (target?.kind === 'app') router.navigate(target.href);
      else if (target?.kind === 'web') void WebBrowser.openBrowserAsync(target.url);
      else router.navigate('/notifications');
    },
    [tenant, sendOrQueue, unread],
  );
  usePushTap(onTap);
  usePushReceived(useCallback(() => void unread.refresh(), [unread]));
  return null;
}

/** Onglets selon les permissions : un professeur ne voit pas « Paiements ». */
function SpaceTabs() {
  const { me, tenant } = useSession();
  const { count } = useUnread();
  const t = useTheme();
  const can = (p: string) => me?.permissions.includes(p) ?? false;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line },
        headerStyle: { backgroundColor: t.primary },
        headerTintColor: t.onPrimary,
        headerTitleStyle: { fontWeight: '700' },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Accueil', headerTitle: tenant?.name ?? 'Accueil', tabBarIcon: icon('home-outline') }} />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: icon('notifications-outline'),
          tabBarBadge: count > 0 ? (count > 99 ? '99+' : count) : undefined,
          tabBarAccessibilityLabel: count > 0 ? `Notifications, ${count} non lues` : 'Notifications',
        }}
      />
      <Tabs.Protected guard={can('self:payments:write')}>
        <Tabs.Screen name="paiements" options={{ title: 'Paiements', headerShown: false, tabBarIcon: icon('wallet-outline') }} />
      </Tabs.Protected>
      <Tabs.Protected guard={can('self:courses:read') || can('self:grades:read')}>
        <Tabs.Screen name="etudes" options={{ title: 'Études', tabBarIcon: icon('school-outline') }} />
      </Tabs.Protected>
      <Tabs.Screen name="profil" options={{ title: 'Profil', tabBarIcon: icon('person-circle-outline') }} />
    </Tabs>
  );
}
