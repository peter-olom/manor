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
    toolbar: { dragging: null },
    scrollLock: null
  };
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
        padding: 6px;
        border: 1px solid var(--manor-line);
        border-radius: 0;
        background: color-mix(in srgb, var(--manor-surface) 96%, transparent);
        color: var(--manor-ink);
        box-shadow: 0 8px 24px var(--manor-shadow);
        pointer-events: auto;
        user-select: none;
        touch-action: none;
        backdrop-filter: saturate(120%);
      }
      .toolbar.is-dragging { cursor: grabbing; }
      .drag-handle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        min-width: 28px;
        min-height: 32px;
        color: var(--manor-muted);
        cursor: grab;
        font-size: 16px;
        font-weight: 700;
        line-height: 1;
      }
      select, button, input {
        appearance: none;
        min-height: 32px;
        border: 1px solid var(--manor-line);
        border-radius: 0;
        padding: 0 10px;
        background: var(--manor-panel);
        color: var(--manor-ink);
        font: 600 12px/1 system-ui, sans-serif;
      }
      button { cursor: pointer; }
      select { max-width: 150px; padding-right: 22px; }
      input { min-width: 210px; background: var(--manor-surface); user-select: text; }
      .color-input { appearance: auto; width: 34px; min-width: 34px; padding: 2px; cursor: pointer; }
      .color-input::-webkit-color-swatch-wrapper { padding: 0; }
      .color-input::-webkit-color-swatch { border: 0; border-radius: 0; }
      .color-input::-moz-color-swatch { border: 0; border-radius: 0; }
      input::placeholder { color: var(--manor-muted); opacity: 1; }
      input:disabled { color: var(--manor-muted); opacity: 0.72; }
      button:hover, select:hover, input:hover { border-color: var(--manor-line-strong); background: color-mix(in srgb, var(--manor-panel) 84%, var(--manor-accent) 16%); }
      button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--manor-accent); outline-offset: 2px; }
      button[aria-pressed="true"] { border-color: var(--manor-accent); background: var(--manor-accent); color: #fff; }
      .divider { width: 1px; height: 24px; background: var(--manor-line); margin: 0 2px; }
      .mark-select { width: 76px; }
      .note-input { width: min(260px, 26vw); }
      .status { max-width: 180px; color: var(--manor-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tab {
        position: fixed;
        right: 16px;
        top: 16px;
        min-height: 34px;
        border-radius: 0;
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
        .drag-handle { flex: 0 0 32px; cursor: grab; }
        .note-input { flex: 1 1 100%; width: auto; }
      }
    </style>
    <div class="stage" aria-label="Manor preview annotation layer">
      <svg class="overlay" aria-hidden="true"></svg>
      <div class="toolbar" role="toolbar" aria-label="Manor preview annotation tools">
        <span class="drag-handle" data-drag-handle aria-label="Drag annotation toolbar" title="Drag annotation toolbar">⋮⋮</span>
        <button type="button" data-mode="select" aria-pressed="true" title="Select lets the page receive clicks">Select</button>
        <button type="button" data-mode="draw" aria-pressed="false" title="Draw numbered rectangles on the preview">Draw</button>
        <input class="color-input" type="color" value="${state.color}" aria-label="Annotation color">
        <span class="divider" aria-hidden="true"></span>
        <button type="button" data-action="undo">Undo</button>
        <button type="button" data-action="clear">Clear</button>
        <select class="mark-select" aria-label="Selected annotation"></select>
        <input class="note-input" type="text" maxlength="280" placeholder="Draw a mark to add comment" aria-label="Comment for selected annotation" disabled>
        <button type="button" data-action="batch">Queue</button>
        <button class="icon-button" type="button" data-action="hide" title="Hide annotation toolbar" aria-label="Hide annotation toolbar">×</button>
        <span class="status" aria-live="polite"></span>
      </div>
      <button type="button" class="tab" data-action="show">Show annotations</button>
    </div>
  `;

  const stage = root.querySelector(".stage");
  const svg = root.querySelector(".overlay");
  const toolbar = root.querySelector(".toolbar");
  const markSelect = root.querySelector(".mark-select");
  const colorInput = root.querySelector(".color-input");
  const noteInput = root.querySelector(".note-input");
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

  function escapeAttribute(value) {
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function activeMark() {
    return state.marks.find((mark) => mark.id === state.activeId) ?? null;
  }

  function syncCommentControls() {
    const selected = activeMark();
    markSelect.disabled = state.marks.length === 0;
    markSelect.innerHTML = state.marks.length === 0
      ? `<option value="">No marks</option>`
      : state.marks.map((mark) => `<option value="${escapeAttribute(mark.id)}">#${mark.number}</option>`).join("");
    markSelect.value = selected?.id ?? "";
    noteInput.disabled = !selected;
    noteInput.value = selected?.note ?? "";
    noteInput.placeholder = selected ? `Comment for #${selected.number}` : "Draw a mark to add comment";
  }

  function setActiveMark(id) {
    state.activeId = state.marks.some((mark) => mark.id === id) ? id : state.marks.at(-1)?.id ?? null;
    render();
    syncCommentControls();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readViewport() {
    const documentElement = document.documentElement;
    const body = document.body;
    return {
      width: Math.max(1, Math.round(window.innerWidth || documentElement.clientWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || documentElement.clientHeight || 1)),
      scrollX: Math.max(0, Math.round(window.scrollX || window.pageXOffset || documentElement.scrollLeft || body?.scrollLeft || 0)),
      scrollY: Math.max(0, Math.round(window.scrollY || window.pageYOffset || documentElement.scrollTop || body?.scrollTop || 0)),
      documentWidth: Math.max(1, Math.round(documentElement.scrollWidth || body?.scrollWidth || window.innerWidth || 1)),
      documentHeight: Math.max(1, Math.round(documentElement.scrollHeight || body?.scrollHeight || window.innerHeight || 1))
    };
  }

  function enforceScrollLock() {
    const lock = state.scrollLock;
    if (!lock) {
      return;
    }
    if (Math.round(window.scrollX || 0) !== lock.x || Math.round(window.scrollY || 0) !== lock.y) {
      window.scrollTo(lock.x, lock.y);
    }
  }

  function setScrollLocked(locked) {
    const documentElement = document.documentElement;
    const body = document.body;
    if (locked && !state.scrollLock) {
      state.scrollLock = {
        x: Math.round(window.scrollX || window.pageXOffset || 0),
        y: Math.round(window.scrollY || window.pageYOffset || 0),
        documentOverflow: documentElement.style.overflow,
        bodyOverflow: body?.style.overflow ?? "",
        bodyOverscrollBehavior: body?.style.overscrollBehavior ?? ""
      };
      documentElement.style.overflow = "hidden";
      if (body) {
        body.style.overflow = "hidden";
        body.style.overscrollBehavior = "contain";
      }
      window.addEventListener("scroll", enforceScrollLock, { passive: true });
      enforceScrollLock();
    } else if (!locked && state.scrollLock) {
      const lock = state.scrollLock;
      state.scrollLock = null;
      documentElement.style.overflow = lock.documentOverflow;
      if (body) {
        body.style.overflow = lock.bodyOverflow;
        body.style.overscrollBehavior = lock.bodyOverscrollBehavior;
      }
      window.removeEventListener("scroll", enforceScrollLock);
    }
  }

  function updateScrollLock() {
    setScrollLocked((state.mode === "draw" && !state.hidden) || state.marks.length > 0);
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
    updateScrollLock();
  }

  function setHidden(hidden) {
    state.hidden = Boolean(hidden);
    stage.classList.toggle("hidden", state.hidden);
    if (state.hidden) {
      stage.classList.remove("is-drawing");
    } else {
      setMode(state.mode);
    }
    updateScrollLock();
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
          <rect x="${x}%" y="${y}%" width="${width}%" height="${height}%" fill="${mark.color}22" stroke="${mark.color}" stroke-width="${active ? 5 : 3}" rx="0.6" />
          <circle cx="${badgeX}%" cy="${badgeY}%" r="12" fill="${mark.color}" vector-effect="non-scaling-stroke" />
          <text class="badge-text" x="${badgeX}%" y="${badgeY + 0.1}%">${mark.number ?? ""}</text>
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
    state.marks.push({ ...rect, id, color: state.color, number: state.nextNumber++, note: "", viewport: readViewport() });
    showStatus(`${state.marks.length} annotation${state.marks.length === 1 ? "" : "s"} ready`);
    setActiveMark(id);
    updateScrollLock();
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

  markSelect.addEventListener("change", () => {
    setActiveMark(markSelect.value);
  });

  colorInput.addEventListener("input", () => {
    state.color = colorInput.value || state.color;
  });

  noteInput.addEventListener("input", () => {
    const selected = activeMark();
    if (!selected) {
      return;
    }
    selected.note = noteInput.value.slice(0, 280);
    showStatus(`Comment saved for #${selected.number}`);
  });

  async function commitBatch(intent) {
    const annotations = state.marks.map(({ id, x, y, width, height, color, number, note, viewport }) => ({
      id, x, y, width, height, color, number, note: note || "", viewport: viewport || readViewport()
    }));
    if (annotations.length === 0) {
      showStatus("Draw an annotation first", "error");
      return;
    }
    const payload = {
      intent,
      leaseId: typeof config.leaseId === "string" ? config.leaseId : typeof window.__manorPreviewAnnotationLeaseId === "string" ? window.__manorPreviewAnnotationLeaseId : "",
      targetId: "companion",
      annotations,
      page: { title: document.title || "", url: location.href }
    };
    if (!commitAnnotations) {
      showStatus("Annotation capture is unavailable", "error");
      return;
    }
    try {
      await commitAnnotations(payload);
      showStatus(`Queued ${annotations.length} annotation${annotations.length === 1 ? "" : "s"} for Manor`);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Annotation capture failed", "error");
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    const mode = target?.dataset?.mode;
    const action = target?.dataset?.action;
    if (mode) {
      setMode(mode);
    } else if (action === "undo") {
      const removed = state.marks.pop();
      if (removed?.id === state.activeId) {
        state.activeId = state.marks.at(-1)?.id ?? null;
      }
      state.nextNumber = Math.max(1, state.nextNumber - 1);
      showStatus(`${state.marks.length} annotation${state.marks.length === 1 ? "" : "s"} ready`);
      render();
      syncCommentControls();
      updateScrollLock();
    } else if (action === "clear") {
      state.marks = [];
      state.nextNumber = 1;
      state.activeId = null;
      showStatus("Cleared annotations");
      render();
      syncCommentControls();
      updateScrollLock();
    } else if (action === "batch") {
      void commitBatch("batch");
    } else if (action === "hide") {
      setHidden(true);
    } else if (action === "show") {
      setHidden(false);
    }
  });

  document.documentElement.appendChild(host);
  updateTheme();
  syncCommentControls();
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
      syncCommentControls();
      updateScrollLock();
    },
    getMarks: () => state.marks.map(({ id, x, y, width, height, color, number, note, viewport }) => ({ id, x, y, width, height, color, number, note: note || "", viewport: viewport || readViewport() }))
  };
}

export const PREVIEW_ANNOTATION_LAYER_SCRIPT = `(${installPreviewAnnotationLayerInPage.toString()})()`;
