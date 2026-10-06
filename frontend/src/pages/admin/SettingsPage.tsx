import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryError } from '../../lib/query';
import { listGradingSchemes } from '../../lib/repos/academic';
import { getSettings, saveSettings } from '../../lib/repos/admin';
import { getProviderStatus } from '../../lib/repos/storage';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select, TextInput } from '../../components/ui/Field';
import { Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, ErrorState, LoadingState } from '../../components/ui/States';
import { useCrudMutation } from '../../components/admin/useCrudMutation';

/**
 * Application settings.
 *
 * Only non-secret configuration lives here and is editable. Whether an OCR
 * credential is present is reported as a boolean by the `ocr-providers` Edge
 * Function, so an administrator can verify a deployment without any value ever
 * crossing the boundary.
 */

/**
 * What `ocr-providers` actually answers with.
 *
 * `getProviderStatus()` declares only the `{name, configured}` subset, which is all
 * the retired screen needed. The function also returns a display `label`, an
 * `active` marker, a `capabilities` block and top-level `activeProviderLabel` /
 * `activeProviderConfigured`. The repo layer is out of scope here, so the extra
 * fields are described locally and every one of them is read defensively — the
 * table still renders if a deployment answers with the narrower payload.
 */
interface ProviderStatus {
  name: string;
  label?: string;
  configured: boolean;
  active?: boolean;
  capabilities?: {
    boundingBoxes: boolean;
    multiPage: boolean;
    maxPages: number;
    maxFileBytes: number;
    formats: string[];
  };
}

interface ProviderStatusResponse {
  providers: ProviderStatus[];
  activeProvider: string;
  activeProviderLabel?: string;
  /** False means every upload will fail with a 503 — worth shouting about. */
  activeProviderConfigured?: boolean;
}

