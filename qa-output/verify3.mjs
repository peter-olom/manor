export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'qa-output/manor.png', fullPage: true });
  const info = await page.evaluate(() => {
    const getTextEls = (substr) => {
      const all = Array.from(document.querySelectorAll('*'));
      return all.filter(el => el.textContent && el.textContent.toLowerCase().includes(substr.toLowerCase()));
    };
    const acceptedEls = getTextEls('Accepted');
    console.log('Found accepted elements:', acceptedEls.length);
    acceptedEls.forEach((el, i) => {
      console.log(`Accepted el ${i}:`, el.tagName, el.className, el.textContent.trim());
    });
    // Find butler pane: look for element with class or id containing butler
    const butlerCandidates = Array.from(document.querySelectorAll('[class*="butler" i], [id*="butler" i]'));
    console.log('Butler candidates:', butlerCandidates.map(c => ({tag: c.tagName, class: c.className, id: c.id})));
    const butlerPane = butlerCandidates.find(c => c.offsetWidth > 0 && c.offsetHeight > 0);
    console.log('Selected butler pane:', butlerPane ? {tag: butlerPane.tagName, class: butlerPane.className, id: butlerPane.id} : null);
    // Find worker pane
    const workerCandidates = Array.from(document.querySelectorAll('[class*="worker" i], [id*="worker" i]'));
    console.log('Worker candidates:', workerCandidates.map(c => ({tag: c.tagName, class: c.className, id: c.id})));
    const workerPane = workerCandidates.find(c => c.offsetWidth > 0 && c.offsetHeight > 0);
    console.log('Selected worker pane:', workerPane ? {tag: workerPane.tagName, class: workerPane.className, id: workerPane.id} : null);
    // If we have accepted element, see which butler pane contains it
    let acceptedInButler = false;
    if (acceptedEls.length > 0 && butlerPane) {
      acceptedInButler = acceptedEls.some(el => butlerPane.contains(el));
      console.log('Accepted in butler?', acceptedInButler);
    }
    // Determine verdict panel: parent of accepted with some class
    let verdictEl = null;
    if (acceptedEls.length > 0) {
      verdictEl = acceptedEls[0].parentElement;
      while (verdictEl && !verdictEl.classList.contains('verdict-panel') && !verdictEl.classList.contains('review-verdict') && !verdictEl.classList.contains('panel') && !verdictEl.isEqualNode(document.body)) {
        verdictEl = verdictEl.parentElement;
      }
      if (!verdictEl || verdictEl.isEqualNode(document.body)) verdictEl = acceptedEls[0];
    }
    console.log('Verdict element:', verdictEl ? {tag: verdictEl.tagName, class: verdictEl.className, id: verdictEl.id} : null);
    // Compute margins if possible
    let margin = null;
    let layoutOk = false;
    if (verdictEl && butlerPane) {
      const verdictRect = verdictEl.getBoundingClientRect();
      // Find messages container: assume it's the element that follows verdict within butler pane
      // Let's get all children of butler pane and find the one that contains many text nodes
      const children = Array.from(butlerPane.children);
      console.log('Butler pane children count:', children.length);
      children.forEach((c, i) => {
        console.log(`  child ${i}:`, c.tagName, c.className, c.textContent?.substring(0,50));
      });
      // Heuristic: the child after the one containing the accepted badge
      const acceptedChildIndex = children.findIndex(c => c.contains(acceptedEls[0]));
      console.log('Accepted child index:', acceptedChildIndex);
      let messagesContainer = null;
      if (acceptedChildIndex >= 0 && acceptedChildIndex + 1 < children.length) {
        messagesContainer = children[acceptedChildIndex + 1];
        console.log('Messages container candidate:', messagesContainer.tagName, messagesContainer.className);
      } else {
        // fallback: use butler pane itself
        messagesContainer = butlerPane;
      }
      const messagesRect = messagesContainer.getBoundingClientRect();
      margin = messagesRect.top - verdictRect.bottom;
      console.log(`Verdict bottom: ${verdictRect.bottom}, Messages top: ${messagesRect.top}, margin: ${margin}`);
      layoutOk = margin > 5;
    }
    const workerOk = !!workerPane && workerPane.offsetWidth > 0 && workerPane.offsetHeight > 0;
    return { layoutOk, workerOk, margin, acceptedElsCount: acceptedEls.length, butlerPane: !!butlerPane, workerPane: !!workerPane };
  });
  console.log('Info:', info);
  return { layoutOk: info.layoutOk, workerOk: info.workerOk };
};