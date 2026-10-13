'use client';

import { startTransition, useActionState } from 'react';
import { useFormStatus } from 'react-dom';

export type ActionResult = { ok: boolean; message: string } | null;

/**
 * Formulaire relié à une action serveur, qui affiche le résultat renvoyé
 * (succès ou message d'erreur de l'API) sous les boutons.
 */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (state: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className}
      // React vide le formulaire après une action : on soumet nous-mêmes pour
      // garder la saisie (une note refusée ne doit pas effacer les autres).
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const data = new FormData(event.currentTarget, submitter);
        startTransition(() => formAction(data));
      }}
    >
      {children}
      {state && (
        <p role="status" className={state.ok ? 'notice' : 'alert'}>
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Bouton désactivé pendant l'envoi, pour éviter les doubles soumissions. */
export function SubmitButton({
  children,
  name,
  value,
  variant = 'primary',
}: {
  children: React.ReactNode;
  name?: string;
  value?: string;
  variant?: 'primary' | 'outline';
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={variant === 'primary' ? 'button' : 'button button-outline-dark'}
    >
      {children}
    </button>
  );
}
