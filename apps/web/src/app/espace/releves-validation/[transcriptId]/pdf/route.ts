import { proxyTranscriptPdf } from '@/lib/pdf-proxy';

/** Téléchargement d'un relevé émis, par le secrétariat académique. */
export async function GET(_req: Request, { params }: { params: Promise<{ transcriptId: string }> }) {
  const { transcriptId } = await params;
  return proxyTranscriptPdf(transcriptId, (id) => `/v1/transcripts/${id}/pdf`);
}
