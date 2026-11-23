'use client';

// Keeps a Fusion data page current: re-reads its data from the server every `every` seconds while the page is
// visible (and at once on coming back to it), without reloading the page. `renderedAt` is when the server built
// the data now on screen, so the label shows the data's age, not the timer's.

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useNow } from '@/ui/kit';
import { useRouter } from 'next/navigation';

export default function LiveRefresh({ renderedAt, every = 60 }: { renderedAt: number; every?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [pending, start] = useTransition();
  const now = useNow(5000);                             // re-renders the age label
  const last = useRef(renderedAt);
  useEffect(() => { last.current = renderedAt; }, [renderedAt]);

  const refresh = useCallback(() => start(() => router.refresh()), [router]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - last.current >= every * 1000) refresh();
    }, 5000);
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - last.current >= every * 1000) refresh(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, [paused, every, refresh]);

  const age = Math.max(0, Math.round((now - renderedAt) / 1000));
  const at = new Date(renderedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="fu-live" role="status" aria-live="off">
      <span className={`fu-live-dot${paused ? ' off' : pending ? ' busy' : ''}`} aria-hidden="true" />
      <span>{paused ? 'Paused' : pending ? 'Updating…' : 'Live'} · data as of {at}{age >= 90 ? ` (${Math.round(age / 60)} min ago)` : ''}</span>
      <button type="button" onClick={refresh} disabled={pending}>Refresh</button>
      <button type="button" onClick={() => setPaused(p => !p)} aria-pressed={paused}>{paused ? 'Resume' : 'Pause'}</button>
    </div>
  );
}
