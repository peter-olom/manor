export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const verdict = document.querySelector('.butler-review-verdict');
    if (!verdict) return {error: 'no verdict'};
    let parent = verdict.parentElement;
    let depth = 0;
    const parts = [];
    while (parent && depth < 5) {
      const rect = parent.getBoundingClientRect();
      parts.push({
        tag: parent.tagName,
        class: parent.className,
        id: parent.id,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      parent = parent.parentElement;
      depth++;
    }
    // get next siblings of verdict
    const nextSibs = [];
    let sib = verdict.nextElementSibling;
    while (sib && nextSibs.length < 5) {
      const rect = sib.getBoundingClientRect();
      nextSibs.push({
        tag: sib.tagName,
        class: sib.className,
        id: sib.id,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      sib = sib.nextElementSibling;
    }
    return {
      verdictTag: verdict.tagName,
      verdictClass: verdict.className,
      verdictText: verdict.textContent.trim().slice(0,100),
      ancestors: parts,
      nextSiblings: nextSibs
    };
  });
  console.log(info);
};