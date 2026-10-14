import { loadEnv } from '../config/env';
import { formatDate, messages } from './catalog';
import { escapeHtml, headerSafe, renderEmail } from './email';
import { MAX_ATTEMPTS, retryDelayMinutes } from './notification-dispatcher';

describe('Catalogue des notifications', () => {
  it('formate dates et montants en français, sans décalage de fuseau', () => {
    expect(formatDate('2026-12-01')).toBe('1 décembre 2026');
    const n = messages.invoiceDueSoon('f1', { feeName: 'Minerval', amountMinor: '125050', currency: 'CDF', dueOn: '2026-12-15' });
    expect(n.title).toBe('Rappel : Minerval à régler avant le 15 décembre 2026');
    expect(n.body).toMatch(/1\s250,50\sCDF/);
    expect(n.dedupKey).toBe('invoice.due_soon:f1');
  });

  it('tronque les textes saisis trop longs', () => {
    const n = messages.bankSlipRejected(100, 'USD', 'x'.repeat(900));
    expect(n.body.length).toBeLessThan(600);
    expect(messages.announcement('a', 't'.repeat(300), 'b').title).toHaveLength(200);
  });
});

describe('E-mail', () => {
  const base = {
    university: 'Université <script>',
    primaryColor: '#123456',
    title: 'Titre "x" & <b>',
    body: 'Ligne 1\nLigne 2',
    url: 'https://u.example/espace?a=1&b=2',
    preferencesUrl: 'https://u.example/espace/notifications',
  };

  it('échappe tout texte variable dans le HTML', () => {
    const { subject, html, text } = renderEmail(base);
    expect(subject).toBe('Titre "x" & <b>');
    expect(html).toContain('Université &lt;script&gt;');
    expect(html).toContain('Titre &quot;x&quot; &amp; &lt;b&gt;');
    expect(html).toContain('href="https://u.example/espace?a=1&amp;b=2"');
    expect(html).not.toContain('<script>');
    expect(text).toContain('Ouvrir : https://u.example/espace?a=1&b=2');
  });

  it("n'accepte qu'une couleur hexadécimale et retire les sauts de ligne des en-têtes", () => {
    expect(renderEmail({ ...base, primaryColor: 'red;background:url(x)' }).html).toContain('#1D4ED8');
    expect(renderEmail({ ...base, title: 'A\r\nBcc: x@y.z' }).subject).toBe('A Bcc: x@y.z');
    expect(headerSafe(' Nom\nX ')).toBe('Nom X');
    expect(escapeHtml(`<'">&`)).toBe('&lt;&#39;&quot;&gt;&amp;');
  });
});

describe("Nouvel essai d'envoi", () => {
  it('espace les essais puis abandonne', () => {
    expect([1, 2, 3, 4].map(retryDelayMinutes)).toEqual([1, 5, 30, 120]);
    expect(retryDelayMinutes(MAX_ATTEMPTS)).toBeNull();
  });
});

describe('Configuration des e-mails', () => {
  const base = {
    DATABASE_URL: 'postgres://a@b/c',
    PLATFORM_DATABASE_URL: 'postgres://a@b/c',
    KEYCLOAK_URL: 'https://auth.example',
  };

  it('interdit le journal en production et exige SMTP_URL pour smtp', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', EMAIL_TRANSPORT: 'log' })).toThrow(/interdit en production/);
    expect(() => loadEnv({ ...base, EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_URL requis/);
    expect(() => loadEnv({ ...base, EMAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtps://u:p@smtp.example:465' })).not.toThrow();
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).not.toThrow();
  });
});
