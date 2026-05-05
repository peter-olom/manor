import { useEffect, useState } from "react";

const SAND_SPINNER_FRAMES = ["⠁", "⠂", "⠄", "⡀", "⡈", "⡐", "⡠", "⣀", "⣁", "⣂", "⣄", "⣌", "⣔", "⣤", "⣥", "⣦", "⣮", "⣶", "⣷", "⣿", "⡿", "⠿", "⢟", "⠟", "⡛", "⠛", "⠫", "⢋", "⠋", "⠍", "⡉", "⠉", "⠑", "⠡", "⢁"];
const SAND_SPINNER_INTERVAL_MS = 80;

export function SandSpinner() {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % SAND_SPINNER_FRAMES.length);
    }, SAND_SPINNER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="sand-spinner" aria-hidden="true">
      {SAND_SPINNER_FRAMES[frameIndex]}
    </span>
  );
}
