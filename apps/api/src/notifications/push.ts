import { Logger } from '@nestjs/common';

export interface PushMessage {
  /** Jetons Expo Push des téléphones du destinataire. */
  to: string[];
  title: string;
  body: string;
  data: Record<string, string | null>;
}

/** Résultat par jeton, dans l'ordre de `to`. */
export interface PushTicket {
  token: string;
  ok: boolean;
  /** Application désinstallée ou jeton périmé : l'appareil est à oublier. */
  unregistered: boolean;
  error?: string;
}

/** Canal push. Une erreur levée par send() (réseau, 5xx) reprogramme l'envoi. */
export interface PushTransport {
  readonly key: 'log' | 'expo';
  send(message: PushMessage): Promise<PushTicket[]>;
}

export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

/** Corps affiché sur l'écran verrouillé : court, le détail reste dans l'app. */
export function pushBody(body: string): string {
  return body.length > 180 ? `${body.slice(0, 177).trimEnd()}…` : body;
}

export class LogPushTransport implements PushTransport {
  readonly key = 'log' as const;
  readonly sent: PushMessage[] = [];
  private readonly logger = new Logger('Push');

  async send(message: PushMessage) {
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();
    this.logger.log(`→ ${message.to.length} appareil(s) : ${message.title}`);
    return message.to.map((token) => ({ token, ok: true, unregistered: false }));
  }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Service Expo Push : il relaie vers APNs (iPhone) et FCM (Android) avec les
 * clés déposées sur expo.dev ; l'API n'en détient aucune.
 */
export class ExpoPushTransport implements PushTransport {
  readonly key = 'expo' as const;

  constructor(
    private readonly accessToken?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(message: PushMessage): Promise<PushTicket[]> {
    const res = await this.fetchFn(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(
        message.to.map((to) => ({
          to,
          title: message.title,
          body: pushBody(message.body),
          data: message.data,
          sound: 'default',
          priority: 'high',
          channelId: 'default',
        })),
      ),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Expo Push a répondu ${res.status}`);
    const json = (await res.json()) as { data?: { status: string; message?: string; details?: { error?: string } }[] };
    const tickets = json.data ?? [];
    return message.to.map((token, i) => {
      const t = tickets[i];
      if (t?.status === 'ok') return { token, ok: true, unregistered: false };
      return {
        token,
        ok: false,
        unregistered: t?.details?.error === 'DeviceNotRegistered',
        error: t?.message ?? 'Réponse Expo Push incomplète',
      };
    });
  }
}
