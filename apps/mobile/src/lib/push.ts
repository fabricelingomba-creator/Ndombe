import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

// Application ouverte : la notification s'affiche quand même en bannière.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export interface PushDevice {
  token: string;
  platform: 'ios' | 'android';
}

/**
 * Demande l'autorisation et renvoie le jeton Expo Push de ce téléphone ;
 * null sur simulateur, sans projet EAS configuré ou si l'utilisateur refuse.
 */
export async function registerForPush(): Promise<PushDevice | null> {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return null;
  const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Notifications',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return { token: data, platform: Platform.OS };
}

/** Données jointes par l'API à chaque notification push. */
export interface PushData {
  notificationId?: string;
  link?: string | null;
  tenant?: string;
}

/** Appui sur une notification, y compris celui qui a lancé l'app ; traité une seule fois. */
export function usePushTap(onTap: (data: PushData) => void) {
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    onTap((response.notification.request.content.data ?? {}) as PushData);
    void Notifications.clearLastNotificationResponseAsync();
  }, [response, onTap]);
}

/** Notification reçue pendant que l'app est ouverte. */
export function usePushReceived(onReceive: () => void) {
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => onReceive());
    return () => sub.remove();
  }, [onReceive]);
}
