import type { ReactNode } from 'react';

/** The small line icons of the finding screen and its sheets: inline svg, hidden from assistive technology. */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="ap-svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  );
}

export const ChevronLeft = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>;
export const ChevronRight = () => <Icon><path d="m9 18 6-6-6-6" /></Icon>;
export const ChevronUp = () => <Icon><path d="m18 15-6-6-6 6" /></Icon>;
export const ChevronDown = () => <Icon><path d="m6 9 6 6 6-6" /></Icon>;
export const Crosshair = () => (
  <Icon size={14}>
    <circle cx="12" cy="12" r="10" />
    <path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" />
  </Icon>
);
export const MessageSquare = () => <Icon><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>;
export const FileText = () => (
  <Icon>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
  </Icon>
);
