import type { PageId } from '@shared/types';

export const NAV_ICONS: Record<PageId, string> = {
  home: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 9.5L10 3.5l7 6V16.5a1 1 0 01-1 1h-4v-5H8v5H4a1 1 0 01-1-1V9.5z"/></svg>`,
  play: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="5.5,3.5 16.5,10 5.5,16.5" fill="currentColor" fill-opacity="0.18"/></svg>`,
  mods: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 2.5L17 6.5v7L10 17.5 3 13.5v-7L10 2.5z"/><path d="M10 10l7-3.5M10 10v7.5M10 10L3 6.5"/></svg>`,
  performance: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M11 2.5L4.5 11h5l-1 6.5L15.5 9h-5L11 2.5z"/></svg>`,
  graphics: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M3 14.5l4.5-4 3.5 3 2.5-2 3.5 3"/></svg>`,
  shaders: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4"/></svg>`,
  resourcepacks: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 3L2.5 7 10 11l7.5-4L10 3z"/><path d="M2.5 10.5L10 14.5l7.5-4"/><path d="M2.5 14L10 18l7.5-4"/></svg>`,
  accounts: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="6.8" r="3.2"/><path d="M3.5 17c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/></svg>`,
  profiles: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/><circle cx="7.5" cy="5.5" r="1.7" fill="#0E121A"/><circle cx="13" cy="10" r="1.7" fill="#0E121A"/><circle cx="8.5" cy="14.5" r="1.7" fill="#0E121A"/></svg>`,
  settings: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="2.7"/><path d="M10 2.5l1 2 2.2.4.9-1.8 1.6 1.6-1.8.9.4 2.2 2 1v2.4l-2 1-.4 2.2 1.8.9-1.6 1.6-1-.9-2.1.4-1 2H8.8l-1-2-2.2-.4-.9 1.8-1.6-1.6 1.8-.9-.4-2.2-2-1V8.8l2-1 .4-2.2-1.8-.9L5.7 3l.9 1.8 2.2-.4 1-1.9z"/></svg>`,
  diagnostics: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.5 10.5h3.2l2-5.5 3.6 10 2.2-4.5h4"/></svg>`,
  about: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.3v.2"/></svg>`,
};

export function escapeHtml(str: string | number | null | undefined): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
