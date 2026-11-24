/** 普通文本和提示词共用；内网 HTTP 下同步使用 execCommand，保留点击手势。 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* 浏览器拒绝时尝试兼容路径 */ }
  }
  const active = document.activeElement;
  const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
    ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:16px';
  // dialog 中的元素之外会被设为 inert，将辅助输入放进当前模态框。
  (document.querySelector('dialog[open]') || document.body).appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!document.execCommand('copy')) throw new Error('复制失败，请长按选择文本');
  } finally {
    textarea.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (selection?.start !== null && selection?.end !== null && selection
      && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) active.setSelectionRange(selection.start, selection.end);
  }
}
