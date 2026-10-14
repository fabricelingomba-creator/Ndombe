import * as LocalAuthentication from 'expo-local-authentication';

/** Empreinte, visage ou, à défaut, le code du téléphone. */
export async function biometricsAvailable(): Promise<boolean> {
  return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
}

export async function confirmIdentity(reason: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'Annuler',
    fallbackLabel: 'Utiliser le code',
    biometricsSecurityLevel: 'strong',
  });
  return result.success;
}