const fetchProviderStatus = async (): Promise<ProviderStatusResponse> =>
  (await getProviderStatus()) as ProviderStatusResponse;

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const [schoolName, setSchoolName] = useState('');
  const [activeSchemeId, setActiveSchemeId] = useState('');
  const [lockRequiresReason, setLockRequiresReason] = useState('true');
  const [importMaxRows, setImportMaxRows] = useState('5000');

  const { data: settings, isLoading, error, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const { data: gradingSchemes } = useQuery({
    queryKey: ['grading-schemes'],
    queryFn: () => listGradingSchemes(),
    staleTime: 5 * 60_000,
  });

  const { data: providerStatus } = useQuery({
    queryKey: ['ocr-providers'],
    queryFn: fetchProviderStatus,
    staleTime: 5 * 60_000,
    // The function only answers for a signed-in user, and a failure here is a
    // missing banner rather than a broken screen.
    retry: false,
  });

  useEffect(() => {
    if (!settings) return;
    setSchoolName(settings['school.name'] ?? '');
    setActiveSchemeId(settings['active_grading_scheme_id'] ?? '');
    setLockRequiresReason(settings['marks.lock_requires_reason'] ?? 'true');
    setImportMaxRows(settings['import.max_rows'] ?? '5000');
  }, [settings]);

  const save = useCrudMutation<void, void>({
    mutationFn: () =>
      // `settings.value` is a text column, so the numeric row cap is stored as
      // its string form rather than as a JSON number.
      saveSettings({
        'school.name': schoolName,
        'active_grading_scheme_id': activeSchemeId,
        'marks.lock_requires_reason': lockRequiresReason,
        'import.max_rows': String(Number(importMaxRows) || 5000),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['grading-schemes'] });
    },
    successMessage: 'Settings saved',
  });

  if (isLoading) return <LoadingState label="Loading settings…" />;
  if (error instanceof QueryError) {
    return <ErrorState message={error.userMessage} onRetry={() => void refetch()} />;
  }
  if (!settings) return null;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">
          Environment: <Badge>{import.meta.env.MODE}</Badge>
        </h1>
      </header>

      {providerStatus?.activeProviderConfigured === false && (
        <Alert tone="warning" title="The active OCR provider is not configured">
          Every upload will fail until{' '}
          <code>{providerStatus.activeProviderLabel ?? providerStatus.activeProvider}</code> has its
          credentials set. Nothing else on this screen can substitute for it.
        </Alert>
      )}

      <Card>
        <CardHeader
          title="General"
          description="Shown across the application and used by reports."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="School name"
            value={schoolName}
            onChange={(event) => setSchoolName(event.target.value)}
          />

          <Select
            label="Active grading scheme"
            value={activeSchemeId}
            onChange={(event) => setActiveSchemeId(event.target.value)}
            options={(gradingSchemes ?? []).map((scheme) => ({ value: scheme.id, label: scheme.name }))}
            hint="Used for every grade calculation."
          />

          <Select
            label="Locked-mark corrections"
            value={lockRequiresReason}
            onChange={(event) => setLockRequiresReason(event.target.value)}
            options={[
              { value: 'true', label: 'Require a written reason' },
              { value: 'false', label: 'Reason optional' },
            ]}
            hint="Strongly recommended to keep this on."
          />

          <TextInput
            label="Maximum import rows"
            type="number"
            min={1}
            value={importMaxRows}
            onChange={(event) => setImportMaxRows(event.target.value)}
            hint="Files with more rows are rejected before parsing."
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save settings
          </Button>
        </div>
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="OCR providers"
            description="Only the configured provider is usable. Credentials are Edge Function secrets and never leave the server."
          />
        </div>

        <Table caption="OCR providers">
          <THead>
            <tr>
              <TH>Provider</TH>
              <TH>Status</TH>
              <TH>Boxes</TH>
              <TH>Multi-page</TH>
              <TH>Preprocessing</TH>
              <TH>Formats</TH>
            </tr>
          </THead>
          <TBody>
            {(providerStatus?.providers ?? []).map((provider) => (
              <TR key={provider.name}>
                <TD className="font-medium text-ink">{provider.label ?? provider.name}</TD>
                <TD>
                  {provider.configured ? (
                    <ToneBadge tone="success">Configured</ToneBadge>
                  ) : (
                    <ToneBadge tone="neutral">Not configured</ToneBadge>
                  )}
                </TD>
                <TD className="text-ink-muted">
                  {provider.capabilities?.boundingBoxes ? 'Yes' : 'No'}
                </TD>
                <TD className="text-ink-muted">
                  {provider.capabilities?.multiPage ? 'Yes' : 'No'}
                </TD>
                {/* The function reports no server-side preprocessing capability,
                    so there is nothing truthful to put here. */}
                <TD className="text-ink-muted">—</TD>
                <TD className="text-xs text-ink-subtle">
                  {(provider.capabilities?.formats ?? []).join(', ')}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <div className="border-t border-line p-5">
          <Alert tone="info" title="Switching provider">
            Set <code>OCR_PROVIDER</code> as an Edge Function secret to change provider. Documents
            already processed keep the provider that produced them.
          </Alert>
        </div>
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Secrets"
            description="Presence only — the values cannot be read back through the API."
          />
        </div>
        <Table caption="Configured secrets">
          <THead>
            <tr>
              <TH>Secret</TH>
              <TH>Status</TH>
            </tr>
          </THead>
          <TBody>
            {/* Supabase Edge Function secrets are deliberately unreadable through any
                client API, so there is no honest way to report a secret inventory
                from here. The per-provider `configured` flags in the table above
                cover the OCR keys, which are the ones that actually affect
                uploads; everything else must be checked with `supabase secrets
                list` on the server. */}
            <TR>
              <TD className="tabular font-medium text-ink">Edge Function secrets</TD>
              <TD>
                <ToneBadge tone="neutral">Not reported</ToneBadge>
              </TD>
            </TR>
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
