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
    batchId: `annotation-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    selectionDrag: null,
    textSelection: null,
    publishTimer: null,
    publishing: false,
    lastPublishedSignature: "",
    toolbar: { dragging: null, lastPointerCommand: null },
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
      .stage.is-selecting .mark, .stage.is-selecting .mark * { cursor: move; pointer-events: auto; }
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
        <button type="button" data-mode="select" aria-pressed="true" title="Select text to add a mark, or move existing marks">Select</button>
        <button type="button" data-mode="draw" aria-pressed="false" title="Draw numbered rectangles on the preview">Draw</button>
        <input class="color-input" type="color" value="${state.color}" aria-label="Annotation color">
        <span class="divider" aria-hidden="true"></span>
        <button type="button" data-action="undo">Undo</button>
        <button type="button" data-action="clear">Clear</button>
        <select class="mark-select" aria-label="Current mark"></select>
        <input class="note-input" type="text" maxlength="280" placeholder="Draw a mark to add comment" aria-label="Comment for selected annotation" disabled>
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

  function markById(id) {
    return state.marks.find((mark) => mark.id === id) ?? null;
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

  function markHasComment(mark) {
    return mark.note.trim().length > 0;
  }

  function pendingCommentMark() {
    return state.marks.find((mark) => !markHasComment(mark)) ?? null;
  }

  function batchReady() {
    return state.marks.length > 0 && state.marks.every(markHasComment);
  }

  function showBatchStatus() {
    const pending = pendingCommentMark();
    if (pending) {
      showStatus(`Add comment for #${pending.number}`);
      return;
    }
    if (state.marks.length > 0) {
      showStatus(`${state.marks.length} mark${state.marks.length === 1 ? "" : "s"} ready`);
      return;
    }
    showStatus("No marks");
  }

  function ensureCanCreateMark() {
    const pending = pendingCommentMark();
    if (!pending) {
      return true;
    }
    setActiveMark(pending.id);
    showStatus(`Add comment for #${pending.number} before adding another mark`, "error");
    return false;
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

  function blockViewportWheel(event) {
    if (state.hidden) {
      return;
    }
    event.preventDefault();
    enforceScrollLock();
  }

  function blockViewportGesture(event) {
    if (state.hidden) {
      return;
    }
    event.preventDefault();
  }

  function blockViewportZoomKey(event) {
    if (state.hidden || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_" || event.key === "0") {
      event.preventDefault();
      enforceScrollLock();
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
      window.addEventListener("wheel", blockViewportWheel, { passive: false, capture: true });
      window.addEventListener("touchmove", blockViewportWheel, { passive: false, capture: true });
      window.addEventListener("gesturestart", blockViewportGesture, { passive: false, capture: true });
      window.addEventListener("gesturechange", blockViewportGesture, { passive: false, capture: true });
      window.addEventListener("keydown", blockViewportZoomKey, true);
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
      window.removeEventListener("wheel", blockViewportWheel, true);
      window.removeEventListener("touchmove", blockViewportWheel, true);
      window.removeEventListener("gesturestart", blockViewportGesture, true);
      window.removeEventListener("gesturechange", blockViewportGesture, true);
      window.removeEventListener("keydown", blockViewportZoomKey, true);
    }
  }

  function updateScrollLock() {
    setScrollLocked(!state.hidden);
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

  function normalizedRectFromClientRect(clientRect, padding = 4) {
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const left = clamp(clientRect.left - padding, 0, viewportWidth);
    const top = clamp(clientRect.top - padding, 0, viewportHeight);
    const right = clamp(clientRect.right + padding, 0, viewportWidth);
    const bottom = clamp(clientRect.bottom + padding, 0, viewportHeight);
    return {
      x: left / viewportWidth,
      y: top / viewportHeight,
      width: Math.max(0, right - left) / viewportWidth,
      height: Math.max(0, bottom - top) / viewportHeight
    };
  }

  function unionClientRects(rects) {
    const visibleRects = rects.filter((rect) =>
      rect.width > 0 && rect.height > 0 && rect.right >= 0 && rect.bottom >= 0 && rect.left <= window.innerWidth && rect.top <= window.innerHeight
    );
    if (visibleRects.length === 0) {
      return null;
    }
    return visibleRects.reduce((combined, rect) => ({
      left: Math.min(combined.left, rect.left),
      top: Math.min(combined.top, rect.top),
      right: Math.max(combined.right, rect.right),
      bottom: Math.max(combined.bottom, rect.bottom),
      width: Math.max(combined.right, rect.right) - Math.min(combined.left, rect.left),
      height: Math.max(combined.bottom, rect.bottom) - Math.min(combined.top, rect.top)
    }));
  }

  function selectedTextRect() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || selection.toString().trim().length === 0) {
      return null;
    }
    const rects = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      rects.push(...Array.from(range.getClientRects()));
      const fallbackRect = range.getBoundingClientRect();
      if (fallbackRect.width > 0 && fallbackRect.height > 0) {
        rects.push(fallbackRect);
      }
    }
    return unionClientRects(rects);
  }

  function clearNativeSelection() {
    const selection = window.getSelection?.();
    if (selection && selection.rangeCount > 0) {
      selection.removeAllRanges();
    }
  }

  function setMode(mode) {
    state.mode = mode === "draw" ? "draw" : "select";
    state.selectionDrag = null;
    state.textSelection = null;
    stage.classList.toggle("is-drawing", state.mode === "draw" && !state.hidden);
    stage.classList.toggle("is-selecting", state.mode === "select" && !state.hidden);
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
      stage.classList.remove("is-selecting");
      state.selectionDrag = null;
      state.textSelection = null;
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
    if (!ensureCanCreateMark()) {
      return;
    }
    if (rect.width < 0.008 || rect.height < 0.008) {
      return;
    }
    const id = `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.marks.push({ ...rect, id, color: state.color, number: state.nextNumber++, note: rect.note ?? "", viewport: readViewport() });
    setActiveMark(id);
    showBatchStatus();
    publishBatchSoon();
    updateScrollLock();
  }

  function closestElement(target, selector) {
    if (target instanceof Element) {
      return target.closest(selector);
    }
    if (target instanceof Node && target.parentElement) {
      return target.parentElement.closest(selector);
    }
    return null;
  }

  function interactiveTarget(target) {
    return Boolean(closestElement(target, "button,select,input,textarea,a"));
  }

  function editableTextTarget(target) {
    const element = closestElement(target, "input,textarea,[contenteditable=''],[contenteditable='true']");
    return Boolean(element);
  }

  function eventTouchesAnnotationLayer(event) {
    return event.composedPath?.().includes(host) === true;
  }

  function serializedAnnotations() {
    return state.marks.map(({ id, x, y, width, height, color, number, note, viewport }) => ({
      id, x, y, width, height, color, number, note: note || "", viewport: viewport || readViewport()
    }));
  }

  function buildBatchPayload(annotations = serializedAnnotations()) {
    const ready = annotations.length > 0 && annotations.every((annotation) => String(annotation.note || "").trim().length > 0);
    return {
      id: state.batchId,
      intent: "batch",
      ready,
      leaseId: typeof config.leaseId === "string" ? config.leaseId : typeof window.__manorPreviewAnnotationLeaseId === "string" ? window.__manorPreviewAnnotationLeaseId : "",
      targetId: "companion",
      annotations,
      page: { title: document.title || "", url: location.href }
    };
  }

  async function publishBatch(annotations = serializedAnnotations()) {
    const payload = buildBatchPayload(annotations);
    const signature = JSON.stringify(payload);
    if (signature === state.lastPublishedSignature) {
      return;
    }
    if (!commitAnnotations) {
      showStatus("Annotation capture is unavailable", "error");
      return;
    }
    state.lastPublishedSignature = signature;
    state.publishing = true;
    try {
      await commitAnnotations(payload);
      showBatchStatus();
    } catch (error) {
      state.lastPublishedSignature = "";
      showStatus(error instanceof Error ? error.message : "Annotation capture failed", "error");
    } finally {
      state.publishing = false;
    }
  }

  function publishBatchSoon() {
    if (state.publishTimer !== null) {
      window.clearTimeout(state.publishTimer);
    }
    state.publishTimer = window.setTimeout(() => {
      state.publishTimer = null;
      void publishBatch();
    }, 180);
  }

  function clearPublishedBatch() {
    if (state.publishTimer !== null) {
      window.clearTimeout(state.publishTimer);
      state.publishTimer = null;
    }
    void publishBatch([]);
  }

  function runControlCommand(target) {
    const mode = target?.dataset.mode;
    const action = target?.dataset.action;
    if (mode) {
      setMode(mode);
    } else if (action === "undo") {
      const removed = state.marks.pop();
      if (removed?.id === state.selectionDrag?.markId) {
        state.selectionDrag = null;
      }
      if (removed?.id === state.activeId) {
        state.activeId = state.marks.at(-1)?.id ?? null;
      }
      state.nextNumber = Math.max(1, state.nextNumber - 1);
      render();
      syncCommentControls();
      showBatchStatus();
      publishBatchSoon();
      updateScrollLock();
    } else if (action === "clear") {
      state.marks = [];
      state.nextNumber = 1;
      state.activeId = null;
      state.selectionDrag = null;
      state.textSelection = null;
      showStatus("Cleared annotations");
      render();
      syncCommentControls();
      clearPublishedBatch();
      updateScrollLock();
    } else if (action === "hide") {
      setHidden(true);
    } else if (action === "show") {
      setHidden(false);
    }
  }

  function runPointerCommand(event) {
    const target = closestElement(event.target, "button[data-mode],button[data-action]");
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const command = { target, expiresAt: Date.now() + 800 };
    state.toolbar.lastPointerCommand = command;
    window.setTimeout(() => {
      if (state.toolbar.lastPointerCommand === command) {
        state.toolbar.lastPointerCommand = null;
      }
    }, 900);
    runControlCommand(target);
  }

  function runClickCommand(event) {
    const target = closestElement(event.target, "button[data-mode],button[data-action]");
    if (!target) {
      return;
    }
    const pointerCommand = state.toolbar.lastPointerCommand;
    if (pointerCommand?.target === target && pointerCommand.expiresAt >= Date.now()) {
      state.toolbar.lastPointerCommand = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    runControlCommand(target);
  }

  stage.addEventListener("pointerdown", (event) => {
    if (state.mode !== "draw" || state.hidden || interactiveTarget(event.target)) {
      return;
    }
    if (!ensureCanCreateMark()) {
      event.preventDefault();
      event.stopPropagation();
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

  stage.addEventListener("pointerdown", (event) => {
    if (state.mode !== "select" || state.hidden || interactiveTarget(event.target)) {
      return;
    }
    const markNode = closestElement(event.target, ".mark[data-id]");
    const mark = markNode ? markById(markNode.dataset.id) : null;
    if (!mark) {
      return;
    }
    const pending = pendingCommentMark();
    if (pending && pending.id !== mark.id) {
      event.preventDefault();
      event.stopPropagation();
      setActiveMark(pending.id);
      showStatus(`Add comment for #${pending.number} before selecting another mark`, "error");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setActiveMark(mark.id);
    state.selectionDrag = {
      pointerId: event.pointerId,
      markId: mark.id,
      startPoint: point(event),
      original: { x: mark.x, y: mark.y, width: mark.width, height: mark.height }
    };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {}
    showStatus(`#${mark.number} selected`);
  }, true);

  stage.addEventListener("pointermove", (event) => {
    const drag = state.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const mark = markById(drag.markId);
    if (!mark) {
      state.selectionDrag = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const currentPoint = point(event);
    const deltaX = currentPoint.x - drag.startPoint.x;
    const deltaY = currentPoint.y - drag.startPoint.y;
    mark.x = clamp(drag.original.x + deltaX, 0, Math.max(0, 1 - drag.original.width));
    mark.y = clamp(drag.original.y + deltaY, 0, Math.max(0, 1 - drag.original.height));
    mark.viewport = readViewport();
    render();
  }, true);

  function finishSelectionDrag(event) {
    const drag = state.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    state.selectionDrag = null;
    const mark = markById(drag.markId);
    if (mark) {
      showStatus(`#${mark.number} selected`);
      publishBatchSoon();
    }
  }

  stage.addEventListener("pointerup", finishSelectionDrag, true);
  stage.addEventListener("pointercancel", finishSelectionDrag, true);

  document.addEventListener("pointerdown", (event) => {
    if (
      state.mode !== "select" ||
      state.hidden ||
      event.button !== 0 ||
      eventTouchesAnnotationLayer(event) ||
      editableTextTarget(event.target)
    ) {
      return;
    }
    if (!ensureCanCreateMark()) {
      event.preventDefault();
      event.stopPropagation();
      clearNativeSelection();
      return;
    }
    state.textSelection = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
  }, true);

  document.addEventListener("pointerup", (event) => {
    const capture = state.textSelection;
    state.textSelection = null;
    if (!capture || capture.pointerId !== event.pointerId || state.mode !== "select" || state.hidden || eventTouchesAnnotationLayer(event)) {
      return;
    }
    window.setTimeout(() => {
      if (state.mode !== "select" || state.hidden) {
        return;
      }
      if (!ensureCanCreateMark()) {
        clearNativeSelection();
        return;
      }
      const clientRect = selectedTextRect();
      if (!clientRect) {
        return;
      }
      const rect = normalizedRectFromClientRect(clientRect);
      if (rect.width < 0.008 || rect.height < 0.008) {
        return;
      }
      addMark(rect);
      clearNativeSelection();
    }, 0);
  }, true);

  document.addEventListener("pointercancel", (event) => {
    if (state.textSelection?.pointerId === event.pointerId) {
      state.textSelection = null;
    }
  }, true);

  toolbar.addEventListener("pointerdown", (event) => {
    const dragHandle = closestElement(event.target, "[data-drag-handle]");
    if (interactiveTarget(event.target) && !dragHandle) {
      return;
    }
    if (!dragHandle) {
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
  root.querySelectorAll("button[data-mode],button[data-action]").forEach((button) => {
    button.addEventListener("pointerup", runPointerCommand);
    button.addEventListener("click", runClickCommand);
  });

  markSelect.addEventListener("change", () => {
    const pending = pendingCommentMark();
    if (pending && markSelect.value !== pending.id) {
      setActiveMark(pending.id);
      showStatus(`Add comment for #${pending.number} before selecting another mark`, "error");
      return;
    }
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
    showBatchStatus();
    publishBatchSoon();
  });

  async function commitBatch(intent) {
    await publishBatch(serializedAnnotations().map((annotation) => ({ ...annotation })));
  }

  root.addEventListener("click", (event) => {
    runClickCommand(event);
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
    addRect: (rect) => {
      if (!rect || typeof rect !== "object") {
        return buildBatchPayload();
      }
      addMark({
        x: clamp(typeof rect.x === "number" && Number.isFinite(rect.x) ? rect.x : 0, 0, 1),
        y: clamp(typeof rect.y === "number" && Number.isFinite(rect.y) ? rect.y : 0, 0, 1),
        width: clamp(typeof rect.width === "number" && Number.isFinite(rect.width) ? rect.width : 0, 0, 1),
        height: clamp(typeof rect.height === "number" && Number.isFinite(rect.height) ? rect.height : 0, 0, 1),
        color: typeof rect.color === "string" && rect.color ? rect.color : state.color,
        note: typeof rect.note === "string" ? rect.note.slice(0, 280) : ""
      });
      return buildBatchPayload();
    },
    setNote: (idOrNumber, note) => {
      const mark = typeof idOrNumber === "number"
        ? state.marks.find((entry) => entry.number === idOrNumber)
        : state.marks.find((entry) => entry.id === idOrNumber);
      if (mark) {
        mark.note = typeof note === "string" ? note.slice(0, 280) : "";
        setActiveMark(mark.id);
        showBatchStatus();
        publishBatchSoon();
      }
      return buildBatchPayload();
    },
    clear: () => {
      state.marks = [];
      state.nextNumber = 1;
      state.activeId = null;
      state.selectionDrag = null;
      state.textSelection = null;
      render();
      syncCommentControls();
      clearPublishedBatch();
      updateScrollLock();
    },
    getMarks: () => serializedAnnotations(),
    getBatch: () => buildBatchPayload()
  };
}

export const PREVIEW_ANNOTATION_LAYER_SCRIPT = `(${installPreviewAnnotationLayerInPage.toString()})()`;
