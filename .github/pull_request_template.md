<!-- Every pull request is reviewed by the owner on the Branch reviews page, with the demo agent's screenshots and
     videos of the screens it touches. Fill this in so that review is quick. -->

## What changes for the person using the site
<!-- One or two sentences in plain words: what they see or can do now. -->

## Screens touched
<!-- Dashboard ids (e.g. factory.silos) or public pages. The demo agent works this out too; say if it should show more. -->

## Release 1 task
<!-- r1.x.y from the schedule, or "none". -->

## How it was tested
- [ ] `npm run check` passes (0 errors)
- [ ] `npm run test:gui` against my dev server on the demo database
- [ ] New or changed behaviour has a feature in `tests/gui/features.mjs`
- [ ] No tokens, passwords or production addresses in the change (they live only in arcium production site)
- [ ] The hooks contract is unchanged, or `contract/hooks.json` was updated with it (and the reason is above)
