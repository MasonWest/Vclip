import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip, Comment } from '../types';

interface Props {
  clip: Clip;
  onStatus: (id: number, status: 'pending' | 'done') => Promise<void>;
}

export function ClipDiscussion({ clip, onStatus }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState('');
  const [author, setAuthor] = useState(() => {
    try { return localStorage.getItem('vclip-nickname') || ''; } catch { return ''; }
  });
  const [reply, setReply] = useState<Comment | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const sendingRef = useRef(false);
  const serial = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const invalidate = useCallback(() => { serial.current++; }, []);

  const load = useCallback(async () => {
    if (sendingRef.current) return;
    const request = ++serial.current;
    try {
      const response = await fetch(`/api/clips/${clip.id}/comments`);
      if (!response.ok) throw new Error('无法读取留言，素材可能已过期');
      const rows: Comment[] = await response.json();
      if (request !== serial.current || sendingRef.current) return;
      setComments(rows);
      setLoaded(true);
      setError('');
    } catch (error) {
      if (request === serial.current) setError(error instanceof Error ? error.message : '读取失败');
    }
  }, [clip.id]);

  useEffect(() => {
    if (!expanded) return;
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); invalidate(); };
  }, [expanded, load, invalidate]);

  const send = async () => {
    if (sendingRef.current || !draft.trim()) return;
    sendingRef.current = true;
    serial.current++;
    setSending(true);
    setError('');
    try {
      const response = await fetch(`/api/clips/${clip.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft.trim(), author: author.trim(), reply_to: reply?.id ?? null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '发送失败');
      setComments(prev => [...prev.filter(comment => comment.id !== result.id), result]);
      setLoaded(true);
      setDraft('');
      setReply(null);
      try { localStorage.setItem('vclip-nickname', author.trim()); } catch { /* 隐私模式仍可留言 */ }
    } catch (error) { setError(error instanceof Error ? error.message : '发送失败，内容已保留'); }
    finally { sendingRef.current = false; setSending(false); }
  };

  if (clip.pending) return null;
  return (
    <div className="border-t border-white/5 pt-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="text-xs text-zinc-400 hover:text-indigo-300 py-1">
          {expanded ? '收起留言' : '追加 / 回复'} · {loaded ? comments.length : clip.comment_count || 0}
        </button>
        <button type="button" disabled={updating} onClick={async () => {
          setUpdating(true);
          try { await onStatus(clip.id, clip.status === 'done' ? 'pending' : 'done'); }
          finally { setUpdating(false); }
        }} className={`text-xs px-3 py-1.5 rounded-lg border disabled:opacity-50 ${clip.status === 'done' ? 'text-green-300 border-green-500/20 bg-green-500/10' : 'text-zinc-400 border-white/10 hover:text-white'}`}>
          {clip.status === 'done' ? '已完成 · 撤回标记' : '标记已完成'}
        </button>
      </div>
      {expanded && (
        <div className="space-y-3" aria-label="素材留言">
          {!loaded && !error && <p className="text-xs text-zinc-500">正在读取留言…</p>}
          {loaded && comments.length === 0 && <p className="text-xs text-zinc-500">补充说明、反馈进度，或回复朋友的留言。</p>}
          <div className="max-h-80 overflow-y-auto space-y-3">
            {comments.map(comment => {
              const original = comments.find(row => row.id === comment.reply_to);
              return (
                <div key={comment.id} className="rounded-xl bg-white/[0.025] p-3 text-sm">
                  <div className="flex justify-between gap-2 text-[11px] text-zinc-500 mb-2">
                    <span>{comment.author || '未署名'} · {new Date(comment.created_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    <button type="button" onClick={() => { setReply(comment); inputRef.current?.focus(); }} className="text-indigo-400 shrink-0">回复</button>
                  </div>
                  {original && <blockquote className="border-l-2 border-indigo-500/40 pl-2 mb-2 text-xs text-zinc-500 whitespace-pre-wrap break-words">{original.author || '未署名'}：{original.content.slice(0, 160)}</blockquote>}
                  <p className="whitespace-pre-wrap break-words text-zinc-300">{comment.content}</p>
                </div>
              );
            })}
          </div>
          {reply && <div className="flex justify-between gap-2 text-xs text-indigo-300"><span className="truncate">回复 {reply.author || '未署名'}：{reply.content.slice(0, 60)}</span><button type="button" onClick={() => setReply(null)} className="shrink-0">取消回复</button></div>}
          <input aria-label="留言昵称" value={author} disabled={sending} maxLength={40} onChange={event => setAuthor(event.target.value)} placeholder="你的昵称（可选，仅用于区分留言）" className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-indigo-500/50" />
          <textarea ref={inputRef} aria-label="补充留言" value={draft} disabled={sending} maxLength={4000} rows={3} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} placeholder="写下说明或进度，Enter 换行…" className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-indigo-500/50 resize-y" />
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
          <div className="flex items-center justify-between text-xs text-zinc-500"><span>{draft.length} / 4000</span><button type="button" disabled={sending || !draft.trim()} onClick={() => void send()} className="px-4 py-2 rounded-lg bg-indigo-500/20 text-indigo-200 disabled:opacity-40">{sending ? '发送中…' : '发送留言'}</button></div>
        </div>
      )}
    </div>
  );
}
