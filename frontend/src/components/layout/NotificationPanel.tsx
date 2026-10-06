import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from '../../lib/repos/admin';
import { cn, formatRelative } from '../../lib/utils';
import { Spinner } from '../ui/States';

/**
 * Notification dropdown.
 *
 * The shape is deliberately channel-agnostic (`type`, `title`, `body`, `link`,
 * `data`) so an email or webhook channel can be added server-side later without
 * touching this component.
 */
export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => listNotifications(15),
    refetchInterval: 60_000,
  });

  // Close on outside click or Escape — expected popover behaviour.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const markRead = useMutation({
    mutationFn: (ids: string[]) => markNotificationsRead(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const items = data ?? [];
  const unread = items.filter((item) => !item.read).length;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface shadow-popover animate-fade-in"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Notifications</p>
          {unread > 0 && (
            <p className="tabular text-xs text-ink-subtle">
              {unread} unread
            </p>
          )}
        </div>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="rounded-lg px-2 py-1 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-50"
          >
            {markAllRead.isPending ? 'Marking…' : 'Mark all read'}
          </button>
        )}
      </div>

      <div className="max-h-96 overflow-y-auto scrollbar-thin">
        {isLoading && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-ink-subtle">
            You have no notifications yet. Marks events will appear here.
          </p>
        )}

        <ul className="divide-y divide-line-soft">
          {items.map((item) => {
            const body = (
              <>
                <div className="flex items-start gap-2">
                  {!item.readAt && (
                    <span
                      aria-label="Unread"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-sm',
                        item.readAt ? 'text-ink' : 'font-medium text-ink',
                      )}
                    >
                      {item.title}
                    </p>
                    {item.body && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{item.body}</p>
                    )}
                    <p className="mt-1 text-[11px] text-ink-faint">
                      {formatRelative(item.createdAt)}
                    </p>
                  </div>
                </div>
              </>
            );

            return (
              <li key={item.id}>
                {item.link ? (
                  <Link
                    to={item.link}
                    onClick={() => {
                      if (!item.readAt) markRead.mutate([item.id]);
                      onClose();
                    }}
                    className="block px-4 py-3 transition-colors hover:bg-surface-muted"
                  >
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => !item.readAt && markRead.mutate([item.id])}
                    className="block w-full px-4 py-3 text-left transition-colors hover:bg-surface-muted"
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

