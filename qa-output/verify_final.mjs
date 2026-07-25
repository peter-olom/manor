export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for network idle with timeout
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'qa-output/manor_verification.png', fullPage: true });
  const result = await page.evaluate(() => {
    const verdict = document.querySelector('.butler-review-verdit');
    if (!verdict) {
      // fallback: try to find by text
      const all = Array.from(document.querySelectorAll('*'));
      const verdictEls = all.filter(el => el.textContent && el.textContent.trim().startsWith('Accepted'));
      if (verdictEls.length === 0) return { layoutOk: false, workerOk: false, reason: 'Verdict not found' };
      // pick the one that is visible and has reasonable size
      const visible = verdictEls.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible.length === 0) return { layoutOk: false, workerOk: false, reason: 'No visible verdict' };
      verdict = visible[0];
    }
    // Ensure verdict is visible
    const vRect = verdict.getBoundingClientRect();
    if (vRect.width === 0 || vRect.height === 0) {
      return { layoutOk: false, workerOk: false, reason: 'Verdict has zero size' };
    }
    // Get next sibling element
    let next = verdict.nextElementSibling;
    // Skip any whitespace/text nodes
    while (next && next.nodeType !== Node.ELEMENT_NODE) {
      next = next.nextElementSibling;
    }
    if (!next) {
      // maybe the container is the parent's next sibling? unlikely
      return { layoutOk: false, workerOk: false, reason: 'No next sibling after verdict' };
    }
    const nRect = next.getBoundingClientRect();
    const margin = nRect.top - vRect.bottom;
    const layoutOk = margin >= 0; // no overlap (touching allowed)
    // Check that next element has some content (height > 0)
    const hasContent = nRect.height > 0;
    // Worker pane: find element with class containing 'worker' that is a pane (likely .pane with worker-summary)
    const workerPane = document.querySelector('.pane');
    // Actually there are two panes; we need the right one (worker). We'll find the pane that is not the left one.
    const panes = Array.from(document.querySelectorAll('.pane'));
    // Determine left pane as the one with smallest left offset
    let leftPane = null;
    let minLeft = Infinity;
    for (const p of panes) {
      const rect = p.getBoundingClientRect();
      if (rect.left < minLeft) {
        minLeft = rect.left;
        leftPane = p;
      }
    }
    const rightPane = panes.find(p => p !== leftPane);
    const workerOk = !!rightPane && rightPane.offsetWidth > 0 && rightPane.offsetHeight > 0;
    // Additional: check that transcript contains multiple message-like elements
    const messageLike = Array.from(next.querySelectorAll('[class*="message"], [class*="turn"], [class*="comment"]')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const hasMessages = messageLike.length > 0;
    return {
      layoutOk,
      workerOk,
      margin: Math.round(margin),
      verdictText: verdict.textContent.trim().substring(0, 100),
      nextElementClass: next.className,
      nextElementHeight: Math.round(nRect.height),
      messageLikeCount: messageLike.length,
      workerWidth: Math.round((rightPane || {}).offsetWidth || 0),
      workerHeight: Math.round((rightPane || {}).offsetHeight || 0)
    };
  });
  console.log('Verification result:', result);
  return result;
};