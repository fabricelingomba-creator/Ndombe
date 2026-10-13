import PDFDocument from 'pdfkit';
import type { TranscriptSnapshot } from './transcript';

const PASSING_SCORE = 10;
const INK = '#111827';
const MUTED = '#4b5563';
const LINE = '#d1d5db';

const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const longDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' });

/** Texte lisible (blanc ou encre) sur la couleur de la marque. */
function textOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? INK : '#ffffff';
}

const COLUMNS = [
  { key: 'code', label: 'Code', width: 62, align: 'left' },
  { key: 'title', label: 'Intitulé', width: 223, align: 'left' },
  { key: 'credits', label: 'Crédits', width: 55, align: 'right' },
  { key: 'score', label: 'Note /20', width: 65, align: 'right' },
  { key: 'result', label: 'Résultat', width: 90, align: 'right' },
] as const;

/**
 * Relevé officiel au format A4. Tout ce qui est imprimé vient du contenu figé
 * (snapshot) : deux rendus d'un même relevé donnent le même document.
 */
export function renderTranscriptPdf(
  snapshot: TranscriptSnapshot,
  options: { primaryColor: string; contentHash: string },
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Relevé de notes – ${snapshot.student.fullName}`,
      Author: snapshot.university.name,
      Creator: 'Elongo',
      CreationDate: new Date(snapshot.issuedAt),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const brand = /^#[0-9a-f]{6}$/i.test(options.primaryColor) ? options.primaryColor : '#1D4ED8';

  // En-tête aux couleurs de l'université.
  doc.rect(0, 0, doc.page.width, 96).fill(brand);
  doc
    .fillColor(textOn(brand))
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(snapshot.university.name, left, 30, { width })
    .font('Helvetica')
    .fontSize(11)
    .text('Relevé de notes officiel', left, 56, { width });
  doc.y = 120;

  // Identité et références.
  const field = (label: string, value: string) => {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, left, doc.y, { continued: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(value, { width });
    doc.moveDown(0.4);
  };
  field('Étudiant', snapshot.student.fullName);
  field('Adresse e-mail', snapshot.student.email);
  field("Date d'émission", longDate.format(new Date(snapshot.issuedAt)));
  field('Code de vérification', snapshot.verificationCode);
  doc.moveDown(0.6);

  /** Vrai si une nouvelle page a été ouverte. */
  const ensureSpace = (needed: number) => {
    if (doc.y + needed <= doc.page.height - doc.page.margins.bottom - 40) return false;
    doc.addPage();
    doc.y = doc.page.margins.top;
    return true;
  };

  const row = (cells: Record<(typeof COLUMNS)[number]['key'], string>, bold = false, color = INK) => {
    const y = doc.y;
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    let height = 0;
    for (const col of COLUMNS) {
      doc.fillColor(col.key === 'result' && cells.result === 'Non validé' ? '#b91c1c' : color);
      doc.text(cells[col.key], x + 4, y + 5, { width: col.width - 8, align: col.align });
      height = Math.max(height, doc.y - y);
      x += col.width;
    }
    doc.y = y + height + 4;
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
  };

  if (snapshot.terms.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(MUTED).text('Aucune note publiée à la date d’émission.', left, doc.y);
  }

  // Les périodes, de la plus ancienne à la plus récente, comme un relevé papier.
  for (const term of [...snapshot.terms].reverse()) {
    ensureSpace(90);
    const heading = (title: string) => {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(brand).text(title, left, doc.y);
      doc.moveDown(0.3);
      row({ code: 'Code', title: 'Intitulé', credits: 'Crédits', score: 'Note /20', result: 'Résultat' }, true, MUTED);
    };
    heading(term.termName);
    for (const g of term.grades) {
      if (ensureSpace(24)) heading(`${term.termName} (suite)`);
      row({
        code: g.courseCode,
        title: g.courseTitle,
        credits: number.format(g.credits),
        score: number.format(g.score),
        result: g.score >= PASSING_SCORE ? 'Validé' : 'Non validé',
      });
    }
    doc
      .moveDown(0.4)
      .font('Helvetica')
      .fontSize(10)
      .fillColor(INK)
      .text(
        `Moyenne de la période : ${term.average === null ? '—' : `${number.format(term.average)}/20`}   ·   ` +
          `Crédits acquis : ${number.format(term.creditsEarned)}/${number.format(term.creditsAttempted)}`,
        left,
        doc.y,
        { width, align: 'right' },
      );
    doc.moveDown(1.2);
  }

  // Bilan cumulé.
  ensureSpace(70);
  const boxY = doc.y;
  doc.rect(left, boxY, width, 52).lineWidth(1).strokeColor(brand).stroke();
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text('Moyenne cumulée', left + 14, boxY + 10)
    .text('Crédits acquis', left + width / 2, boxY + 10);
  doc
    .font('Helvetica-Bold')
    .fontSize(15)
    .fillColor(INK)
    .text(snapshot.summary.average === null ? '—' : `${number.format(snapshot.summary.average)}/20`, left + 14, boxY + 24)
    .text(
      `${number.format(snapshot.summary.creditsEarned)}/${number.format(snapshot.summary.creditsAttempted)}`,
      left + width / 2,
      boxY + 24,
    );

  // Pied de page : vérification et numéro de page, sur chaque page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - doc.page.margins.bottom;
    // Écrire dans la marge basse sans déclencher de saut de page.
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        `Authenticité : ${snapshot.verifyUrl} · code ${snapshot.verificationCode}`,
        left,
        bottom + 14,
        { width: width - 60, lineBreak: false },
      )
      .text(`Empreinte SHA-256 : ${options.contentHash}`, left, bottom + 26, { width: width - 60, lineBreak: false })
      .text(`Page ${i - range.start + 1}/${range.count}`, left + width - 60, bottom + 14, { width: 60, align: 'right' });
    doc.page.margins.bottom = 60;
  }

  doc.end();
  return done;
}
