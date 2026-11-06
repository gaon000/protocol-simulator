import { useEffect, useRef, useState } from 'react';

/** Discard delayed worker replies and hide observations until the exact current query has completed. */
export function useStackQuery<T>(key: object | undefined, query: () => Promise<T>) {
  const [result, setResult] = useState<{ key: object; value?: T; error?: string }>();
  const latest = useRef(query);
  latest.current = query;
  useEffect(() => {
    if (!key) return;
    let current = true;
    void latest.current().then(
      (value) => {
        if (current) setResult({ key, value });
      },
      (error: unknown) => {
        if (current) setResult({ key, error: String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [key]);
  return result?.key === key ? result : undefined;
}
