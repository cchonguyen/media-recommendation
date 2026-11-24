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
| Status: Backlog | `clock` | neutral |
| Status: Up Next | `list-ordered` | mid |
| Status: Active | `play` | mid |
| Status: Paused | `pause` | warn |
| Status: Completed | `check` | good |
| Status: Abandoned | `x` | bad |
| Status: Archived | `archive` | neutral |
| Media type: Movie | `film` | neutral |
| Media type: TV | `tv` | neutral |
| Media type: Book | `book-open` | neutral |
| Media type: Game | `gamepad-2` | neutral |
| Media type: Podcast | `mic` | neutral |
| Media type: One-Off | `bookmark` | neutral |

## Departures
- (a) Four destinations plus a Library pill sub-nav, because the kit allows at most five and the app has nine screens.
- (b) The list editor is a dedicated route, not master-detail, because it is a full-page editor.
- (c) No web fonts on `/share/:slug`, because its CSP is `default-src 'none'` and is asserted by test.
- (d) Existing Title Case button labels from `SYSTEM_SPEC.md` 5.4 stay, because the owner named them.
- (e) Archive keeps a confirming Dialog, because the API can only restore an archived row to Backlog.
- (f) Tables stay dense inside a scroll box, because the data is tabular.
- (g) Kit CSS is copied into a generated TS module, because a Worker cannot read files at run time (the drift test guards it).
- (h) One primary button per view, so Sweep and Backup are plain buttons.
