import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';

export interface OutgoingEmail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Canal e-mail. Une erreur levée par send() reprogramme l'envoi. */
export interface EmailTransport {
  readonly key: 'log' | 'smtp';
  send(email: OutgoingEmail): Promise<void>;
}

export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** Développement : le message est écrit dans le journal, rien ne part. */
export class LogEmailTransport implements EmailTransport {
  readonly key = 'log' as const;
  readonly sent: OutgoingEmail[] = [];
  private readonly logger = new Logger('E-mail');

  async send(email: OutgoingEmail) {
    this.sent.push(email);
    if (this.sent.length > 200) this.sent.shift();
    this.logger.log(`→ ${email.to} : ${email.subject}`);
  }
}

export class SmtpEmailTransport implements EmailTransport {
  readonly key = 'smtp' as const;
  private readonly transporter;

  constructor(url: string) {
    // TLS obligatoire : smtps:// (465) ou STARTTLS exigé sur 587.
    this.transporter = createTransport(url, { requireTLS: true, tls: { minVersion: 'TLSv1.2' } });
  }

  async send(email: OutgoingEmail) {
    await this.transporter.sendMail(email);
  }
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Retire les retours à la ligne d'un en-tête (sujet, nom d'expéditeur). */
export function headerSafe(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

export interface EmailContent {
  university: string;
  primaryColor: string;
  title: string;
  body: string;
  /** URL absolue vers le portail de l'université, ou null. */
  url: string | null;
  preferencesUrl: string;
}

/** Rend un e-mail sobre aux couleurs de l'université ; tout texte variable est échappé. */
export function renderEmail(c: EmailContent): { subject: string; text: string; html: string } {
  const color = /^#[0-9A-Fa-f]{6}$/.test(c.primaryColor) ? c.primaryColor : '#1D4ED8';
  const text = [
    c.title,
    '',
    c.body,
    ...(c.url ? ['', `Ouvrir : ${c.url}`] : []),
    '',
    '—',
    c.university,
    `Gérer vos notifications : ${c.preferencesUrl}`,
  ].join('\n');
  const button = c.url
    ? `<p style="margin:24px 0"><a href="${escapeHtml(c.url)}" style="background:${color};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Ouvrir dans mon espace</a></p>`
    : '';
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;border-top:4px solid ${color}">
<tr><td style="padding:24px">
<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escapeHtml(c.university)}</p>
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(c.title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.5;white-space:pre-line">${escapeHtml(c.body)}</p>
${button}
</td></tr></table>
<p style="font-size:12px;color:#6b7280;margin:16px 0 0"><a href="${escapeHtml(c.preferencesUrl)}" style="color:#6b7280">Gérer vos notifications</a></p>
</td></tr></table></body></html>`;
  return { subject: headerSafe(c.title), text, html };
}
