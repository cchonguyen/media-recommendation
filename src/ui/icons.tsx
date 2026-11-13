// Icon paths are lucide (ISC licence), copied by hand. No runtime dependency.
import { raw } from "hono/html";

const PATHS = {
  "play": '<polygon points="6 3 20 12 6 21 6 3"/>',
  "library": '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  "archive": '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  "list-ordered": '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  "film": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "check": '<path d="M20 6 9 17l-5-5"/>',
  "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "alert-circle": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  "pause": '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
  "copy": '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  "trash": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {raw(PATHS[props.name])}
    </svg>
  );
}

// Hex values copied from .harness/design-system/tokens.css (dark):
// #67aafe = --neon-azure, #14121f = --on-accent. Only hex allowed in .tsx files.
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#67aafe"/>' +
  '<g transform="translate(4 4)" fill="none" stroke="#14121f" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  PATHS.film +
  "</g></svg>";

export const FAVICON_HREF = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);
