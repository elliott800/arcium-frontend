// A dashboard designed but not built yet: its plan (content/planned/<plan>.md), so the method and content
// are at hand when it is built. Archived dashboards keep their code in
// arcium_simulation/arcium_feature_archive/<plan>/code.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ModuleDef } from './registry';
import { privatePath } from '@/lib/private-content';

export default async function Planned({ def }: { def: ModuleDef }) {
  const file = privatePath(`planned/${def.plan ?? ''}.md`, path.join(process.cwd(), 'content', 'planned', `${def.plan ?? ''}.md`));
  const text = def.plan ? await readFile(file, 'utf8').catch(() => '') : '';
  return (
    <div className="m-page">
      <div className="m-head">
        <h1>{def.title}</h1><span className="m-badge warn">planned</span>
        <p>{def.summary}</p>
      </div>
      <article className="m-card m-prose">
        {text ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          : <p className="m-muted">No plan written yet.</p>}
      </article>
      {def.plan?.startsWith('fusion-') && (
        <p className="m-muted">Archived code: <code>arcium_simulation/arcium_feature_archive/{def.plan}/code</code></p>
      )}
    </div>
  );
}
