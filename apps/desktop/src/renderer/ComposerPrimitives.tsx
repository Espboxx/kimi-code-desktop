import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { AlertCircle, X } from 'lucide-react';

import {
  clampComposerHeight,
  composerMaxHeight,
  MIN_COMPOSER_HEIGHT,
  parseComposerHeight,
  type ComposerAttachmentError,
} from './composer-utils';
import { classNames } from './ui-utils';

export interface ComposerAttachmentView {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly previewUrl?: string;
}

export function ComposerAttachmentList({ items, onRemove, ariaLabel, className, itemClassName }: {
  readonly items: readonly ComposerAttachmentView[];
  readonly onRemove: (id: string) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly itemClassName?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={classNames('composer-chips', className)} aria-label={ariaLabel}>
      {items.map((item) => (
        <span className={itemClassName} key={item.id} title={item.label}>
          {item.previewUrl === undefined
            ? item.icon
            : <img className="composer-attachment-preview" src={item.previewUrl} alt="" />}
          <span className="attachment-label">{item.label}</span>
          <button type="button" onClick={() => { onRemove(item.id); }} title={`移除 ${item.label}`}><X size={11} /></button>
        </span>
      ))}
    </div>
  );
}

export function ComposerErrorBanner({ error, onDismiss, className }: {
  readonly error?: ComposerAttachmentError;
  readonly onDismiss: () => void;
  readonly className?: string;
}) {
  if (error === undefined) return null;
  return (
    <div className={classNames('composer-attachment-error', className)} role="alert">
      <AlertCircle size={13} />
      <span><strong>{error.code}</strong>{error.message}</span>
      <button type="button" onClick={onDismiss} title="关闭"><X size={11} /></button>
    </div>
  );
}

interface ComposerFrameProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly heightStorageKey: string;
  readonly className?: string;
  readonly frameClassName?: string;
  readonly textareaRef?: Ref<HTMLTextAreaElement>;
  readonly above?: ReactNode;
  readonly status?: ReactNode;
  readonly toolbarStart?: ReactNode;
  readonly toolbarEnd?: ReactNode;
  readonly ariaLabel?: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onEscape?: () => void;
  readonly onPasteImages?: (files: readonly File[]) => void;
  readonly onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ComposerFrame(props: ComposerFrameProps) {
  const [editorHeight, setEditorHeight] = useState(() => initialEditorHeight(props.heightStorageKey));
  const editorHeightRef = useRef(editorHeight);
  const resizeDragRef = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startHeight: number;
  } | undefined>(undefined);

  const updateEditorHeight = useCallback((height: number, persist: boolean) => {
    const next = clampComposerHeight(height, window.innerHeight);
    editorHeightRef.current = next;
    setEditorHeight(next);
    if (!persist) return;
    try {
      window.localStorage.setItem(props.heightStorageKey, String(next));
    } catch {
      // A blocked storage backend should not disable resizing.
    }
  }, [props.heightStorageKey]);

  useEffect(() => {
    const next = initialEditorHeight(props.heightStorageKey);
    editorHeightRef.current = next;
    setEditorHeight(next);
  }, [props.heightStorageKey]);

  useEffect(() => {
    const onResize = () => {
      updateEditorHeight(editorHeightRef.current, false);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, [updateEditorHeight]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: editorHeightRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    updateEditorHeight(drag.startHeight + drag.startY - event.clientY, false);
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    resizeDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateEditorHeight(editorHeightRef.current, true);
  };

  const maxHeight = composerMaxHeight(window.innerHeight);
  return (
    <div className={classNames('composer-wrap', props.className)}>
      {props.above}
      <div
        className={classNames('composer', props.disabled && 'disabled', props.frameClassName)}
        style={{ '--composer-editor-height': `${String(editorHeight)}px` } as CSSProperties}
      >
        <div
          className="composer-resize-handle"
          role="separator"
          aria-label="调整输入框高度"
          aria-orientation="horizontal"
          aria-valuemin={MIN_COMPOSER_HEIGHT}
          aria-valuemax={maxHeight}
          aria-valuenow={editorHeight}
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => {
            let next: number | undefined;
            if (event.key === 'ArrowUp') next = editorHeightRef.current + (event.shiftKey ? 24 : 8);
            if (event.key === 'ArrowDown') next = editorHeightRef.current - (event.shiftKey ? 24 : 8);
            if (event.key === 'Home') next = MIN_COMPOSER_HEIGHT;
            if (event.key === 'End') next = maxHeight;
            if (next === undefined) return;
            event.preventDefault();
            updateEditorHeight(next, true);
          }}
        ><span /></div>
        <textarea
          ref={props.textareaRef}
          value={props.value}
          disabled={props.disabled}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel}
          rows={2}
          onChange={(event) => { props.onChange(event.target.value); }}
          onPaste={(event) => {
            if (props.onPasteImages === undefined) return;
            const files = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (files.length === 0) return;
            if (event.clipboardData.getData('text/plain').length === 0) event.preventDefault();
            props.onPasteImages(files);
          }}
          onKeyDown={(event) => {
            props.onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              props.onSubmit();
            } else if (event.key === 'Escape') {
              props.onEscape?.();
            }
          }}
        />
        {props.status !== undefined && <div className="composer-status-toolbar">{props.status}</div>}
        {(props.toolbarStart !== undefined || props.toolbarEnd !== undefined) && (
          <div className="composer-toolbar">
            <div className="composer-toolbar-start">{props.toolbarStart}</div>
            <div className="composer-actions">{props.toolbarEnd}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function initialEditorHeight(storageKey: string): number {
  try {
    return parseComposerHeight(window.localStorage.getItem(storageKey), window.innerHeight);
  } catch {
    return parseComposerHeight(null, window.innerHeight);
  }
}
