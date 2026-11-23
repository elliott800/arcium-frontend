// Macro analysis: the owner's macro pages (content/fusion/macro/*.md) — factors with level bands, sector
// rotation, charts, cycle probability — each rendered with its live data controls. ?page=<slug> picks one.
import { modulePages } from '@/lib/fusion/content';
import { dataFor } from '@/lib/fusion/data';
import LiveRefresh from './view/LiveRefresh';
import Markdown from './view/Markdown';
import type { ModuleProps } from '../registry';
import './view/charts.css';
import './view/fusion.css';

export default async function MacroModule({ searchParams }: ModuleProps) {
  const pages = modulePages('macro');
  const want = (await searchParams)?.page;
  const page = pages.find(p => p.slug === want) ?? pages[0];
  const data = page ? await dataFor([page], { embed: true }) : null;
  return (
    <div className="m-page">
      <div className="m-head"><h1>Macro analysis</h1>{page && <p>{page.title}</p>}
        {page && <span style={{ marginLeft: 'auto' }}>{/* eslint-disable-next-line react-hooks/purity -- a server component: the time this page was built */}
          <LiveRefresh renderedAt={Date.now()} /></span>}</div>
      {!pages.length && <div className="m-card m-empty">No pages in content/fusion/macro yet.</div>}
      <div className="macro-layout">
        <nav className="m-card macro-nav" aria-label="Macro pages">
          <ol>
            {pages.map(p => (
              <li key={p.slug}><a href={`/w/macro.analysis?page=${p.slug}`} aria-current={p.slug === page?.slug ? 'page' : undefined}>{p.title}</a>
                {p.status === 'data-pending' && <span className="m-badge warn">data pending</span>}</li>
            ))}
          </ol>
        </nav>
        {page && data && (
          <article className="m-card fu-page fu-page-solo">
            <p className="m-muted">{page.summary}</p>
            <Markdown body={page.body} file={page.file} data={data} sub={2} />
          </article>
        )}
      </div>
    </div>
  );
}
