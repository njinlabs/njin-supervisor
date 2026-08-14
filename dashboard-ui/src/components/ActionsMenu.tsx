import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export type ActionMenuItem = { label: string; onClick: () => void; danger?: boolean };

export const ActionsMenu = ({ items }: { items: ActionMenuItem[] }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Rendered into a portal on document.body (see below) so it isn't clipped by an ancestor with
  // `overflow: hidden` (the client list's .card) — position is computed from the trigger button's
  // own viewport rect instead of relying on CSS positioning relative to an in-flow parent.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onViewportChange = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [open]);

  return (
    <div class="actions-menu">
      <button
        ref={triggerRef}
        type="button"
        class="actions-menu-trigger"
        aria-label="Actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={dropdownRef}
            class="actions-menu-dropdown"
            role="menu"
            style={{ top: `${position.top}px`, right: `${position.right}px` }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                class={`actions-menu-item${item.danger ? " danger" : ""}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
};
