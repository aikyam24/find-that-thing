// This function is injected with chrome.scripting.executeScript; keep it self-contained.
export function capturePage() {
  if (!['http:', 'https:'].includes(location.protocol)) throw new Error('Open an ordinary web page to save it.');
  const MAX = 50_000;
  const excluded = 'script,style,noscript,template,nav,header,footer,aside,form,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]';
  const isVisibleRoot = element => {
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent.matches(excluded)) return false;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  const root = ['article', 'main', '[role="main"]', 'body'].flatMap(selector => [...document.querySelectorAll(selector)]).find(isVisibleRoot);
  if (!root) throw new Error('No readable page content found.');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches(excluded)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(excluded)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  let node;
  let previousBlock = null;
  let truncated = false;
  while ((node = walker.nextNode())) {
    const block = node.parentElement.closest('p,li,h1,h2,h3,h4,pre,blockquote,section,div,td') || root;
    const separator = previousBlock && previousBlock !== block ? '\n\n' : ' ';
    text += separator + node.textContent.replace(/\s+/g, ' ').trim();
    previousBlock = block;
    if (text.length > MAX) { truncated = true; text = text.slice(0, MAX); break; }
  }
  // Selection is read only from content that is also eligible for extraction.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode) {
    const start = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
    const end = selection.focusNode.nodeType === 1 ? selection.focusNode : selection.focusNode.parentElement;
    const selected = selection.toString().trim().slice(0, 3000);
    if (selected && !start?.closest(excluded) && !end?.closest(excluded) && text.includes(selected)) {
      text = `${selected}\n\n${text}`.slice(0, MAX);
    }
  }
  return { url: location.href, title: document.title, text: text.trim(), truncated };
}
