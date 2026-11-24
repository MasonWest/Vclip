import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clipboard, Pencil, X } from 'lucide-react';
import type { Clip, PromptSaveResult, PromptValue } from '../types';
import { copyText } from '../utils/clipboard';

const MAX_PROMPT_LENGTH = 100_000;
const draftKey = (id: number) => `vclip-prompt-draft:${id}`;

function readDraft(id: number, value: PromptValue): PromptValue {
  try {
    const stored = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null');
    if (stored && typeof stored.prompt === 'string' && Number.isSafeInteger(stored.prompt_version)) return stored;
  } catch { /* 存储不可用时仍可编辑 */ }
  return value;
}

interface EditorProps {
  id: number;
  value: PromptValue;
  onSave: (id: number, prompt: string, version: number) => Promise<PromptSaveResult>;
  onClose: () => void;
}

function PromptEditor({ id, value, onSave, onClose }: EditorProps) {
  const [draft, setDraft] = useState(() => readDraft(id, value));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [latest, setLatest] = useState<PromptValue | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const dialog = dialogRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();
    inputRef.current?.focus({ preventScroll: true });
    return () => { dialog?.close(); document.body.style.overflow = overflow; window.clearTimeout(copyTimer.current); };
  }, []);

  const changeDraft = (next: PromptValue) => {
    setDraft(next);
    try { sessionStorage.setItem(draftKey(id), JSON.stringify(next)); } catch { /* 保留内存中的编辑内容 */ }
  };

  const save = async (version = draft.prompt_version) => {
    if (savingRef.current || draft.prompt.length > MAX_PROMPT_LENGTH) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await onSave(id, draft.prompt, version);
      if (!result.ok) { setError(result.error); setLatest(result.latest || null); return; }
      try { sessionStorage.removeItem(draftKey(id)); } catch { /* 不影响保存 */ }
      onClose();
    } finally { savingRef.current = false; setSaving(false); }
  };

  const copy = async () => {
    try {
      await copyText(draft.prompt);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch { setError('复制失败，请在编辑区长按或全选复制'); }
  };

  return createPortal(
    <dialog ref={dialogRef} aria-labelledby={`prompt-title-${id}`} onCancel={event => { event.preventDefault(); if (!savingRef.current) onClose(); }} className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-[#101014] text-zinc-200 p-0 border-0 backdrop:bg-black/75 sm:m-auto sm:h-[90dvh] sm:w-[min(1100px,94vw)] sm:rounded-2xl sm:border sm:border-white/10 shadow-2xl">
      <div className="h-full flex flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 shrink-0">
          <div><h2 id={`prompt-title-${id}`} className="text-base font-medium">编辑提示词</h2><p className="mt-1 text-xs text-zinc-500">直接粘贴或修改，关闭后保留当前草稿</p></div>
          <button type="button" aria-label="关闭编辑器" disabled={saving} onClick={onClose} className="rounded-xl p-2 text-zinc-400 hover:bg-white/10 disabled:opacity-40"><X size={20} /></button>
        </header>
        <textarea ref={inputRef} aria-label="提示词编辑区" value={draft.prompt} disabled={saving} maxLength={Math.max(MAX_PROMPT_LENGTH, draft.prompt.length)} onChange={event => changeDraft({ ...draft, prompt: event.target.value })} onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); }
        }} placeholder="把完整提示词粘贴到这里…" spellCheck={false} className="block w-full flex-1 min-h-0 resize-none bg-transparent px-5 py-5 sm:px-8 text-base leading-7 outline-none selection:bg-indigo-500/40 disabled:opacity-70" />
        {error && <div className="px-5 pb-3 text-xs text-red-300 shrink-0" role="alert">{error}</div>}
        {latest && <div className="mx-5 mb-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs shrink-0">
          <details><summary className="text-amber-200 cursor-pointer">查看其他设备的最新提示词</summary><p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words text-zinc-400">{latest.prompt || '（空提示词）'}</p></details>
          <div className="mt-3 flex flex-wrap gap-4">
            <button type="button" disabled={saving} onClick={() => { changeDraft(latest); setLatest(null); setError(''); }} className="text-zinc-300 underline">改用最新内容</button>
            <button type="button" disabled={saving} onClick={() => void save(latest.prompt_version)} className="text-amber-200 underline">保存我的版本</button>
          </div>
        </div>}
        <footer className="flex items-center justify-between gap-3 border-t border-white/10 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shrink-0">
          <div className="text-xs text-zinc-500"><span>{draft.prompt.length.toLocaleString()} 字</span><span className="hidden sm:inline"> · Ctrl / ⌘ + Enter 保存</span></div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={!draft.prompt || saving} onClick={() => void copy()} className="rounded-xl px-3 py-2.5 text-sm text-zinc-300 border border-white/10 disabled:opacity-40">{copied ? '已复制' : '复制全文'}</button>
            <button type="button" disabled={saving || draft.prompt.length > MAX_PROMPT_LENGTH} onClick={() => void save()} className="rounded-xl px-5 py-2.5 bg-indigo-500 text-white text-sm disabled:opacity-40">{saving ? '保存中…' : '保存提示词'}</button>
          </div>
        </footer>
      </div>
    </dialog>, document.body,
  );
}

interface Props {
  clip: Clip;
  onStatus: (id: number, status: 'pending' | 'done') => Promise<void>;
  onSave: EditorProps['onSave'];
}

export function ClipPrompt({ clip, onStatus, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const prompt = clip.prompt || '';
  if (clip.pending) return null;
  return (
    <div className="border-t border-white/5 pt-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">提示词{prompt ? ` · ${prompt.length.toLocaleString()} 字` : ''}</span>
        <div className="flex items-center gap-1.5">
          {prompt && <button type="button" aria-label={copied ? '提示词已复制' : '复制提示词'} onClick={async () => {
            try {
              await copyText(prompt); setCopied(true); setError(''); window.clearTimeout(copyTimer.current);
              copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
            } catch { setError('复制失败，请打开编辑器全选复制'); }
          }} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-xs text-zinc-300 hover:bg-white/5">{copied ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}{copied ? '已复制' : '复制'}</button>}
          <button type="button" aria-label={prompt ? '编辑提示词' : '添加提示词'} onClick={() => setEditing(true)} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-xs text-indigo-300 hover:bg-white/5"><Pencil size={13} />{prompt ? '编辑' : '添加提示词'}</button>
        </div>
      </div>
      {prompt ? <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300 select-text">{prompt.slice(0, 320)}{prompt.length > 320 ? '…' : ''}</p>
        : <button type="button" onClick={() => setEditing(true)} className="text-xs text-zinc-600 hover:text-zinc-400 py-1">给这张素材附上提示词</button>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <div className="flex justify-end">
        <button type="button" disabled={updating} onClick={async () => {
          setUpdating(true);
          try { await onStatus(clip.id, clip.status === 'done' ? 'pending' : 'done'); }
          finally { setUpdating(false); }
        }} className={`text-xs px-3 py-1.5 rounded-lg border disabled:opacity-50 ${clip.status === 'done' ? 'text-green-300 border-green-500/20 bg-green-500/10' : 'text-zinc-400 border-white/10 hover:text-white'}`}>{clip.status === 'done' ? '已完成 · 撤回标记' : '标记已完成'}</button>
      </div>
      {editing && <PromptEditor id={clip.id} value={{ prompt, prompt_version: clip.prompt_version || 0 }} onSave={onSave} onClose={() => setEditing(false)} />}
    </div>
  );
}
