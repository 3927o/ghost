import ghostMark from '../assets/ghost.svg'

const paths = {
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  chat: <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12 4 4 10-10" />,
  tool: <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14" />,
  // Copied verbatim from design-system/index.html (#i-alert, #i-warning, #i-stop) — 0.4 state icons.
  alert: <><path d="M10.3 4.2 2.6 17.6a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4.5M12 17.2v.1" /></>,
  warning: <><path d="M12 2.8 21.2 12 12 21.2 2.8 12Z" /><path d="M12 8v4.6M12 15.8v.1" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
}

export function Icon({ name, small = false }: { name: keyof typeof paths; small?: boolean }) {
  return <svg className={`g-icon${small ? ' g-icon--small' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
    {paths[name]}
  </svg>
}

export function GhostMark() {
  return <img className="g-mark" src={ghostMark} alt="" aria-hidden="true" />
}
