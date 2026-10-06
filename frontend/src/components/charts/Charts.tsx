import { useMemo, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SubmissionStatus } from '@school/shared';
import { SUBMISSION_STATUS_STYLES } from '../../lib/utils';

/**
 * Charts.
 *
 * Recharts is loaded only on the pages that need it (routes are lazy), and each
 * chart is wrapped in a `ResponsiveContainer` with a fixed height so the layout
 * does not jump while measuring. Colours are duplicated in text labels and
 * tooltips, never relied on alone.
 */

/* -------------------------------------------------------------------------- */
/* Shared tooltip                                                              */
/* -------------------------------------------------------------------------- */

interface TooltipPayloadEntry {
  name?: string | number;
  value?: string | number;
  color?: string;
  payload?: Record<string, unknown>;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-popover">
      {label !== undefined && (
        <p className="mb-1 text-xs font-medium text-ink">{String(label)}</p>
      )}
      <ul className="space-y-0.5">
        {payload.map((entry, index) => (
          <li key={index} className="flex items-center gap-2 text-xs text-ink">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.name ? `${entry.name}: ` : ''}
            <span className="tabular font-medium">{String(entry.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mark sheets by status                                                       */
/* -------------------------------------------------------------------------- */

export function StatusBarChart({
  data,
}: {
  data: Array<{ status: SubmissionStatus; count: number }>;
}) {
  const chartData = useMemo(
    () =>
      data
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          name: SUBMISSION_STATUS_STYLES[entry.status]?.label ?? entry.status,
          count: entry.count,
          fill: BAR_COLORS[entry.status] ?? '#94a3b8',
        })),
    [data],
  );

  if (chartData.length === 0) {
    return <ChartEmpty message="No mark sheets have been created yet." />;
  }

  return (
    <div className="h-64" role="img" aria-label="Mark sheets by workflow status">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56}>
            {chartData.map((entry, index) => (
              <Cell key={index} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const BAR_COLORS: Record<SubmissionStatus, string> = {
  DRAFT: '#94a3b8',
  SUBMITTED: '#f59e0b',
  UNDER_REVIEW: '#0ea5e9',
  APPROVED: '#10b981',
  LOCKED: '#8b5cf6',
  RETURNED: '#f97316',
  REJECTED: '#f43f5e',
};

/* -------------------------------------------------------------------------- */
/* Grade distribution                                                          */
/* -------------------------------------------------------------------------- */

const GRADE_COLORS = ['#10b981', '#22c55e', '#0ea5e9', '#38bdf8', '#f59e0b', '#f97316', '#f43f5e'];

export function GradeDistributionChart({
  data,
}: {
  data: Array<{ grade: string; count: number }>;
}) {
  const chartData = useMemo(
    () =>
      data.map((entry, index) => ({
        name: entry.grade,
        value: entry.count,
        fill: GRADE_COLORS[index % GRADE_COLORS.length],
      })),
    [data],
  );

  const total = chartData.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="h-56" role="img" aria-label="Grade distribution pie chart">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={2}
              stroke="none"
            >
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
            <Legend
              verticalAlign="bottom"
              height={28}
              iconType="circle"
              iconSize={8}
              formatter={(value: string) => <span className="text-xs text-ink-muted">{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* A table is the accessible equivalent of the chart. */}
      <ul className="space-y-1.5 self-center">
        {chartData.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: entry.fill }}
            />
            <span className="w-8 shrink-0 font-medium text-ink">{entry.name}</span>
            <span className="tabular w-10 shrink-0 text-right text-ink">{entry.value}</span>
            <span className="tabular text-xs text-ink-subtle">
              {total > 0 ? `${((entry.value / total) * 100).toFixed(0)}%` : '0%'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Submission trend                                                            */
/* -------------------------------------------------------------------------- */

export function SubmissionTrendChart({
  data,
}: {
  data: Array<{ label: string; value: number }>;
}) {
  if (data.every((point) => point.value === 0)) {
    return <ChartEmpty message="No mark sheets created in this period." />;
  }

  return (
    <div className="h-56" role="img" aria-label="Mark sheets created per day">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} />
          <Line
            type="monotone"
            dataKey="value"
            name="Sheets"
            stroke="#3366f2"
            strokeWidth={2}
            dot={{ r: 2.5, fill: '#3366f2' }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Subject average marks                                                       */
/* -------------------------------------------------------------------------- */

export function SubjectAverageChart({
  data,
}: {
  data: Array<{ subjectName: string; average: number | null }>;
}) {
  const chartData = useMemo(
    () =>
      data
        .filter((entry) => entry.average !== null)
        .map((entry) => ({
          subject: entry.subjectName.length > 14 ? `${entry.subjectName.slice(0, 13)}…` : entry.subjectName,
          average: entry.average,
        })),
    [data],
  );

  if (chartData.length === 0) {
    return <ChartEmpty message="No marks have been entered yet." />;
  }

  return (
    <div className="h-64" role="img" aria-label="Average marks by subject">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="subject" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} interval={0} angle={-20} textAnchor="end" height={56} />
          <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="average" name="Average marks" fill="#1f47dd" radius={[4, 4, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function ChartEmpty({ message }: { message: string }): ReactNode {
  return (
    <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface-muted px-4 text-center">
      <p className="text-sm text-ink-subtle">{message}</p>
    </div>
  );
}