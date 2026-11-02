import { useEffect, useRef, useState } from 'react';

/** Open and focus a diagram only on an explicit cross-panel navigation request. */
export function useDiagramPanel(request: number) {
  const ref = useRef<HTMLDetailsElement>(null);
  const handled = useRef(request);
  const [panel, setPanel] = useState({ open: false, request });
  const expanded = panel.request === request ? panel.open : true;
  useEffect(() => {
    if (handled.current === request) return;
    handled.current = request;
    ref.current?.querySelector('summary')?.focus();
    ref.current?.scrollIntoView({ block: 'start' });
  }, [request]);
  return { ref, expanded, onToggle: (open: boolean) => setPanel({ open, request }) };
}
