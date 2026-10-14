import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Complète app.json avec ce qui ne doit pas vivre dans le dépôt public :
 *   EAS_PROJECT_ID        identifiant du projet sur expo.dev (jetons de notification push) ;
 *   GOOGLE_SERVICES_JSON  chemin du google-services.json de Firebase (variable « fichier » d'EAS).
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  android: {
    ...config.android,
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
  },
  extra: {
    ...config.extra,
    ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
  },
});
