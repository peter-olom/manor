export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const getRect = el => { const r = el.getBoundingClientRect(); return {x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height)}; };
    // left pane: first element with class 'pane' at left 0
    const panes = Array.from(document.querySelectorAll('.pane'));
    const leftPane = panes.find(p => {
      const r = p.getBoundingClientRect();
      return Math.round(r.left) === 0;
    });
    if (!leftPane) return {error: 'Left pane not found'};
    // Find verdict within left pane
    const verdictEls = Array.from(leftPane.querySelectorAll('*')).filter(el => 
      el.textContent && el.textContent.trim().startsWith('Accepted')
    );
    const verdictEl = verdictEls[0];
    if (!verdictEl) return {error: 'Verdict not found'};
    // Find message container: maybe element with class containing 'message' or 'chat' within leftPane
    const msgEls = Array.from(leftPane.querySelectorAll('[class*="message"], [class*="chat"], [class*="log"]'));
    let msgEl = null;
    if (msgEls.length > 0) {
      // choose the one with largest height maybe
      msgEl = msgEls.reduce((max, el) => {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        return area > (max ? (max.r.width * max.r.height) : 0) ? {el, r} : max;
      }, null).el;
    }
    // If not found, use the element that follows verdict in DOM order within leftPane
    if (!msgEl) {
      // get all children of leftPane
      const children = Array.from(leftPane.children);
      const verdictIdx = children.findIndex(c => c.contains(verdictEl));
      if (verdictIdx >= 0 && verdictIdx + 1 < children.length) {
        // look ahead for a container with multiple children
        for (let i = verdictIdx + 1; i < children.length; i++) {
          const child = children[i];
          if (child.children.length > 0) {
            msgEl = child;
            break;
          }
        }
      }
    }
    if (!msgEl) {
      // fallback: use leftPane itself (but then we can't measure margin)
      msgEl = leftPane;
    }
    const vRect = verdictEl.getBoundingClientRect();
    const mRect = msgEl.getBoundingClientRect();
    const margin = mRect.top - vRect.bottom;
    // Check overlapping among message children if they are elements with class 'message-item' etc.
    const messageItems = Array.from(msgEl.querySelectorAll('[class*="message-item"], [class*="chat-line"], .message')).filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
    let messagesOverlap = false;
    for (let i = 0; i < messageItems.length - 1; i++) {
      const a = messageItems[i].getBoundingClientRect();
      const b = messageItems[i+1].getBoundingClientRect();
      if (!(a.bottom <= b.top || b.bottom <= a.top)) {
        messagesOverlap = true;
        break;
      }
    }
    return {
      verdictText: verdictEl.textContent.trim().substring(0,100),
      verdictRect: {x:Math.round(vRect.left), y:Math.round(vRect.top), w:Math.round(vRect.width), h:Math.round(vRect.height)},
      msgRect: {x:Math.round(mRect.left), y:Math.round(mRect.top), w:Math.round(mRect.width), h:Math.round(mRect.height)},
      margin: Math.round(margin),
      messageItemsCount: messageItems.length,
      messagesOverlap,
      leftPaneRect: {x:Math.round(leftPane.getBoundingClientRect().left), y:Math.round(leftPane.getBoundingClientRect().top), w:Math.round(leftPane.getBoundingClientRect().width), h:Math.round(leftPane.getBoundingClientRect().height)}
    };
  });
  console.log('Layout info:', info);
};