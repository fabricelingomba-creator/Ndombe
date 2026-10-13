import { proxyTranscriptPdf } from '@/lib/pdf-proxy';

/** Téléchargement du relevé officiel par l'étudiant. */
export async function GET(_req: Request, { params }: { params: Promise<{ transcriptId: string }> }) {
  const { transcriptId } = await params;
  return proxyTranscriptPdf(transcriptId, (id) => `/v1/me/transcripts/${id}/pdf`);
}
