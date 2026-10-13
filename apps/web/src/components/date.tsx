export function FormattedDate({ iso, locale }: { iso: string; locale: string }) {
  const date = new Date(iso);
  return (
    <time dateTime={iso}>
      {new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long' }).format(date)}
    </time>
  );
}
