import { requireCaller } from '../_shared/auth.ts';
import { handle, json } from '../_shared/http.ts';

/**
 * Report which OCR providers are configured.
 *
 * Replaces `GET /api/ocr/providers/status`. The Settings screen uses it to show
 * which provider is live without a page needing any credentials of its own.
 *
 * ── Tesseract is not really a provider here ───────────────────────────────────
 * Recognition runs in the browser (see `ocr-process`), so this function cannot
 * report whether it is *available* — nothing about tesseract.js depends on this
 * deployment. What it does report is that the server-side vendors are absent,
 * which is still worth knowing, and it lists the browser engine so the settings
 * page and the upload screen describe the system that actually runs.
 *
 * Only booleans cross this boundary. The retired Worker had the same rule, and it
 * is worth stating why: "configured" is enough for an administrator to know who to
 * call, and a leak of "is this exact key set" is a small but real confirmation that
 * a credential is live in production.
 */

interface ProviderStatus {
  name: string;
  configured: boolean;
  /** Display label for the settings page. */
  label: string;
  /** What this provider can and cannot do, for the UI. */
  capabilities: {
    boundingBoxes: boolean;
    multiPage: boolean;
    maxPages: number;
    maxFileBytes: number;
    formats: string[];
  };
  /** The provider named in OCR_PROVIDER, whether or not it is configured. */
  active: boolean;
}

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      // Any signed-in user may see this: the upload screen tells them what the
      // system can read, and there is nothing sensitive in a boolean. What is
      // sensitive — the keys themselves — never leaves this function.
      void caller;

      const active = (Deno.env.get('OCR_PROVIDER') ?? 'manual').toLowerCase();

      const providers: ProviderStatus[] = [
        {
          // Listed first because it is the one the school actually uses, and it
          // is always available: it needs no credential, so `configured` is true
          // by construction rather than by optimism.
          name: 'tesseract',
          label: 'Tesseract.js (in this browser)',
          configured: true,
          capabilities: {
            boundingBoxes: true,
            multiPage: true,
            maxPages: 20,
            maxFileBytes: 10 * 1024 * 1024,
            formats: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
          },
          // Reported active unless an administrator has deliberately pinned a
          // vendor, so a fresh install does not look misconfigured.
          active: active === 'manual' || active === 'tesseract' || active === '',
        },
        {
          name: 'google',
          label: 'Google Cloud Vision',
          configured: Boolean(Deno.env.get('GOOGLE_VISION_API_KEY')),
          capabilities: {
            boundingBoxes: true,
            multiPage: true,
            maxPages: 15,
            maxFileBytes: 10 * 1024 * 1024,
            formats: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
          },
          active: active === 'google',
        },
        {
          name: 'azure',
          label: 'Azure AI Vision',
          configured: Boolean(
            Deno.env.get('AZURE_VISION_ENDPOINT') && Deno.env.get('AZURE_VISION_KEY'),
          ),
          capabilities: {
            boundingBoxes: true,
            multiPage: true,
            maxPages: 100,
            maxFileBytes: 20 * 1024 * 1024,
            formats: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
          },
          active: active === 'azure',
        },
        {
          name: 'textract',
          label: 'AWS Textract',
          configured: Boolean(
            Deno.env.get('AWS_TEXTRECT_ACCESS_KEY_ID') &&
              Deno.env.get('AWS_TEXTRECT_SECRET_ACCESS_KEY') &&
              Deno.env.get('AWS_REGION'),
          ),
          capabilities: {
            // DetectDocumentText returns line-level boxes only, so the parser
            // cannot use geometry for grouping.
            boundingBoxes: false,
            multiPage: false,
            maxPages: 1,
            maxFileBytes: 10 * 1024 * 1024,
            formats: ['image/jpeg', 'image/png'],
          },
          active: active === 'textract',
        },
      ];

      // Falls back to the browser engine rather than to the old `manual` entry.
      // `manual` used to be reported as a provider and it extracted nothing,
      // which is precisely why OCR appeared broken: a fresh install named a
      // working provider that returned zero rows. Dropping it means the list now
      // only contains engines that can actually read a mark sheet.
      const activeProvider = providers.find((p) => p.active) ?? providers[0]!;

      return json({
        providers,
        activeProvider: activeProvider.name,
        activeProviderLabel: activeProvider.label,
        // Worth surfacing explicitly: an active provider that is not configured
        // means every upload will fail with a 503.
        activeProviderConfigured: activeProvider.configured,
      });
    }),
);