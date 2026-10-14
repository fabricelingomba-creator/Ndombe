import { Redirect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSession } from '@/session/session';
import { Loading } from '@/ui/components';

// Web : la fenêtre de connexion revient ici et rend la main à l'app.
WebBrowser.maybeCompleteAuthSession();

/** Retour du SSO : la session est créée par la connexion elle-même ; cet écran ne fait que patienter. */
export default function AuthCallback() {
  const { status } = useSession();
  if (status === 'ready') return <Redirect href="/" />;
  if (status === 'loading') return <Loading />;
  return <Redirect href={status === 'no-tenant' ? '/universite' : status === 'locked' ? '/verrou' : '/connexion'} />;
}
