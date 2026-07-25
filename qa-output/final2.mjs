export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for network idle with timeout
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  } catch (e) {}
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'qa-output/manor_final2.png', fullPage: true });
  const result = await page.evaluate(() => {
    // Helper to get visible element
    const isVisible = el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
    };
    // Find verdict element
    const verdictEls = Array.from(document.querySelectorAll('*')).filter(el => 
      el.textContent && el.textContent.trim().startsWith('Accepted') && 
      el.className && (/\bverdict\b/i.test(el.className) || /\bbadge\b/i.test(el.className) || el.tagName === 'SECTION')
    );
    // Choose the one that is visible and has reasonable size
    let verdictEl = null;
    for (const el of verdictEls) {
      if (isVisible(el)) {
        verdictEl = el;
        break;
      }
    }
    if (!verdictEl) {
      return { layoutOk: false, workerOk: false, reason: 'Visible verdict element not found' };
    }
    // Find Butler pane: the nearest ancestor with class containing 'butler' that is a panel/pane
    let butlerPane = verdictEl.closest('[class*="butler"]');
    while (butlerPane && ! (butlerPane.className && (/\b(panel|pane|container)\b/i.test(butlerPane.className) || butlerPane.tagName === 'ASIDE' || butlerPane.tagName === 'MAIN'))) {
      butlerPane = butlerPane.parentElement;
    }
    if (!butlerPane || !isVisible(butlerPane)) {
      // fallback: find any visible butler container
      const allButler = Array.from(document.querySelectorAll('[class*="butler"]')).filter(isVisible);
      butlerPane = allButler[0] || null;
    }
    if (!butlerPane) {
      return { layoutOk: false, workerOk: false, reason: 'Butler pane not found' };
    }
    // Ensure verdict is inside butler pane
    if (!butlerPane.contains(verdictEl)) {
      return { layoutOk: false, workerOk: false, reason: 'Verdict not inside butler pane' };
    }
    // Get children of butler pane
    const children = Array.from(butlerPane.children).filter(isVisible);
    // Find index of verdict element among children
    let verdictIndex = children.findIndex(c => c.contains(verdictEl));
    if (verdictIndex === -1) {
      // maybe verdict is deeper; we'll just use the next sibling after verdict element within butler pane
      // Let's get all elements inside butler pane, sort by vertical position
      const allDescendants = Array.from(butlerPane.querySelectorAll('*')).filter(isVisible);
      const sortedByTop = allDescendants.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      // Find position of verdict in this sorted list
      const verdictPos = sortedByTop.indexOf(verdictEl);
      if (verdictPos === -1) {
        return { layoutOk: false, workerOk: false, reason: 'Could not determine order' };
      }
      // Assume the next element after verdict in vertical order is the messages container
      const afterVerdict = sortedByTop[verdictPos + 1];
      if (!afterVerdict) {
        return { layoutOk: false, workerOk: false, reason: 'No element after verdict' };
      }
      const messagesContainer = afterVerdict;
      const verdictRect = verdictEl.getBoundingClientRect();
      const messagesRect = messagesContainer.getBoundingClientRect();
      const margin = messagesRect.top - verdictRect.bottom;
      const layoutOk = margin > 5;
      // Worker pane
      const workerEls = Array.from(document.querySelectorAll('[class*="worker"]')).filter(isVisible);
      const workerPane = workerEls[0] || null;
      const workerOk = !!workerPane && workerPane.offsetWidth > 0 && workerPane.offsetHeight > 0;
      return { layoutOk, workerOk, margin, workerOk, verdictText: verdictEl.textContent.trim().substring(0,100) };
    }
    // If we have verdictIndex, assume the message container is the next sibling that is not empty
    let messagesContainer = null;
    for (let i = verdictIndex + 1; i < children.length; i++) {
      const child = children[i];
      // Heuristic: if child has multiple children or contains text lines
      if (child.children.length > 0 || (child.textContent && child.textContent.trim().length > 20)) {
        messagesContainer = child;
        break;
      }
    }
    if (!messagesContainer) {
      // fallback: use the element that takes most vertical space after verdict
      const afterChildren = children.slice(verdictIndex + 1);
      if (afterChildren.length === 0) {
        return { layoutOk: false, workerOk: false, reason: 'No content after verdict' };
      }
      messagesContainer = afterChildren.reduce((max, el) => {
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        return area > (max ? (max.rect.width * max.rect.height) : 0) ? { el, rect } : max;
      }, null).el;
    }
    const verdictRect = verdictEl.getBoundingClientRect();
    const messagesRect = messagesContainer.getBoundingClientRect();
    const margin = messagesRect.top - verdictRect.bottom;
    const layoutOk = margin > 5;
    // Worker pane
    const workerEls = Array.from(document.querySelectorAll('[class*="worker"]')).filter(isVisible);
    const workerPane = workerEls[0] || null;
    const workerOk = !!workerPane && workerPane.offsetWidth > 0 && workerPane.offsetHeight > 0;
    return {
      layoutOk,
      workerOk,
      margin,
      workerWidth: workerPane ? workerPane.offsetWidth : 0,
      workerHeight: workerPane ? workerPane.offsetHeight : 0,
      verdictText: verdictEl.textContent.trim().substring(0,100)
    };
  });
  console.log('Result:', result);
  return result;
};