export const APP_CSS = `/* app.css: Media Recommendation only. Loads after tokens.css and bundle.css. Never edit those. */
:root{--font-display:Newsreader,ui-serif,Georgia,serif}
[hidden]{display:none!important}
html{background:var(--bg)}
body{min-height:100dvh}
.ui-shell{min-height:100dvh}
.ui-sidebar{position:sticky;top:0;height:100dvh;overflow-y:auto}
.app-page{display:flex;flex-direction:column;gap:var(--space-6);width:100%;max-width:90rem;margin:0 auto}
.app-head{display:flex;flex-direction:column;gap:var(--space-2)}
.app-title{font-size:clamp(28px,5vw,40px)}
.app-h2{font-size:24px}
.app-section{display:flex;flex-direction:column;gap:var(--space-3)}
.app-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:var(--space-3)}
.app-list{display:flex;flex-direction:column;gap:var(--space-2);margin:0;padding:0;list-style:none}
.app-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-4)}
.app-row__title{flex:1;min-width:12rem;font-weight:600}
.app-row__title a{display:inline-flex;align-items:center;min-height:var(--touch-phone);color:var(--accent)}
.app-actions{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.app-form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-3)}
.app-form .ui-field{flex:1 1 12rem}
.app-stack{display:flex;flex-direction:column;gap:var(--space-3);width:100%}
.app-poster{width:56px;height:84px;object-fit:cover;border-radius:var(--radius-control);flex:none}
.app-card-row{display:flex;flex-wrap:wrap;gap:var(--space-3)}
.app-card-body{flex:1;min-width:10rem;display:flex;flex-direction:column;gap:var(--space-2)}
.app-facts{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3)}
.app-status{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-4)}
.app-status__grow{flex:1}
.app-notices{display:flex;flex-direction:column;gap:var(--space-2)}
.app-notices:empty{display:none}
.app-empty{margin:0}
.app-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.app-table caption{text-align:left;padding:var(--space-2) var(--space-3);color:var(--text-muted)}
.app-table th,.app-table td{padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;white-space:nowrap}
.app-table th{font:500 11px/16px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.app-table th a{display:inline-flex;align-items:center;gap:var(--space-1);min-height:var(--touch-phone);color:var(--text);text-decoration:none}
.app-table .ui-input{min-width:10rem}
.app-table .app-title-input{min-width:20rem}
.table-scroll.ui-card{padding:0}
.app-table .app-col-type{width:1%;text-align:center;padding-inline:var(--space-2)}
.app-table .app-col-sticky-right{position:sticky;right:0;z-index:var(--z-sticky);background:var(--surface);border-left:1px solid var(--line);text-align:center;width:1%;padding-inline:var(--space-2)}
.app-table thead .app-col-sticky-right{z-index:calc(var(--z-sticky) + 1)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.app-title-wrap{position:relative;display:inline-block}
.app-title-wrap::after{content:attr(data-tooltip);position:absolute;left:0;bottom:calc(100% + var(--space-1));z-index:var(--z-pop);background:var(--surface-raised);color:var(--text);border:1px solid var(--line);border-radius:var(--radius-card);box-shadow:var(--shadow-pop);padding:var(--space-1) var(--space-2);font-size:13px;line-height:1.35;white-space:normal;width:max-content;max-width:28rem;pointer-events:none;opacity:0;visibility:hidden;transition:opacity var(--duration-fast)}
.app-title-wrap:hover::after,.app-title-wrap:focus-within::after{opacity:1;visibility:visible}
.app-title-wrap[data-tooltip=""]::after{display:none}
.app-menu-wrap{position:relative;display:inline-flex;max-width:100%}
.app-form .app-menu-wrap,.app-stack .app-menu-wrap{display:flex;width:100%}
.app-menu-trigger{justify-content:flex-start;width:100%;font-weight:400;background:var(--surface-sunken);border-color:var(--line-strong)}
.app-menu-trigger__label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left}
.app-filter-menu{gap:var(--space-2)}
.app-floating-menu{position:fixed;z-index:var(--z-pop);max-height:60dvh;overflow-y:auto}
.app-floating-menu .ui-menu-item__check{margin-left:auto}
.app-status-select--mid{background:var(--mid);border-color:var(--mid-line);color:var(--mid-text)}
.app-status-select--good{background:var(--good-tint);border-color:var(--good);color:var(--good)}
.app-status-select--warn{background:var(--warn-tint);border-color:var(--warn);color:var(--warn)}
.app-status-select--bad{background:var(--bad-tint);border-color:var(--bad);color:var(--bad)}
.app-stars{flex:0 0 auto;display:inline-flex;align-items:center;gap:0}
.app-star{width:24px;height:var(--touch-phone);padding:0;color:var(--text-faint)}
.app-star:hover{background:transparent;color:var(--warn)}
.app-star--full,.app-star--half{color:var(--warn)}
.app-star--full svg{fill:currentColor}
.app-star__half-fill{fill:currentColor;stroke:none}
.app-pager{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3)}
.app-filter-chip{text-decoration:none}
.app-subnav{display:flex;gap:var(--space-2);overflow-x:auto;padding-bottom:var(--space-1)}
.app-subnav a.ui-pill{height:auto;min-height:var(--touch-phone);padding:0 var(--space-4);text-decoration:none}
.app-rank{min-width:2.5rem;justify-content:center}
.app-blurb{flex:2 1 12rem}
.app-blurb.ui-textarea{min-height:var(--touch-phone)}
.app-share{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.share-page{display:flex;flex-direction:column;gap:var(--space-6);max-width:44rem;margin:0 auto;padding:var(--space-6) var(--space-4)}
.share-item{display:flex;gap:var(--space-4)}
.share-rank{font:500 24px/1 var(--font-display);color:var(--text-muted);min-width:2rem}
.share-foot{max-width:44rem;margin:0 auto;padding:var(--space-4);border-top:1px solid var(--line);color:var(--text-muted);font-size:13px;line-height:19px}
@media (min-width:640px){.app-subnav a.ui-pill,.app-table th a,.app-row__title a{min-height:var(--touch-desktop)}.app-star{width:20px;height:var(--control-h-compact)}}
@media (max-width:639px){.ui-toasts{bottom:calc(var(--space-4) + 56px + env(safe-area-inset-bottom,0px))}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
