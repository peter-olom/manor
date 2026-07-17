export function StatusIcon({ kind }: { kind: "status" | "codex" | "auth" | "model" | "context" | "compaction" }) {
  if (kind === "status") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 8h2l1.5-3.5 3 7L11 8h2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
    );
  }

  if (kind === "auth") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 2.5 13 4.8v3.4c0 2.4-1.5 4.3-5 5.3-3.5-1-5-2.9-5-5.3V4.8L8 2.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="miter"
        />
      </svg>
    );
  }

  if (kind === "model") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 5.5h8M4 8h8M4 10.5h5M3 3.5h10v9H3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
    );
  }

  if (kind === "context") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2.5 8A5.5 5.5 0 0 1 8 2.5h4.5V7A5.5 5.5 0 0 1 7 12.5H2.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="miter"
        />
      </svg>
    );
  }

  if (kind === "compaction") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4.5h8M4 8h8M4 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="square"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3.5h4.5l1.5 2H13v7H3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function ThreadsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 4.5h8M4 8h8M4 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function FilesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4h4l1.3 1.5h5.7v7h-11z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function SetupTabIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.5v2M8 11.5v2M3.5 8h2M10.5 8h2M4.8 4.8l1.4 1.4M9.8 9.8l1.4 1.4M11.2 4.8 9.8 6.2M6.2 9.8l-1.4 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
      <circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function TerminalTabIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 3.5h11v9h-11zM5 6.2 7.2 8 5 9.8M8.5 9.8h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 11.8 3.6 14l2.2-.6 6.8-6.8-2.8-2.8L3 11.8ZM9.8 3.8l1-1a1.3 1.3 0 0 1 1.9 0l.5.5a1.3 1.3 0 0 1 0 1.9l-1 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 2.5v7M5.2 7.3 8 10.1l2.8-2.8M3.5 12.5h9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.8 3.5h10.4v9H2.8zM4.2 10.8 6.5 8.3l1.7 1.6 1.5-1.9 2.1 2.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="miter" />
      <circle cx="10.5" cy="6" r="1" fill="currentColor" />
    </svg>
  );
}

export function AttachmentIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.3 8.8 9.8 4.3a2.1 2.1 0 0 1 3 3l-5.4 5.4a3.3 3.3 0 0 1-4.7-4.7l5.1-5.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 3.5 13 8 3 12.5l1.1-4.1L9.2 8 4.1 7.6z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ZoomInIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4.8v4.4M4.8 7h4.4M10.2 10.2 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.8 7h4.4M10.2 10.2 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.5 4.5h9M6.2 2.5h3.6M5 4.5v7M8 4.5v7M11 4.5v7M4.5 4.5l.5 8h6l.5-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.8 9.8 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.5 4 11 8l-4.5 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M9.5 4 5 8l4.5 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function WarningIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 2.5 14 13H2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="miter" />
      <path d="M8 7v3M8 11.5h.01" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 5h10M3 8h10M3 11h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function BrainIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 3.7A2.3 2.3 0 0 0 3.7 5v.7a2.2 2.2 0 0 0-.4 3.8 2.2 2.2 0 0 0 1.9 3.3c1.2 0 2.2-1 2.2-2.2V3.9M8 3.7A2.3 2.3 0 0 1 12.3 5v.7a2.2 2.2 0 0 1 .4 3.8 2.2 2.2 0 0 1-1.9 3.3c-1.2 0-2.2-1-2.2-2.2V3.9M3.8 6.2h1.4M10.8 6.2h1.4M3.6 10h1.6M10.8 10h1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function JumpToLatestIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.5v8.2M4.5 7.5 8 11l3.5-3.5M3 13h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function CommandIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 3.5h11v9h-11zM5 6.2 7.2 8 5 9.8M8.5 9.8h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FileChangeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 2.5h6.5L13 6v7.5H3zM9.5 2.5V6H13M5.2 9h5.6M5.2 11.3h3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToolIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M10.2 2.7a3.2 3.2 0 0 0-3.1 4l-4.3 4.2a1.4 1.4 0 1 0 2 2l4.2-4.3a3.2 3.2 0 0 0 4-3.1l-2 1.2-1.7-.4-.4-1.7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SessionControlsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 4h3M8.5 4h5M2.5 8h6M11.5 8h2M2.5 12h1.5M7 12h6.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="4" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="8" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5.5" cy="12" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function DotIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}

export function AutomationIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 4.8V8l2.3 1.5M5.1 2.9 3.7 4.3M10.9 2.9l1.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CompletedAutomationIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 4.8V8l2.3 1.5M5.1 2.9 3.7 4.3M10.9 2.9l1.4 1.4M3 3l10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
