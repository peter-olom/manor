export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for network idle but with timeout; we'll just wait a bit
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'qa-output/manor_final.png', fullPage: true });
  const result = await page.evaluate(() => {
    // Find the verdict section
    const verdictEls = Array.from(document.querySelectorAll('section.butler-review-verdict, div.butler-review-verdict'));
    const verdictEl = verdictEls.find(el => el.textContent.includes('Accepted'));
    if (!verdictEl) {
      return { layoutOk: false, workerOk: false, reason: 'Verdict section not found' };
    }
    // Find Butler pane: look for ancestor with class containing 'butler' and maybe 'pane' or 'panel'
    let butlerPane = verdictEl.closest('[class*="butler"]');
    // If not found, look for any element with class containing 'butler' that is a parent
    if (!butlerPane) {
      const allButler = Array.from(document.querySelectorAll('[class*="butler"]'));
      butlerPane = allButler.find(el => el.offsetWidth > 0 && el.offsetHeight > 0);
    }
    if (!butlerPane) {
      return { layoutOk: false, workerOk: false, reason: 'Butler pane not found' };
    }
    // Ensure verdict is inside butler pane
    if (!butlerPane.contains(verdictEl)) {
      return { layoutOk: false, workerOk: false, reason: 'Verdict not inside Butler pane' };
    }
    // Find messages container: likely a div with class containing 'message' or 'chat' within butler pane
    const messageContainers = Array.from(butlerPane.querySelectorAll('[class*="message"], [class*="chat"], [class*="log"]'));
    let messagesContainer = null;
    if (messageContainers.length > 0) {
      // pick the one with most children maybe
      messagesContainer = messageContainers.reduce((max, el) => {
        return el.children.length > max.children.length ? el : max;
      }, messageContainers[0]);
    } else {
      // fallback: use butlerPane itself (but then we can't measure margin)
      messagesContainer = butlerPane;
    }
    const verdictRect = verdictEl.getBoundingClientRect();
    const messagesRect = messagesContainer.getBoundingClientRect();
    const margin = messagesRect.top - verdictRect.bottom;
    console.log(`Verdict bottom: ${verdictRect.bottom.toFixed(1)}, Messages top: ${messagesRect.top.toFixed(1)}, margin: ${margin.toFixed(1)}px`);
    const layoutOk = margin > 5; // at least 5px gap
    // Worker pane: find element with class containing 'worker'
    const workerEls = Array.from(document.querySelectorAll('[class*="worker"]'));
    const workerPane = workerEls.find(el => el.offsetWidth > 0 && el.offsetHeight > 0);
    const workerOk = !!workerPane && workerPane.offsetWidth > 0 && workerPane.offsetHeight > 0;
    return {
      layoutOk,
      workerOk,
      margin,
      workerWidth: workerPane ? workerPane.offsetWidth : 0,
      workerHeight: workerPane ? workerPane.offsetHeight : 0,
      verdictText: verdictEl.textContent.trim().substring(0, 100)
    };
  });
  console.log('Result:', result);
  return result;
};