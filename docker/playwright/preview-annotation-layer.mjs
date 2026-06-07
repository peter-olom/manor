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
  const root = host.attachShadow({ mode: "open" });

  const state = {
    mode: "select",
    color: "#ff6b2c",
    marks: [],
    draft: null,
    nextNumber: 1,
    hidden: false,
    activeId: null
  };
  const colors = ["#ff6b2c", "#2563eb", "#16a34a", "#dc2626"];

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .stage {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
        padding: 8px;
        border-radius: 14px;
        background: rgba(18, 24, 38, 0.94);
        color: #fff;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.22);
        pointer-events: auto;
        user-select: none;
      }
      .brand { font-size: 12px; font-weight: 700; letter-spacing: 0.01em; margin: 0 6px 0 2px; white-space: nowrap; }
      select, button {
        appearance: none;
        border: 0;
        border-radius: 10px;
        min-height: 32px;
        padding: 0 10px;
        background: rgba(255,255,255,0.1);
        color: #fff;
        font: 600 12px/1 system-ui, sans-serif;
        cursor: pointer;
      }
      select { max-width: 150px; }
      button:hover { background: rgba(255,255,255,0.18); }
      button:focus-visible, select:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
      button[aria-pressed="true"] { background: #fff; color: #111827; }
      .swatch { width: 28px; min-width: 28px; padding: 0; border: 2px solid transparent; background: var(--swatch); }
      .swatch[aria-pressed="true"] { border-color: #fff; box-shadow: inset 0 0 0 2px rgba(17, 24, 39, 0.32); }
      .divider { width: 1px; height: 24px; background: rgba(255,255,255,0.18); margin: 0 2px; }
      .tab {
        position: fixed;
        right: 16px;
        top: 16px;
        min-height: 34px;
        border-radius: 999px;
        background: rgba(18, 24, 38, 0.94);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.22);
        pointer-events: auto;
      }
      .hidden .toolbar, .hidden svg { display: none; }
      .hidden .tab { display: inline-flex; }
      .tab { display: none; }
      .mark rect, .draft { vector-effect: non-scaling-stroke; }
      .badge-text { font: 700 12px system-ui, sans-serif; fill: #fff; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
      @media (max-width: 640px) {
        .toolbar { left: 8px; right: 8px; top: 8px; transform: none; flex-wrap: wrap; justify-content: center; }
        .brand { width: 100%; text-align: center; margin: 0 0 2px; }
      }
    </style>
    <div class="stage" aria-label="Manor preview annotation layer">
      <svg class="overlay" aria-hidden="true"></svg>
      <div class="toolbar" role="toolbar" aria-label="Manor preview annotation tools">
        <span class="brand">Annotate preview</span>
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
      </div>
      <button type="button" class="tab" data-action="show">Show annotations</button>
    </div>
  `;

  const stage = root.querySelector(".stage");
  const svg = root.querySelector(".overlay");
  const targetSelect = root.querySelector(".target");

  function readTargets() {
    const provided = Array.isArray(window.__manorPreviewAnnotationTargets) ? window.__manorPreviewAnnotationTargets : [];
    const normalized = provided
      .filter((target) => target && typeof target.id === "string" && typeof target.label === "string")
      .map((target) => ({ id: target.id, label: target.label }))
      .slice(0, 8);
    return normalized.length > 0 ? normalized : [{ id: "butler", label: "Butler" }];
  }

  function renderTargets() {
    targetSelect.innerHTML = readTargets()
      .map((target) => `<option value="${target.id.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${target.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</option>`)
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
    render();
  }

  stage.addEventListener("pointerdown", (event) => {
    if (state.mode !== "draw" || state.hidden || event.target.closest("button")) {
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
      const rect = {
        x: draft.x,
        y: draft.y,
        width: draft.width,
        height: draft.height,
        color: draft.color,
        number: draft.number,
        note: ""
      };
      addMark(rect);
    } else {
      render();
    }
  }

  stage.addEventListener("pointerup", (event) => finishDraft(event, true), true);
  stage.addEventListener("pointercancel", (event) => finishDraft(event, false), true);

  async function commitBatch(intent) {
    const annotations = state.marks.map(({ id, x, y, width, height, color, number, note }) => ({
      id, x, y, width, height, color, number, note: note || ""
    }));
    if (annotations.length === 0) {
      return;
    }
    const payload = {
      intent,
      targetId: targetSelect.value || "butler",
      annotations,
      page: { title: document.title || "", url: location.href }
    };
    if (typeof window.manorPreviewAnnotationCommit === "function") {
      await window.manorPreviewAnnotationCommit(payload);
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
      render();
    } else if (action === "clear") {
      state.marks = [];
      state.nextNumber = 1;
      state.activeId = null;
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
  renderTargets();
  setMode("select");
  render();

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
    getMarks: () => state.marks.map(({ x, y, width, height, color, number }) => ({ x, y, width, height, color, number }))
  };
}

export const PREVIEW_ANNOTATION_LAYER_SCRIPT = `(${installPreviewAnnotationLayerInPage.toString()})()`;
