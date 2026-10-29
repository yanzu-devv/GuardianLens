import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './launch-intro.css';

const INTRO_MS = 2100;

export function LaunchIntro({ children, urgent }: { children: ReactNode; urgent: boolean }) {
  // Utility windows must be ready immediately, including when first opened hidden.
  const [finished, setFinished] = useState(() => ['quick', 'checkin'].includes(new URLSearchParams(location.search).get('view') || ''));
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const visible = !finished && !urgent;
  const contentRef = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(visible);

  useLayoutEffect(() => {
    // A dialog may have tried to focus before its inert ancestor was revealed.
    if (wasVisible.current && !visible && urgent) {
      contentRef.current?.querySelector<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] a[href]')?.focus({ preventScroll: true });
    }
    wasVisible.current = visible;
  }, [visible, urgent]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    // Keep the app mounted and connected throughout; an incident ends the intro.
    if (urgent) setFinished(true);
  }, [urgent]);

  useEffect(() => {
    if (!visible) return;
    // Also finish if animation events are suppressed or a background tab pauses CSS.
    const timeout = window.setTimeout(() => setFinished(true), reducedMotion ? 500 : INTRO_MS + 100);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFinished(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('keydown', onKey);
    };
  }, [visible, reducedMotion]);

  return <div className={`launch-experience${visible ? ' is-introducing' : ''}`} style={{ '--intro-duration': `${INTRO_MS}ms` } as CSSProperties}>
    <div ref={contentRef} className="launch-content" inert={visible} aria-hidden={visible || undefined}>{children}</div>
    {visible && <section className="launch-intro" aria-label="GuardianLens introduction" onAnimationEnd={event => {
      if (event.target === event.currentTarget && event.animationName === 'guardian-intro-backdrop') setFinished(true);
    }}>
      <div className="launch-brand">
        <img className="launch-mark" src="/logo.svg" width="112" height="112" alt="" />
        <p className="launch-wordmark">Guardian<span>Lens</span></p>
      </div>
      <button className="launch-skip" onClick={() => setFinished(true)}>Skip intro <span aria-hidden="true">↗</span></button>
    </section>}
  </div>;
}
