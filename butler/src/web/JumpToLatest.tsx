import { memo } from "react";

import { JumpToLatestIcon } from "./icons";

type JumpToLatestProps = {
  count: number;
  onClick: () => void;
};

export const JumpToLatest = memo(function JumpToLatest({ count, onClick }: JumpToLatestProps) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className="jump-to-latest"
      onClick={onClick}
      aria-label={`Jump to latest (${count} new)`}
    >
      <JumpToLatestIcon />
      <span>
        {count} new {count === 1 ? "message" : "messages"}
      </span>
    </button>
  );
});
