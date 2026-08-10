import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { classNames } from './ui-utils';

export function NavigationSidebar({ className, ariaLabel, children }: {
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
}) {
  return <aside className={classNames('navigation-sidebar', className)} aria-label={ariaLabel}>{children}</aside>;
}

export function NavigationSidebarHeader({ icon, title, subtitle, action, onSelect, className, titleClassName }: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly action?: ReactNode;
  readonly onSelect?: () => void;
  readonly className?: string;
  readonly titleClassName?: string;
}) {
  const content = <>{icon}<span><strong>{title}</strong><small>{subtitle}</small></span></>;
  return (
    <header className={classNames('navigation-sidebar-header', className)}>
      {onSelect === undefined
        ? <div className={classNames('navigation-sidebar-title', titleClassName)}>{content}</div>
        : <button className={classNames('navigation-sidebar-title', titleClassName)} type="button" onClick={onSelect}>{content}</button>}
      {action}
    </header>
  );
}

export function NavigationSection({ title, count, open, onToggle, action, className, children }: {
  readonly title: string;
  readonly count?: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={classNames('navigation-section', !open && 'collapsed', className)}>
      <div className="navigation-section-heading section-heading">
        <button type="button" onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>
          {count !== undefined && <em>{count}</em>}
        </button>
        {action}
      </div>
      {open && children}
    </section>
  );
}

export function NavigationRow({
  className,
  mainClassName,
  copyClassName,
  actionsClassName,
  title,
  subtitle,
  selected = false,
  open = false,
  active = false,
  busy = false,
  trailing,
  actions,
  revealActions = false,
  ariaLabel,
  onSelect,
}: {
  readonly className?: string;
  readonly mainClassName?: string;
  readonly copyClassName?: string;
  readonly actionsClassName?: string;
  readonly title: string;
  readonly subtitle: string;
  readonly selected?: boolean;
  readonly open?: boolean;
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly trailing?: ReactNode;
  readonly actions?: ReactNode;
  readonly revealActions?: boolean;
  readonly ariaLabel?: string;
  readonly onSelect: () => void;
}) {
  return (
    <div className={classNames(
      'navigation-row',
      selected && 'selected',
      open && 'open-tab',
      revealActions && 'reveal-actions',
      className,
    )}>
      <button
        className={classNames('navigation-row-main', mainClassName)}
        type="button"
        aria-label={ariaLabel}
        onClick={onSelect}
      >
        <span className={classNames('session-presence', (active || busy) && 'active', busy && 'busy')} />
        <span className={classNames('navigation-row-copy', copyClassName)}>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        {trailing}
      </button>
      {actions !== undefined && (
        <div className={classNames('navigation-row-actions', actionsClassName)}>{actions}</div>
      )}
    </div>
  );
}

export function SidePanelFrame({ className, ariaLabel, header, open = true, bodyClassName, children }: {
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly header: ReactNode;
  readonly open?: boolean;
  readonly bodyClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <aside className={classNames('side-panel', open && 'open', !open && 'collapsed', className)} aria-label={ariaLabel}>
      <div className="side-panel-header">{header}</div>
      {open && <div className={classNames('side-panel-body', bodyClassName)}>{children}</div>}
    </aside>
  );
}
