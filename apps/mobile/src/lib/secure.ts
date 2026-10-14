import * as SecureStore from 'expo-secure-store';

/**
 * Secrets de session (jeton de renouvellement) dans le trousseau iOS ou le
 * Keystore Android, liés à cet appareil et lisibles seulement téléphone
 * déverrouillé ; jamais sauvegardés dans le cloud.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secure = {
  get: (key: string) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS),
  delete: (key: string) => SecureStore.deleteItemAsync(key, OPTIONS),
};
