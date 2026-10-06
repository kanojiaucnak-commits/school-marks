import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GradingRule, GradingScheme } from '@school/shared';
import { QueryError } from '../../lib/query';
import {
  listGradingSchemes,
  saveGradingScheme,
  setDefaultGradingScheme,
} from '../../lib/repos/academic';
import { cn } from '../../lib/utils';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TextInput } from '../../components/ui/Field';
import { Card, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { IconPlus, IconTrash } from '../../components/ui/icons';

/**
 * Grading schemes.
 *
 * Nothing about grades is hard-coded anywhere in the application — every grade a
 * student receives comes from a scheme row in Postgres. Bands must not overlap and
 * must together cover 0–100; the overlap check below runs in the browser for
 * immediate feedback and `save_grading_scheme()` rejects an invalid set in one
 * transaction, so a half-applied band set is not a state the database can be in.
 */
export default function GradingPage() {
  const queryClient = useQueryClient();
  const { success } = useToast();
  const [editing, setEditing] = useState<GradingScheme | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['grading-schemes'],
    queryFn: () => listGradingSchemes(),
  });

  /**
   * Moving the default flag is its own operation.
   *
   * It must never be routed through `saveGradingScheme`: that path deletes every
   * rule and reinserts whatever it is handed, so passing the existing bands back
   * would rewrite them (and passing an empty list would wipe them).
   */
  const setActive = useCrudMutation<void, string>({
    mutationFn: (id) => setDefaultGradingScheme(id),
    invalidates: [['grading-schemes']],
    successMessage: 'Scheme set as the active grading system',
  });

  const schemes = data ?? [];
  /** "Active" is the default flag — there is no separate concept server-side. */
  const activeId = schemes.find((scheme) => scheme.isDefault)?.id;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Percentage bands that turn marks into grades. The active scheme is used everywhere.
          </h1>
        </div>
        <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
          New scheme
        </Button>
      </header>

      {isLoading && <LoadingState label="Loading grading schemes…" />}
      {error instanceof QueryError && (
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
      )}

      {!isLoading && schemes.length === 0 && (
        <EmptyState
          title="No grading schemes"
          description="A default scheme is normally created by the database migration."
          icon="🏅"
        />
      )}

      {schemes.map((scheme) => {
        const isActive = scheme.id === activeId;
        const sorted = [...scheme.rules].sort((a, b) => a.minPercentage - b.minPercentage);

        return (
          <Card key={scheme.id} flush>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-ink">{scheme.name}</h2>
                  {isActive ? <ToneBadge tone="success">Active</ToneBadge> : null}
                </div>
                {scheme.description && (
                  <p className="mt-0.5 text-sm text-ink-muted">{scheme.description}</p>
                )}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => setEditing(scheme)}>
                  Edit bands
                </Button>
                {!isActive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={setActive.isPending}
                    onClick={() => setActive.mutate(scheme.id)}
                  >
                    Make active
                  </Button>
                )}
              </div>
            </div>

            {sorted.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-subtle">
                No grade bands configured.
              </p>
            ) : (
              <Table caption={`Grade bands for ${scheme.name}`}>
                <THead>
                  <tr>
                    <TH>Grade</TH>
                    <TH numeric>From %</TH>
                    <TH numeric>To %</TH>
                    <TH numeric>Grade point</TH>
                    <TH>Result</TH>
                  </tr>
                </THead>
                <TBody>
                  {sorted.map((rule) => (
                    <TR key={rule.id}>
                      <TD>
                        <Badge tone="accent">{rule.grade}</Badge>
                      </TD>
                      <TD numeric className="tabular text-ink">
                        {rule.minPercentage}
                      </TD>
                      <TD numeric className="tabular text-ink">
                        {rule.maxPercentage}
                      </TD>
                      <TD numeric className="tabular text-ink-muted">
                        {rule.gradePoint ?? '—'}
                      </TD>
                      <TD>
                        <ToneBadge tone={rule.isPass ? 'success' : 'danger'}>
                          {rule.isPass ? 'Pass' : 'Fail'}
                        </ToneBadge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        );
      })}

      <Modal
        open={creating || Boolean(editing)}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'New grading scheme'}
        description="Bands must cover 0 to 100 and must not overlap."
        busy={false}
        size="lg"
      >
        <SchemeEditor
          scheme={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['grading-schemes'] });
            success('Grading scheme saved');
            setCreating(false);
            setEditing(null);
          }}
        />
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

interface DraftRule {
  grade: string;
  minPercentage: string;
  maxPercentage: string;
  gradePoint: string;
  isPass: boolean;
}

