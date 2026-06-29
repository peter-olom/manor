export const DEFAULT_AFTER_ACTION_PAUSE_MS = 220;

const DEFAULT_POINTER_PAUSE_MS = 120;
const DEFAULT_KEY_DELAY_MS = 45;
const DEFAULT_SCROLL_STEP_PAUSE_MS = 90;
const DEFAULT_SCROLL_STEP_PIXELS = 360;

export function requireScreenshotLabel(value) {
  const label = String(value || "").trim();
  if (!label) throw new Error("Captured screenshots require a worker-supplied label.");
  return label;
}

export function requireScreenshotFileName(value) {
  const fileName = String(value || "").trim();
  if (!fileName) throw new Error("Captured screenshots require a worker-supplied fileName.");
  if (fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") throw new Error("Screenshot fileName must be a plain file name.");
  if (!fileName.toLowerCase().endsWith(".png")) throw new Error("Screenshot fileName must end in .png.");
  return fileName;
}

function actionDelay(input, fallback) {
  return typeof input.delayMs === "number" && Number.isFinite(input.delayMs)
    ? Math.max(0, Math.trunc(input.delayMs))
    : fallback;
}

export async function shortPause(page, ms = DEFAULT_AFTER_ACTION_PAUSE_MS) {
  if (ms > 0) {
    await page.waitForTimeout(ms);
  }
}

function getPointer(session) {
  if (session.pointer && Number.isFinite(session.pointer.x) && Number.isFinite(session.pointer.y)) {
    return session.pointer;
  }
  return {
    x: Math.round(session.viewport.width / 2),
    y: Math.round(session.viewport.height / 2)
  };
}

export async function movePointer(session, targetX, targetY, options = {}) {
  const pointer = getPointer(session);
  const distance = Math.hypot(targetX - pointer.x, targetY - pointer.y);
  const steps = Math.max(8, Math.min(36, Math.ceil(distance / 45)));
  await session.page.mouse.move(targetX, targetY, { steps });
  session.pointer = { x: targetX, y: targetY };
  await shortPause(session.page, options.pauseMs ?? DEFAULT_POINTER_PAUSE_MS);
}

export async function locatorPoint(locator, timeoutMs) {
  await locator.waitFor({ state: "visible", timeout: timeoutMs ?? 15_000 });
  await locator.scrollIntoViewIfNeeded(timeoutMs ? { timeout: timeoutMs } : undefined);
  await locator.click({ ...(timeoutMs ? { timeout: timeoutMs } : {}), trial: true });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Target element has no visible bounding box.");
  }
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2)
  };
}

export async function humanClickLocator(session, locator, timeoutMs, options = {}) {
  const point = await locatorPoint(locator, timeoutMs);
  await movePointer(session, point.x, point.y);
  await session.page.mouse.down({ button: options.button ?? "left" });
  await shortPause(session.page, options.holdMs ?? 70);
  await session.page.mouse.up({ button: options.button ?? "left" });
  await shortPause(session.page);
}

export async function humanTypeText(session, text, input) {
  const delay = actionDelay(input, DEFAULT_KEY_DELAY_MS);
  await session.page.keyboard.type(String(text ?? ""), { delay });
  await shortPause(session.page);
}

export async function humanFillLocator(session, locator, value, timeoutMs, input) {
  await humanClickLocator(session, locator, timeoutMs);
  await session.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await shortPause(session.page, 70);
  await session.page.keyboard.press("Backspace");
  await shortPause(session.page, 90);
  await humanTypeText(session, String(value ?? ""), input);
}

export async function humanScroll(session, selector, x, y) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x), Math.abs(y)) / DEFAULT_SCROLL_STEP_PIXELS));
  for (let index = 1; index <= steps; index += 1) {
    const stepX = index === steps ? x - Math.trunc((x * (index - 1)) / steps) : Math.trunc(x / steps);
    const stepY = index === steps ? y - Math.trunc((y * (index - 1)) / steps) : Math.trunc(y / steps);
    if (selector) {
      await session.page.locator(selector).first().evaluate((element, payload) => {
        element.scrollBy(payload.x, payload.y);
      }, { x: stepX, y: stepY });
    } else {
      await session.page.mouse.wheel(stepX, stepY);
    }
    await shortPause(session.page, DEFAULT_SCROLL_STEP_PAUSE_MS);
  }
  await shortPause(session.page);
}

export async function setProofWaitOverlay(page, message) {
  const text = String(message || "").trim();
  await page.evaluate((overlayText) => {
    const existing = document.getElementById("manor-proof-wait-overlay");
    if (!overlayText) {
      existing?.remove();
      return;
    }
    const overlay = existing || document.createElement("div");
    overlay.id = "manor-proof-wait-overlay";
    overlay.textContent = overlayText;
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      padding: "8px 10px",
      borderRadius: "7px",
      background: "rgba(15, 23, 42, 0.88)",
      color: "white",
      font: "12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      pointerEvents: "none",
      boxShadow: "0 8px 22px rgba(15, 23, 42, 0.24)"
    });
    if (!existing) {
      document.documentElement.appendChild(overlay);
    }
  }, text).catch(() => undefined);
}

export function waitOverlayText(_input, selector, urlIncludes, ms) {
  if (selector) {
    return "Waiting for UI update";
  }
  if (urlIncludes) {
    return "Waiting for navigation";
  }
  if (ms >= 1000) {
    return "Waiting intentionally";
  }
  return "";
}
