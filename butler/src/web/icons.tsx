export function StatusIcon({ kind }: { kind: "codex" | "auth" | "model" | "context" | "compaction" }) {
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

export function ThemeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.5v2.1M8 11.4v2.1M3.8 4.1l1.5 1.5M10.7 10.4l1.5 1.5M2.5 8h2.1M11.4 8h2.1M3.8 11.9l1.5-1.5M10.7 5.6l1.5-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 7.3 13.2 2.8l-3.9 10.4-2.1-3.1-3.2-1.2 9.2-4.5-9.7 2.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function AttachmentIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6 8.5 10.8 3.7a2.25 2.25 0 1 1 3.2 3.2l-6 6a3.25 3.25 0 1 1-4.6-4.6l5.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.5v7M5 7.5 8 10.5l3-3M3.5 13.5h9"
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

export function ImageIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 3.5h11v9h-11zM4.5 10l2.2-2.2 1.7 1.7 1.4-1.4 2.2 2.2M5.5 6h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M5 2.5A1.5 1.5 0 0 1 6.5 1h6A1.5 1.5 0 0 1 14 2.5v7A1.5 1.5 0 0 1 12.5 11h-1v1.5A1.5 1.5 0 0 1 10 14h-6A1.5 1.5 0 0 1 2.5 12.5v-7A1.5 1.5 0 0 1 4 4h1V2.5Zm1 1.5h4A1.5 1.5 0 0 1 11.5 5.5V10h1a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-6a.5.5 0 0 0-.5.5V4Zm-2 .999a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-6Z"
      />
    </svg>
  );
}

export function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v8M4.5 8.5 8 12l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

export function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 9.5 8 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
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

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}
