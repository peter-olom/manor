function installPreviewAnnotationLayerInPage() {
  if (window.__manorPreviewAnnotationLayer?.installed) {
    window.__manorPreviewAnnotationLayer.show();
    return;
  }

  const host = document.createElement("div");
  host.id = "manor-preview-annotation-layer";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  host.dataset.manorPreviewAnnotationLayer = "true";
  const root = host.attachShadow({ mode: "closed" });
  const config = window.__manorPreviewAnnotationConfig && typeof window.__manorPreviewAnnotationConfig === "object" ? window.__manorPreviewAnnotationConfig : {};
  const commitAnnotations = typeof config.commit === "function" ? config.commit : typeof window.manorPreviewAnnotationCommit === "function" ? window.manorPreviewAnnotationCommit : null;

  const state = {
    mode: "select",
    color: "#ff6b2c",
    marks: [],
    draft: null,
    nextNumber: 1,
    hidden: false,
    activeId: null,
    toolbar: { dragging: null }
  };
  const colors = ["#ff6b2c", "#1f5eff", "#0f7a65", "#c2410c"];

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .stage {
        --manor-bg: #eef2f7;
        --manor-panel: #f5f7fb;
        --manor-surface: #ffffff;
        --manor-ink: #10233f;
        --manor-muted: #5f6f84;
        --manor-line: #d6dde8;
        --manor-line-strong: #b7c4d4;
        --manor-accent: #1f5eff;
        --manor-shadow: rgba(15, 23, 42, 0.18);
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: "IBM Plex Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .stage.is-dark {
        --manor-bg: #0b1422;
        --manor-panel: #101b2d;
        --manor-surface: #152238;
        --manor-ink: #f2f7ff;
        --manor-muted: #97adc8;
        --manor-line: #263852;
        --manor-line-strong: #355072;
        --manor-accent: #6ea8ff;
        --manor-shadow: rgba(0, 0, 0, 0.35);
      }
      .stage.is-drawing { cursor: crosshair; pointer-events: auto; }
      svg { position: absolute; inset: 0; width: 100vw; height: 100vh; pointer-events: none; }
      .is-drawing svg { pointer-events: auto; }
      .toolbar {
        position: fixed;
        left: 50%;
        top: 16px;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: calc(100vw - 24px);
        padding: 8px;
        border: 1px solid var(--manor-line);
        border-radius: 14px;
        background: color-mix(in srgb, var(--manor-surface) 94%, transparent);
        color: var(--manor-ink);
        box-shadow: 0 8px 24px var(--manor-shadow);
        pointer-events: auto;
        user-select: none;
        touch-action: none;
        backdrop-filter: saturate(120%);
      }
      .toolbar.is-dragging { cursor: grabbing; }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        padding: 0 8px 0 4px;
        color: var(--manor-ink);
        cursor: grab;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }
      .brand-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--manor-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--manor-accent) 18%, transparent); }
      select, button {
        appearance: none;
        min-height: 32px;
        border: 1px solid var(--manor-line);
        border-radius: 10px;
        padding: 0 10px;
        background: var(--manor-panel);
        color: var(--manor-ink);
        font: 600 12px/1 system-ui, sans-serif;
      }
      button { cursor: pointer; }
      select { max-width: 150px; padding-right: 22px; }
      button:hover, select:hover { border-color: var(--manor-line-strong); background: color-mix(in srgb, var(--manor-panel) 84%, var(--manor-accent) 16%); }
      button:focus-visible, select:focus-visible { outline: 2px solid var(--manor-accent); outline-offset: 2px; }
      button[aria-pressed="true"] { border-color: var(--manor-accent); background: var(--manor-accent); color: #fff; }
      .swatch { width: 28px; min-width: 28px; padding: 0; border: 2px solid transparent; background: var(--swatch); }
      .swatch[aria-pressed="true"] { border-color: var(--manor-ink); box-shadow: inset 0 0 0 2px var(--manor-surface); }
      .divider { width: 1px; height: 24px; background: var(--manor-line); margin: 0 2px; }
      .status { max-width: 180px; color: var(--manor-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tab {
        position: fixed;
        right: 16px;
        top: 16px;
        min-height: 34px;
        border-radius: 999px;
        border-color: var(--manor-line);
        background: var(--manor-surface);
        box-shadow: 0 8px 24px var(--manor-shadow);
        pointer-events: auto;
      }
      .hidden .toolbar, .hidden svg { display: none; }
      .hidden .tab { display: inline-flex; align-items: center; }
      .tab { display: none; }
      .mark rect, .draft { vector-effect: non-scaling-stroke; }
      .badge-text { font: 700 12px system-ui, sans-serif; fill: #fff; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
      @media (max-width: 720px) {
        .toolbar { left: 8px; right: 8px; top: 8px; transform: none; flex-wrap: wrap; justify-content: center; }
        .brand { flex: 1 1 100%; justify-content: center; cursor: grab; }
      }
    </style>
    <div class="stage" aria-label="Manor preview annotation layer">
      <svg class="overlay" aria-hidden="true"></svg>
      <div class="toolbar" role="toolbar" aria-label="Manor preview annotation tools">
        <span class="brand" data-drag-handle title="Drag annotation toolbar"><span class="brand-dot" aria-hidden="true"></span>Annotate preview</span>
        <button type="button" data-mode="select" aria-pressed="true" title="Select lets the page receive clicks">Select</button>
        <button type="button" data-mode="draw" aria-pressed="false" title="Draw numbered rectangles on the preview">Draw</button>
        <span class="divider" aria-hidden="true"></span>
        ${colors.map((color) => `<button type="button" class="swatch" data-color="${color}" style="--swatch:${color}" aria-label="Use ${color}" aria-pressed="${color === state.color}"></button>`).join("")}
        <span class="divider" aria-hidden="true"></span>
        <button type="button" data-action="undo">Undo</button>
        <button type="button" data-action="clear">Clear</button>
        <select class="target" aria-label="Annotation target"></select>
        <button type="button" data-action="batch">Queue batch</button>
        <button type="button" data-action="insert">Insert batch</button>
        <button type="button" data-action="hide" title="Hide annotation toolbar">Hide</button>
        <span class="status" aria-live="polite"></span>
      </div>
      <button type="button" class="tab" data-action="show">Show annotations</button>
    </div>
  `;

  const stage = root.querySelector(".stage");
  const svg = root.querySelector(".overlay");
  const toolbar = root.querySelector(".toolbar");
  const targetSelect = root.querySelector(".target");
  const status = root.querySelector(".status");

  function updateTheme() {
    let preference = null;
    try {
      preference = window.localStorage?.getItem("manor.butler.themePreference") ?? null;
    } catch {
      preference = null;
    }
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    stage.classList.toggle("is-dark", preference === "dark" || (preference !== "light" && prefersDark));
  }

  function showStatus(message, tone = "info") {
    status.textContent = message;
    status.style.color = tone === "error" ? "#ef4444" : "var(--manor-muted)";
  }

  function readTargets() {
    const configuredTargets = Array.isArray(config.targets) ? config.targets : null;
    const provided = configuredTargets ?? (Array.isArray(window.__manorPreviewAnnotationTargets) ? window.__manorPreviewAnnotationTargets : []);
    const normalized = provided
      .filter((target) => target && typeof target.id === "string" && typeof target.label === "string")
      .map((target) => ({ id: target.id, label: target.label }))
      .slice(0, 8);
    return normalized.length > 0 ? normalized : [{ id: "butler", label: "Butler" }];
  }

  function escapeAttribute(value) {
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function escapeText(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }

  function renderTargets() {
    targetSelect.innerHTML = readTargets()
      .map((target) => `<option value="${escapeAttribute(target.id)}">${escapeText(target.label)}</option>`)
      .join("");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function point(event) {
    return {
      x: clamp(event.clientX / Math.max(1, window.innerWidth), 0, 1),
      y: clamp(event.clientY / Math.max(1, window.innerHeight), 0, 1)
    };
  }

  function rectFromPoints(startPoint, currentPoint) {
    const left = Math.min(startPoint.x, currentPoint.x);
    const top = Math.min(startPoint.y, currentPoint.y);
    return {
      x: left,
      y: top,
      width: Math.abs(startPoint.x - currentPoint.x),
      height: Math.abs(startPoint.y - currentPoint.y)
    };
  }

  function setMode(mode) {
    state.mode = mode === "draw" ? "draw" : "select";
    stage.classList.toggle("is-drawing", state.mode === "draw" && !state.hidden);
    root.querySelectorAll("[data-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.mode === state.mode ? "true" : "false");
    });
  }

  function setHidden(hidden) {
    state.hidden = Boolean(hidden);
    stage.classList.toggle("hidden", state.hidden);
    if (state.hidden) {
      stage.classList.remove("is-drawing");
    } else {
      setMode(state.mode);
    }
  }

  function render() {
    const nodes = [];
    const allMarks = state.draft ? [...state.marks, state.draft] : state.marks;
    for (const mark of allMarks) {
      const x = mark.x * 100;
      const y = mark.y * 100;
      const width = mark.width * 100;
      const height = mark.height * 100;
      const badgeX = x + Math.min(2.8, Math.max(1.6, width * 0.18));
      const badgeY = y + Math.min(4.8, Math.max(2.8, height * 0.18));
      const active = mark.id === state.activeId;
      nodes.push(`
        <g class="mark" data-id="${mark.id ?? ""}">
          <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${mark.color}22" stroke="${mark.color}" stroke-width="${active ? 5 : 3}" rx="0.6" />
          <circle cx="${badgeX}" cy="${badgeY}" r="12" fill="${mark.color}" vector-effect="non-scaling-stroke" />
          <text class="badge-text" x="${badgeX}" y="${badgeY + 0.1}">${mark.number ?? ""}</text>
        </g>
      `);
    }
    svg.innerHTML = nodes.join("");
  }

  function addMark(rect) {
    if (rect.width < 0.008 || rect.height < 0.008) {
      return;
    }
    const id = `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.marks.push({ ...rect, id, color: state.color, number: state.nextNumber++, note: "" });
    state.activeId = id;
    showStatus(`${state.marks.length} annotation${state.marks.length === 1 ? "" : "s"} ready`);
    render();
  }

  function interactiveTarget(target) {
    return target instanceof Element && target.closest("button,select,input,textarea,a");
  }

  stage.addEventListener("pointerdown", (event) => {
    if (state.mode !== "draw" || state.hidden || interactiveTarget(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startPoint = point(event);
    state.draft = { ...rectFromPoints(startPoint, startPoint), color: state.color, number: state.nextNumber, startPoint, pointerId: event.pointerId };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or unusual pointer sources may not be capturable. Drawing still works.
    }
    render();
  }, true);

  stage.addEventListener("pointermove", (event) => {
    if (!state.draft || state.draft.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    Object.assign(state.draft, rectFromPoints(state.draft.startPoint, point(event)));
    render();
  }, true);

  function finishDraft(event, commit) {
    if (!state.draft || state.draft.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draft = state.draft;
    state.draft = null;
    if (commit) {
      addMark({
        x: draft.x,
        y: draft.y,
        width: draft.width,
        height: draft.height,
        color: draft.color,
        number: draft.number,
        note: ""
      });
    } else {
      render();
    }
  }

  stage.addEventListener("pointerup", (event) => finishDraft(event, true), true);
  stage.addEventListener("pointercancel", (event) => finishDraft(event, false), true);

  toolbar.addEventListener("pointerdown", (event) => {
    if (interactiveTarget(event.target) && !event.target.closest("[data-drag-handle]")) {
      return;
    }
    if (!event.target.closest("[data-drag-handle]")) {
      return;
    }
    const rect = toolbar.getBoundingClientRect();
    state.toolbar.dragging = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    toolbar.classList.add("is-dragging");
    toolbar.style.transform = "none";
    toolbar.style.left = `${rect.left}px`;
    toolbar.style.top = `${rect.top}px`;
    try {
      toolbar.setPointerCapture(event.pointerId);
    } catch {}
    event.preventDefault();
  });

  toolbar.addEventListener("pointermove", (event) => {
    const drag = state.toolbar.dragging;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const width = toolbar.offsetWidth || 1;
    const height = toolbar.offsetHeight || 1;
    toolbar.style.left = `${clamp(event.clientX - drag.offsetX, 8, Math.max(8, window.innerWidth - width - 8))}px`;
    toolbar.style.top = `${clamp(event.clientY - drag.offsetY, 8, Math.max(8, window.innerHeight - height - 8))}px`;
  });

  function endToolbarDrag(event) {
    const drag = state.toolbar.dragging;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    state.toolbar.dragging = null;
    toolbar.classList.remove("is-dragging");
  }

  toolbar.addEventListener("pointerup", endToolbarDrag);
  toolbar.addEventListener("pointercancel", endToolbarDrag);

  async function commitBatch(intent) {
    const annotations = state.marks.map(({ id, x, y, width, height, color, number, note }) => ({
      id, x, y, width, height, color, number, note: note || ""
    }));
    if (annotations.length === 0) {
      showStatus("Draw an annotation first", "error");
      return;
    }
    const payload = {
      intent,
      leaseId: typeof config.leaseId === "string" ? config.leaseId : typeof window.__manorPreviewAnnotationLeaseId === "string" ? window.__manorPreviewAnnotationLeaseId : "",
      targetId: targetSelect.value || "butler",
      annotations,
      page: { title: document.title || "", url: location.href }
    };
    if (!commitAnnotations) {
      showStatus("Annotation capture is unavailable", "error");
      return;
    }
    try {
      await commitAnnotations(payload);
      showStatus(`${intent === "insert" ? "Inserted" : "Queued"} ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Annotation capture failed", "error");
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    const mode = target?.dataset?.mode;
    const action = target?.dataset?.action;
    const color = target?.dataset?.color;
    if (mode) {
      setMode(mode);
    } else if (color) {
      state.color = color;
      root.querySelectorAll("[data-color]").forEach((button) => {
        button.setAttribute("aria-pressed", button.dataset.color === color ? "true" : "false");
      });
    } else if (action === "undo") {
      const removed = state.marks.pop();
      if (removed?.id === state.activeId) {
        state.activeId = state.marks.at(-1)?.id ?? null;
      }
      state.nextNumber = Math.max(1, state.nextNumber - 1);
      showStatus(`${state.marks.length} annotation${state.marks.length === 1 ? "" : "s"} ready`);
      render();
    } else if (action === "clear") {
      state.marks = [];
      state.nextNumber = 1;
      state.activeId = null;
      showStatus("Cleared annotations");
      render();
    } else if (action === "batch") {
      void commitBatch("batch");
    } else if (action === "insert") {
      void commitBatch("insert");
    } else if (action === "hide") {
      setHidden(true);
    } else if (action === "show") {
      setHidden(false);
    }
  });

  document.documentElement.appendChild(host);
  updateTheme();
  renderTargets();
  setMode("select");
  render();

  window.addEventListener("storage", updateTheme);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", updateTheme);

  window.__manorPreviewAnnotationLayer = {
    installed: true,
    show: () => setHidden(false),
    hide: () => setHidden(true),
    setMode,
    clear: () => {
      state.marks = [];
      state.nextNumber = 1;
      state.activeId = null;
      render();
    },
    getMarks: () => state.marks.map(({ id, x, y, width, height, color, number, note }) => ({ id, x, y, width, height, color, number, note: note || "" }))
  };
}

export const PREVIEW_ANNOTATION_LAYER_SCRIPT = `(${installPreviewAnnotationLayerInPage.toString()})()`;
