import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';

type Kind = 'info' | 'success' | 'error';
interface ToastApi { show(message: string, kind?: Kind): void }
const Ctx = createContext<ToastApi>({ show: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string; kind: Kind }[]>([]);
  const show = useCallback((message: string, kind: Kind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { id, message, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5000);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg',
            t.kind === 'error' ? 'border-danger/30 bg-danger-soft text-danger' : t.kind === 'success' ? 'border-ok/30 bg-ok-soft text-ok' : 'border-border bg-surface text-fg')}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
