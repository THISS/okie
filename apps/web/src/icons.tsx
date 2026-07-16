import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 18, children, ...props }: IconProps) {
  return <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>{children}</svg>;
}

export function SearchIcon(props: IconProps) { return <IconBase {...props}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/><path d="m16.2 16.2 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"/></IconBase>; }
export function SparkIcon(props: IconProps) { return <IconBase {...props}><path d="m12 2 1.5 5.2L19 9l-5.5 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" fill="currentColor"/></IconBase>; }
export function ShareIcon(props: IconProps) { return <IconBase {...props}><circle cx="18" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.7"/><circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.7"/><circle cx="18" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.7"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5" stroke="currentColor" strokeWidth="1.7"/></IconBase>; }
export function CodeIcon(props: IconProps) { return <IconBase {...props}><path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 3l-4 18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
export function CloseIcon(props: IconProps) { return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"/></IconBase>; }
export function ChevronIcon(props: IconProps) { return <IconBase {...props}><path d="m9 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></IconBase>; }
export function ZoomInIcon(props: IconProps) { return <IconBase {...props}><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="M10.5 7.5v6M7.5 10.5h6M15.4 15.4 21 21" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7"/></IconBase>; }
export function ZoomOutIcon(props: IconProps) { return <IconBase {...props}><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="M7.5 10.5h6M15.4 15.4 21 21" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7"/></IconBase>; }
export function FitIcon(props: IconProps) { return <IconBase {...props}><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
export function PlayIcon(props: IconProps) { return <IconBase {...props}><path d="m8 5 11 7-11 7V5Z" fill="currentColor"/></IconBase>; }
export function PauseIcon(props: IconProps) { return <IconBase {...props}><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/></IconBase>; }
export function RestartIcon(props: IconProps) { return <IconBase {...props}><path d="M4.5 9A8 8 0 1 1 4 14M4.5 9V4M4.5 9h5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
export function CheckIcon(props: IconProps) { return <IconBase {...props}><path d="m5 12 4.3 4.2L19 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></IconBase>; }
export function FileIcon(props: IconProps) { return <IconBase {...props}><path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6"/><path d="M14 3v5h4M9 12h6M9 16h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"/></IconBase>; }
export function ImageIcon(props: IconProps) { return <IconBase {...props}><rect height="15" rx="2" stroke="currentColor" strokeWidth="1.6" width="18" x="3" y="4.5"/><circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" strokeWidth="1.5"/><path d="m4 17 5-4.5 4 3 3-2.5 4 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6"/></IconBase>; }
export function ActivityIcon(props: IconProps) { return <IconBase {...props}><path d="M3 12h4l2.2-6 4 12 2-6H21" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
export function LayersIcon(props: IconProps) { return <IconBase {...props}><path d="m12 3 9 5-9 5-9-5 9-5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6"/></IconBase>; }
export function ArrowIcon(props: IconProps) { return <IconBase {...props}><path d="M5 12h14M14 7l5 5-5 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
export function InfoIcon(props: IconProps) { return <IconBase {...props}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6"/><path d="M12 11v6M12 7.2v.1" stroke="currentColor" strokeLinecap="round" strokeWidth="2"/></IconBase>; }
export function PanelIcon(props: IconProps) { return <IconBase {...props}><rect height="16" rx="2" stroke="currentColor" strokeWidth="1.6" width="18" x="3" y="4"/><path d="M15 4v16" stroke="currentColor" strokeWidth="1.6"/></IconBase>; }
