import fs from 'fs';

export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(5000);

  // Take a full page screenshot
  await page.screenshot({ path: artifacts.dir + '/debug-full.png', fullPage: true });

  // Get the outerHTML of the body to see what we have
  const bodyHtml = await page.evaluate(() => document.body.innerHTML);
  await fs.promises.writeFile(artifacts.dir + '/debug-body.html', bodyHtml);

  // Try to find any element containing "Task outputs"
  const els = await page.evaluate(() => {
    const matches = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.textContent && el.textContent.includes('Task outputs')) {
        matches.push({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          text: el.textContent.trim().slice(0, 100)
        });
      }
    }
    return matches;
  });
  await fs.promises.writeFile(artifacts.dir + '/debug-task-outputs.txt', JSON.stringify(els, null, 2));

  // Also get the dimensions of the viewport and maybe find panes by position
  const rects = await page.evaluate(() => {
    const pans = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100 && rect.left > window.innerWidth / 2) {
        // likely right pane
        pans.push({
          tag: el.tagName,
          class: el.className,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        });
      }
    }
    return pans;
  });
  await fs.promises.writeFile(artifacts.dir + '/debug-right-pane-candidates.txt', JSON.stringify(rects, null, 2));
};