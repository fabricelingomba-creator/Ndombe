import type { PushData, PushDevice } from './push';

export type { PushData, PushDevice } from './push';

/** Pas de notifications push dans le navigateur : la cloche de l'app suffit. */
export async function registerForPush(): Promise<PushDevice | null> {
  return null;
}

export function usePushTap(_onTap: (data: PushData) => void) {}

export function usePushReceived(_onReceive: () => void) {}
