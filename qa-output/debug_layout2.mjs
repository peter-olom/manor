export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll('.pane'));
    console.log('Found panes:', panes.map(p => {
      const r = p.getBoundingClientRect();
      return {left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height)};
    }));
    // choose the one with smallest left (should be left pane)
    if (panes.length === 0) return {error: 'No panes'};
    let leftPane = panes[0];
    let minLeft = leftPane.getBoundingClientRect().left;
    for (const p of panes) {
      const left = p.getBoundingClientRect().left;
      if (left < minLeft) {
        minLeft = left;
        leftPane = p;
      }
    }
    const leftRect = leftPane.getBoundingClientRect();
    console.log('Selected left pane left:', leftRect.left, 'width:', leftRect.width);
    // Find verdict within left pane
    const verdictEls = Array.from(leftPane.querySelectorAll('*')).filter(el => 
      el.textContent && el.textContent.trim().startsWith('Accepted')
    );
    console.log('Verdict elements count:', verdictEls.length);
    if (verdictEls.length === 0) return {error: 'No verdict'};
    const verdictEl = verdictEls[0];
    // Find message container: look for element with class containing 'message' or 'chat' within leftPane
    const msgEls = Array.from(leftPane.querySelectorAll('[class*="message"], [class*="chat"], [class*="log"]'));
    console.log('Message-like elements count:', msgEls.length);
    let msgEl = null;
    if (msgEls.length > 0) {
      // pick the one with largest area
      msgEl = msgEls.reduce((max, el) => {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        return area > (max ? (max.r.width * max.r.height) : 0) ? {el, r} : max;
      }, null).el;
    }
    // If not found, find the element that comes after verdict in DOM order within leftPane
    if (!msgEl) {
      // get all children of leftPane
      const children = Array.from(leftPane.children);
      const verdictIdx = children.findIndex(c => c.contains(verdictEl));
      console.log('Verdict index in children:', verdictIdx);
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
    // If still not found, use the element that has the most text nodes after verdict? fallback to a div that holds messages
    if (!msgEl) {
      // maybe messages are in a div with class 'messages' or similar
      const possible = Array.from(leftPane.querySelectorAll('div')).filter(div => {
        const classes = div.className;
        return classes.includes('message') || classes.includes('chat') || classes.includes('log') || classes.includes('body');
      });
      if (possible.length > 0) {
        msgEl = possible[0];
      }
    }
    if (!msgEl) {
      // as last resort, use the element that occupies the largest vertical space below verdict
      const allEls = Array.from(leftPane.querySelectorAll('*')).filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
      const verdictRect = verdictEl.getBoundingClientRect();
      const candidates = allEls.filter(el => {
        const r = el.getBoundingClientRect();
        return r.top > verdictRect.bottom; // strictly below
      });
      if (candidates.length > 0) {
        msgEl = candidates.reduce((max, el) => {
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          return area > (max ? (max.r.width * max.r.height) : 0) ? {el, r} : max;
        }, null).el;
      }
    }
    if (!msgEl) {
      return {error: 'Message container not found', verdictEl: verdictEl.outerHTML.substring(0,200)};
    }
    const vRect = verdictEl.getBoundingClientRect();
    const mRect = msgEl.getBoundingClientRect();
    const margin = mRect.top - vRect.bottom;
    // Check overlap among potential message items
    const messageItems = Array.from(msgEl.querySelectorAll('[class*="message-item"], [class*="chat-line"], .message, .entry')).filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
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
      leftPaneRect: {x:Math.round(leftRect.left), y:Math.round(leftRect.top), w:Math.round(leftRect.width), h:Math.round(leftRect.height)}
    };
  });
  console.log(info);
};