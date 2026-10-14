import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useSession } from '@/session/session';
import { UnreadProvider, useUnread } from '@/session/unread';
import { useTheme } from '@/ui/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const icon = (name: IconName) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />;

export default function SpaceLayout() {
  return (
    <UnreadProvider>
      <SpaceTabs />
    </UnreadProvider>
  );
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
