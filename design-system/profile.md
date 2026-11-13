# Design profile: Media Recommendation Tracker

## Identity
- Accent: `azure`.
- Density: `comfortable`.
- Voice warmth: `plain`.
- Theme: dark first, follows the device. No `theme-lock`.
- Display face: Newsreader through `--font-display` (kit default, restated in `app-css.ts`). Loaded on the private app only.

## States
| State | Icon | Tone |
| --- | --- | --- |
| Pending enrichment | `clock` | mid |
| Failed enrichment | `alert-circle` | bad |
| Failed count zero | none | neutral |
| Media type | none | neutral pill |

## Departures
- (a) Four destinations plus a Library pill sub-nav, because the kit allows at most five and the app has nine screens.
- (b) The list editor is a dedicated route, not master-detail, because it is a full-page editor.
- (c) No web fonts on `/share/:slug`, because its CSP is `default-src 'none'` and is asserted by test.
- (d) Existing Title Case button labels from `SYSTEM_SPEC.md` 5.4 stay, because the owner named them.
- (e) Archive keeps a confirming Dialog, because the API can only restore an archived row to Backlog.
- (f) Tables stay dense inside a scroll box, because the data is tabular.
- (g) Kit CSS is copied into a generated TS module, because a Worker cannot read files at run time (the drift test guards it).
- (h) One primary button per view, so Sweep and Backup are plain buttons.