function SchemeEditor({
  scheme,
  onClose,
  onSaved,
}: {
  scheme: GradingScheme | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(scheme?.name ?? '');
  const [description, setDescription] = useState(scheme?.description ?? '');
  const [rules, setRules] = useState<DraftRule[]>(() =>
    (scheme?.rules ?? []).map((rule: GradingRule) => ({
      grade: rule.grade,
      minPercentage: String(rule.minPercentage),
      maxPercentage: String(rule.maxPercentage),
      gradePoint: rule.gradePoint === null ? '' : String(rule.gradePoint),
      isPass: rule.isPass,
    })),
  );

  const validation = useMemo(() => {
    const sorted = [...rules]
      .map((rule) => ({
        ...rule,
        min: Number(rule.minPercentage),
        max: Number(rule.maxPercentage),
      }))
      .filter((rule) => Number.isFinite(rule.min) && Number.isFinite(rule.max))
      .sort((a, b) => a.min - b.min);

    if (sorted.length === 0) return { valid: false, message: 'Add at least one grade band.' };

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) return { valid: false, message: 'Add at least one grade band.' };

    if (first.min !== 0) return { valid: false, message: 'The lowest band must start at 0.' };
    if (last.max !== 100) return { valid: false, message: 'The highest band must end at 100.' };

    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (!previous || !current) continue;
      if (current.min <= previous.max) {
        return {
          valid: false,
          message: `${previous.grade} (to ${previous.max}%) overlaps ${current.grade} (from ${current.min}%).`,
        };
      }
      // The server rejects a hole the same way it rejects an overlap, and this is the
      // feedback the teacher gets before the request ever leaves the editor: a gap of
      // exactly 0.01 is fine because percentages are stored on a two-decimal grid.
      if (current.min - previous.max > 0.0100001) {
        return {
          valid: false,
          message: `${previous.grade} (to ${previous.max}%) leaves a gap before ${current.grade} (from ${current.min}%).`,
        };
      }
    }

    return { valid: true, message: '' };
  }, [rules]);

  const save = useCrudMutation<
    string,
    void
  >({
    mutationFn: () =>
      saveGradingScheme({
        id: scheme?.id ?? null,
        name: name.trim(),
        description: description.trim() || null,
        // The scheme's existing default flag is carried through rather than
        // forced to false: `save_grading_scheme` writes `p_is_default`
        // unconditionally, so a hard-coded false would silently stand down the
        // active scheme every time its bands were edited.
        isDefault: scheme?.isDefault ?? false,
        rules: rules.map((rule) => ({
          grade: rule.grade.trim(),
          minPercentage: Number(rule.minPercentage),
          maxPercentage: Number(rule.maxPercentage),
          gradePoint: rule.gradePoint === '' ? null : Number(rule.gradePoint),
          isPass: rule.isPass,
        })),
      }),
    // No `invalidates` here: `onSaved` already refreshes the list and toasts.
    onSuccess: onSaved,
  });

  const canSave = name.trim().length >= 2 && validation.valid && !save.isPending;

  return (
    <div className="space-y-4">
      {save.fieldError && (
        <Alert tone="danger" onDismiss={save.clearFieldError}>{save.fieldError}</Alert>
      )}

      <TextInput
        label="Scheme name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Standard Percentage"
        required
      />

      <TextInput
        label="Description (optional)"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-ink">Grade bands</p>
          <Button
            size="sm"
            icon={<IconPlus size={14} />}
            onClick={() =>
              setRules((current) => [
                ...current,
                { grade: '', minPercentage: '', maxPercentage: '', gradePoint: '', isPass: true },
              ])
            }
          >
            Add band
          </Button>
        </div>

        <div className="overflow-x-auto rounded-lg border border-line scrollbar-thin">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <caption className="sr-only">Grade bands</caption>
            <thead className="border-b border-line bg-surface-muted">
              <tr>
                <th scope="col" className="px-2 py-2 text-xs font-semibold uppercase text-ink-muted">Grade</th>
                <th scope="col" className="px-2 py-2 text-xs font-semibold uppercase text-ink-muted">From %</th>
                <th scope="col" className="px-2 py-2 text-xs font-semibold uppercase text-ink-muted">To %</th>
                <th scope="col" className="px-2 py-2 text-xs font-semibold uppercase text-ink-muted">Points</th>
                <th scope="col" className="px-2 py-2 text-xs font-semibold uppercase text-ink-muted">Pass</th>
                <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rules.map((rule, index) => (
                <tr key={index}>
                  <td className="px-2 py-1.5">
                    <input
                      value={rule.grade}
                      onChange={(event) =>
                        setRules((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, grade: event.target.value } : item,
                          ),
                        )
                      }
                      className="h-8 w-16 rounded border border-line-strong px-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-200"
                      aria-label={`Grade label for band ${index + 1}`}
                    />
                  </td>
                  {(['minPercentage', 'maxPercentage', 'gradePoint'] as const).map((field) => (
                    <td key={field} className="px-2 py-1.5">
                      <input
                        type="number"
                        value={rule[field]}
                        onChange={(event) =>
                          setRules((current) =>
                            current.map((item, i) =>
                              i === index ? { ...item, [field]: event.target.value } : item,
                            ),
                          )
                        }
                        className="tabular h-8 w-20 rounded border border-line-strong px-2 text-right text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-200"
                        aria-label={`${field} for band ${index + 1}`}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={rule.isPass}
                      onChange={(event) =>
                        setRules((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, isPass: event.target.checked } : item,
                          ),
                        )
                      }
                      aria-label={`${rule.grade} counts as a pass`}
                      className="h-4 w-4 rounded border-line-strong text-brand-600"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setRules((current) => current.filter((_, i) => i !== index))
                      }
                      aria-label={`Remove band ${index + 1}`}
                      className="rounded p-1 text-ink-faint hover:bg-danger-50 hover:text-danger-600"
                    >
                      <IconTrash size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!validation.valid ? (
          <Alert tone="warning" className={cn('mt-2')}>
            {validation.message}
          </Alert>
        ) : (
          <p className="mt-2 text-xs text-success-700">
            Bands cover 0–100 with no gaps or overlaps.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
          Save scheme
        </Button>
      </div>
    </div>
  );
}
