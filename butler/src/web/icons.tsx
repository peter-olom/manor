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
        d="M6 2.5c-1.4 0-2.5 1.1-2.5 2.5v.4c-.9.3-1.5 1.1-1.5 2.1 0 .5.2 1 .5 1.4-.3.4-.5.9-.5 1.4 0 1 .6 1.8 1.5 2.1v.4c0 1.4 1.1 2.5 2.5 2.5.4 0 .7-.1 1-.2.3.1.6.2 1 .2 1.4 0 2.5-1.1 2.5-2.5v-.4c.9-.3 1.5-1.1 1.5-2.1 0-.5-.2-1-.5-1.4.3-.4.5-.9.5-1.4 0-1-.6-1.8-1.5-2.1V5c0-1.4-1.1-2.5-2.5-2.5-.4 0-.7.1-1 .2-.3-.1-.6-.2-1-.2Zm0 1.2c.3 0 .5.1.7.2v8.2c-.2-.1-.4-.2-.7-.2-.8 0-1.5.7-1.5 1.5v.4c-.7 0-1.3-.6-1.3-1.3v-.6l-.4-.2c-.5-.2-.8-.7-.8-1.2 0-.4.2-.7.4-1l.5-.5-.5-.5c-.2-.3-.4-.6-.4-1 0-.5.3-1 .8-1.2l.4-.2V5.7c0-.7.6-1.3 1.3-1.3.3 0 .5.1.7.2V12c.2.1.4.2.7.2Zm2 0c.2-.1.4-.2.7-.2.7 0 1.3.6 1.3 1.3v.6l.4.2c.5.2.8.7.8 1.2 0 .4-.2.7-.4 1l-.5.5.5.5c.2.3.4.6.4 1 0 .5-.3 1-.8 1.2l-.4.2v.6c0 .7-.6 1.3-1.3 1.3v-.4c0-.8-.7-1.5-1.5-1.5-.3 0-.5.1-.7.2V3.9Z"
        fill="currentColor"
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
        d="M3 5.5C3 4.7 3.7 4 4.5 4h7c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5h-7C3.7 12 3 11.3 3 10.5v-5Zm1.2.5v4l1.6-1.2 1.4 1 1.4-1 1.4 1 1.4-1 1.6 1.2V6H4.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function FileChangeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 2.5h7l3 3v8c0 .8-.7 1.5-1.5 1.5h-8.5C2.7 15 2 14.3 2 13.5v-9.5c0-.8.7-1.5 1.5-1.5H3Zm.2 1.2v9.6h8.6V6.3H9.2V3.7H3.2Zm7 0v1.6h1.6L10.2 3.7Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ToolIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M9.5 2.5a3.5 3.5 0 0 0-3.4 4.3l-4 4a1.4 1.4 0 0 0 2 2l4-4a3.5 3.5 0 0 0 4.3-3.4 3.5 3.5 0 0 0-.6-2l-2 2H7.6V3.1a3.5 3.5 0 0 0 1.9-.6Z"
        fill="currentColor"
      />
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
