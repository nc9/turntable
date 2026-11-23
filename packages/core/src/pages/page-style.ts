// The stylesheet for pages the server renders itself. The tokens, radius and fonts are generated from
// packages/ui/src/styles.css by scripts/page-css.ts (Geist neutral, one blue), light and dark by
// prefers-color-scheme, so the pages need no script. It is a string in the source, so the compiled binary carries it.
import { PAGE_TOKENS_CSS } from "./page-tokens.generated";

export const PAGE_CSS = `@font-face{font-family:"Geist";src:url("/_pages/fonts/geist.woff2?v=__GEIST__") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono";src:url("/_pages/fonts/geist-mono.woff2?v=__GEIST_MONO__") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
${PAGE_TOKENS_CSS}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:15px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased}
.tt-header{display:flex;align-items:center;gap:.5rem;padding:.875rem 1.25rem;border-bottom:1px solid var(--border);background:var(--surface);font-weight:600;letter-spacing:-.01em}
.tt-mark{width:.75rem;height:.75rem;border-radius:50%;background:var(--fg)}
.tt-main{max-width:34rem;margin:0 auto;padding:2rem 1rem 3rem}
.tt-card{background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);padding:1.5rem}
h1{margin:0 0 1rem;font-size:1.375rem;line-height:1.25;font-weight:600;letter-spacing:-.02em}
p{margin:0 0 1rem}
a{color:var(--accent);overflow-wrap:anywhere}
strong{font-weight:600}
code,pre{font-family:var(--font-mono);font-size:.875em}
code{padding:.125rem .375rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-muted)}
pre{margin:1rem 0 0;padding:.75rem;overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-muted);line-height:1.5}
pre code{padding:0;border:0;background:none}
form{margin:0}
.tt-field{display:block;margin:0 0 1rem}
.tt-label{display:block;margin:0 0 .375rem;font-size:.875rem;font-weight:500}
.tt-check{display:flex;align-items:center;gap:.5rem;margin:0 0 1rem;font-size:.875rem}
input[type=text],input[type=password],input:not([type]){display:block;width:100%;height:2.5rem;padding:0 .75rem;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--fg);font:inherit}
input[type=checkbox]{width:1rem;height:1rem;margin:0;accent-color:var(--accent)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.tt-button{display:inline-flex;align-items:center;justify-content:center;height:2.5rem;padding:0 1rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:500;cursor:pointer}
.tt-button:hover{filter:brightness(.92)}
.tt-alert{margin:0 0 1rem;padding:.75rem 1rem;border:1px solid var(--danger);border-radius:var(--radius);background:var(--danger-bg);color:var(--danger)}
.tt-muted{color:var(--fg-muted)}
@media (max-width:480px){.tt-main{padding:1rem .75rem 2rem}.tt-card{padding:1.125rem}.tt-button{width:100%}}
`;
