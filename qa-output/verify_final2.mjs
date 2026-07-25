export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'qa-output/manor_final.png', fullPage: true });
  const result = await page.evaluate(() => {
    // Find verdict element
    let verdict = document.querySelector('.butler-review-verdict');
    if (!verdict) {
      // fallback: find by text
      const all = Array.from(document.querySelectorAll('*'));
      const candidates = all.filter(el => el.textContent && el.textContent.trim().startsWith('Accepted'));
      if (candidates.length === 0) {
        return { layoutOk: false, workerOk: false, reason: 'Verdict not found' };
      }
      // pick first visible candidate
      for (const c of candidates) {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          verdict = c;
          break;
        }
      }
      if (!verdict) {
        return { layoutOk: false, workerOk: false, reason: 'No visible verdict' };
      }
    }
    const vRect = verdict.getBoundingClientRect();
    if (vRect.width === 0 || vRect.height === 0) {
      return { layoutOk: false, workerOk: false, reason: 'Verdict has zero size' };
    }
    // Next element sibling
    let next = verdict.nextElementSibling;
    while (next && next.nodeType !== Node.ELEMENT_NODE) {
      next = next.nextElementSibling;
    }
    if (!next) {
      return { layoutOk: false, workerOk: false, reason: 'No next sibling after verdict' };
    }
    const nRect = next.getBoundingClientRect();
    const margin = nRect.top - vRect.bottom;
    const layoutOk = margin >= 0; // no overlap (touching allowed)
    const hasContent = nRect.height > 0;
    // Worker pane: find the pane that is not the leftmost
    const panes = Array.from(document.querySelectorAll('.pane'));
    if (panes.length < 2) {
      return { layoutOk: false, workerOk: false, reason: 'Not enough panes' };
    }
    // Determine left pane by smallest left offset
    let leftPane = panes[0];
    let minLeft = leftPane.getBoundingClientRect().left;
    for (const p of panes) {
      const rect = p.getBoundingClientRect();
      if (rect.left < minLeft) {
        minLeft = rect.left;
        leftPane = p;
      }
    }
    const rightPane = panes.find(p => p !== leftPane);
    const workerOk = !!rightPane && rightPane.offsetWidth > 0 && rightPane.offsetHeight > 0;
    // Check for message-like elements inside next (transcript)
    const messageLike = Array.from(next.querySelectorAll('[class*="message"], [class*="turn"], [class*="comment"], [class*="item"]')).filter(el => {
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
  console.log('Result:', result);
  return result;
};