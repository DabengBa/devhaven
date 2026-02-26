import { useEffect, useRef } from "react";

export type CommandPaletteItem = {
  id: string;
  title: string;
  subtitle?: string;
  group?: string;
};

type CommandPaletteProps = {
  isOpen: boolean;
  query: string;
  items: CommandPaletteItem[];
  activeIndex: number;
  onQueryChange: (value: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelectItem: (item: CommandPaletteItem) => void;
  onClose: () => void;
};

/** 全局命令面板，支持键盘搜索与执行。 */
export default function CommandPalette({
  isOpen,
  query,
  items,
  activeIndex,
  onQueryChange,
  onActiveIndexChange,
  onSelectItem,
  onClose,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (items.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        onActiveIndexChange((activeIndex + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        onActiveIndexChange((activeIndex - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onSelectItem(items[activeIndex] ?? items[0]);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [activeIndex, isOpen, items, onActiveIndexChange, onClose, onSelectItem]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-[rgba(0,0,0,0.45)] p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
    >
      <div
        className="flex max-h-[70vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-border bg-card-bg shadow-[0_18px_40px_rgba(0,0,0,0.35)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-divider px-3 py-2.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索命令（项目 / 脚本 / 筛选）..."
            className="w-full border-none bg-transparent text-[14px] text-text outline-none placeholder:text-search-placeholder"
          />
        </div>
        {items.length === 0 ? (
          <div className="px-4 py-8 text-center text-fs-caption text-secondary-text">没有匹配的命令</div>
        ) : (
          <div className="overflow-y-auto">
            {items.map((item, index) => (
              <button
                key={item.id}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors ${
                  index === activeIndex ? "bg-[rgba(69,59,231,0.16)]" : "hover:bg-[rgba(255,255,255,0.05)]"
                }`}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => onSelectItem(item)}
              >
                <span className="mt-[2px] inline-block min-w-[56px] text-[11px] font-semibold text-accent/90">
                  {item.group ?? "命令"}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-semibold text-text">{item.title}</span>
                  {item.subtitle ? (
                    <span className="truncate text-fs-caption text-secondary-text">{item.subtitle}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="border-t border-divider px-4 py-2 text-[11px] text-secondary-text">
          ↑/↓ 选择 · Enter 执行 · Esc 关闭
        </div>
      </div>
    </div>
  );
}

