// A Fusion page's markdown: GitHub-flavoured markdown, with ```control blocks rendered as page controls,
// ```text blocks as formulas, and $$…$$ display maths shown as a formula block. `data` is the live data the
// page's controls asked for (src/lib/fusion/data.ts).

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseControl } from '@/lib/fusion/content';
import { NO_DATA, type FusionData } from '@/lib/fusion/data';
import { Control } from './controls';

type H = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

// `sub` is the heading level a "## " in the markdown becomes, one below the page title it sits under, so the
// document outline stays in order wherever the page is shown.
export default function Markdown({ body, file, data = NO_DATA, sub = 3 }: { body: string; file: string; data?: FusionData; sub?: 2 | 3 | 4 }) {
  const text = body.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `\n\`\`\`formula\n${tex.trim()}\n\`\`\`\n`);
  const h = (n: number) => `h${Math.min(6, n)}` as H;
  const H2 = h(sub), H3 = h(sub + 1), H4 = h(sub + 2);
  return (
    <div className="fu-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <H2 className="fu-md-h2">{children}</H2>,
          h2: ({ children }) => <H2 className="fu-md-h2">{children}</H2>,
          h3: ({ children }) => <H3 className="fu-md-h3">{children}</H3>,
          h4: ({ children }) => <H4 className="fu-md-h3">{children}</H4>,
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const lang = /language-(\w[\w-]*)/.exec(className ?? '')?.[1];
            const src = String(children ?? '').replace(/\n$/, '');
            if (lang === 'control') return <Control spec={parseControl(src, file)} data={data} />;
            if (lang === 'formula') return <pre className="fu-formula" aria-label="Formula"><code>{src}</code></pre>;
            if (lang) return <pre className="fu-code"><code>{src}</code></pre>;
            return <code className="fu-inline">{children}</code>;
          },
          table: ({ children }) => <div className="fu-table-wrap"><table className="fu-table">{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
