import React, { useState, useEffect, useRef } from 'react';
import { Clipboard, Trash2, Check, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface Clip {
  id: number;
  content: string;
  created_at: string;
  expires_at: string;
  type?: 'text' | 'file';
}

export default function CloudClipboard() {
  const currentPath = window.location.pathname.replace(/^\/|\/$/g, '').toLowerCase();
  const secretPath = (import.meta.env.VITE_SECRET_PATH || '').replace(/^\/|\/$/g, '').toLowerCase();

  const [clips, setClips] = useState<Clip[]>([]);
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const fetchClips = async () => {
    try {
      const response = await fetch('/api/clips');
      if (!response.ok) throw new Error('Fetch failed');
      const data = await response.json();
      setClips(data);
    } catch (error) {
      console.error('Error fetching clips:', error);
    }
  };

  useEffect(() => {
    fetchClips();
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const addClip = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !input.trim()) return;

    const newContent = input.trim();
    setInput('');

    const tempId = Date.now();
    const newClip: Clip = {
      id: tempId,
      content: newContent,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      type: 'text',
    };

    setClips(prev => [newClip, ...prev].slice(0, 20));

    try {
      const response = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      });
      if (!response.ok) throw new Error('Insert failed');
      const savedClip = await response.json();
      setClips(prev => prev.map(c => (c.id === tempId ? savedClip : c)));
    } catch (error) {
      console.error('Error adding clip:', error);
      fetchClips();
    }
  };

  const deleteClip = async (id: number) => {
    setClips(prev => prev.filter(c => c.id !== id));
    try {
      const response = await fetch(`/api/clips/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Delete failed');
    } catch (error) {
      console.error('Error deleting clip:', error);
      fetchClips();
    }
  };

  const fallbackCopyText = (text: string) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', 'true');
    textArea.style.position = 'fixed';
    textArea.style.top = '-9999px';
    textArea.style.left = '-9999px';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const success = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (!success) {
      throw new Error('document.execCommand("copy") failed');
    }
  };

  const copyToClipboard = async (text: string, id: number) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopyText(text);
      }

      setCopiedId(id);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedId(null);
        copyTimerRef.current = null;
      }, 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  if (currentPath !== secretPath) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#030303] text-zinc-600 font-mono tracking-tighter">
        404 // NOT_FOUND
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-300 font-sans selection:bg-indigo-500/30 overflow-x-hidden relative">
      <div className="fixed inset-0 bg-grain pointer-events-none z-[1]" />
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-700/25 rounded-full blur-[120px]" />
        <div className="absolute bottom-[5%] right-[-5%] w-[40%] h-[40%] bg-blue-700/20 rounded-full blur-[100px]" />
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(ellipse at center, transparent 0%, rgba(8,8,8,0.5) 50%, #050505 100%)',
          }}
        />
      </div>

      <div className="relative z-10">
        <div className="sticky top-0 z-50 pt-8 pb-4 px-6 bg-[#050505]/40 backdrop-blur-2xl border-b border-white/[0.03]">
          <div className="max-w-xl mx-auto relative group">
            <input
              type="text"
              placeholder="粘贴并回车同步..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={addClip}
              className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-12 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/40 transition-all shadow-[0_0_30px_rgba(0,0,0,0.5)]"
            />
            <Search
              className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-indigo-400 transition-colors"
              size={18}
            />
          </div>
        </div>

        <main className="max-w-xl mx-auto px-6 py-8">
          <div className="space-y-4">
            <AnimatePresence mode="popLayout" initial={false}>
              {clips.map((clip) => (
                <motion.div
                  key={clip.id}
                  layout
                  initial={{ opacity: 0, y: -20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  transition={{ type: 'spring', stiffness: 350, damping: 25, layout: { duration: 0.3 } }}
                  className="group relative"
                >
                  <div className="bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] rounded-2xl p-5 hover:bg-white/[0.07] hover:border-white/[0.14] transition-all duration-300 shadow-xl overflow-hidden">
                    <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white/[0.05] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/80" />
                          <span className="text-[10px] font-mono text-zinc-500 tracking-widest uppercase">
                            {new Date(clip.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            aria-label="复制"
                            onClick={() => copyToClipboard(clip.content, clip.id)}
                            className="p-2 bg-white/[0.02] border border-white/5 rounded-xl text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-all"
                          >
                            {copiedId === clip.id ? <Check size={14} className="text-green-500" /> : <Clipboard size={14} />}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteClip(clip.id)}
                            className="p-2 bg-red-500/5 border border-red-500/10 rounded-xl text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      <div className="min-w-0 pr-4 text-sm leading-relaxed text-zinc-300 font-light selection:bg-indigo-500/50 break-words whitespace-pre-wrap">
                        {clip.content}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
