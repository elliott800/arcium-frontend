# content/fusion

The Macro analysis dashboard renders markdown pages from here (`content/fusion/<module>/*.md`, loaded by
`src/lib/fusion/content.ts`). The owner's research pages are kept private and are not in the public repository, so
the dashboard shows the sample page `macro/example.md` here.

To add a page, follow `content/fusion/macro/example.md`:

    ---
    title: Example
    module: macro
    order: 1
    summary: One line for the page list.
    status: live
    ---

    Your text. Live controls go in fenced `control` blocks (see src/modules/macro/view/controls.tsx).

The owner runs the site with `ARCIUM_PRIVATE_DIR` pointing at the private pages (`src/lib/private-content.ts`).
