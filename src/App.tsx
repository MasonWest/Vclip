import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Clipboard, Trash2, Link as LinkIcon, Check, Plus, Search } from 'lucide-react';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export default function CloudClipboard() {
  const [clips, setClips] = useState([]);
  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState(null);

  const fetchClips = async () => {
    const { data, error } = await supabase
      .from('clips')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (!error) setClips(data || []);
  };

  useEffect(() => {
    fetchClips();
  }, []);

  const addClip = async (e) => {
    if (e.key !== 'Enter' || !input.trim()) return;

    const newContent = input.trim();
    setInput("");

    // 1. 乐观更新：本地直接插入一条临时记录
    const tempId = Date.now();
    const newClip = {
      id: tempId,
      content: newContent,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };
    setClips(prev => [newClip, ...prev].slice(0, 20));

    // 2. 后台同步到 Supabase
    const { data: currentClips } = await supabase.from('clips').select('id').order('created_at', { ascending: true });
    if (currentClips && currentClips.length >= 20) {
        await supabase.from('clips').delete().eq('id', currentClips[0].id);
    }
    
    const { data, error } = await supabase.from('clips').insert([{ content: newContent }]).select();
    
    // 3. 校验并替换真实数据
    if (!error && data) {
      setClips(prev => prev.map(c => c.id === tempId ? data[0] : c));
    } else {
      fetchClips(); // 如果出错则回滚刷新
    }
  };

  const [deletingId, setDeletingId] = useState(null);

  const deleteClip = async (id) => {
    setDeletingId(id);
    await supabase.from('clips').delete().eq('id', id);
    fetchClips();
    setTimeout(() => setDeletingId(null), 1000);
  };

  const copyToClipboard = async (text, id) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-zinc-300 font-sans selection:bg-blue-500/30">
      {/* 顶部搜索/输入框 - Raycast 风格 */}
      <div className="sticky top-0 z-10 p-4 lg:p-8 bg-[#0A0A0A]/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto relative group">
          <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
            <Search size={18} className="text-zinc-500 group-focus-within:text-blue-400 transition-colors" />
          </div>
          <input
            type="text"
            placeholder="Command + K 或输入内容粘贴..."
            className="w-full bg-[#121212] border border-zinc-800 rounded-xl py-4 pl-12 pr-4 text-zinc-100 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 transition-all shadow-2xl"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={addClip}
          />
        </div>
      </div>

      {/* 剪贴板列表 */}
      <main className="max-w-2xl mx-auto px-4 pb-20 space-y-3">
        {clips.map((clip) => (
          <div 
            key={clip.id}
            className={`group relative bg-[#121212] border border-zinc-800/50 rounded-xl p-4 hover:border-zinc-600 transition-all duration-300 ${deletingId === clip.id ? 'opacity-20 scale-95' : 'opacity-100'}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {/* 内容预览 */}
                {clip.type === 'file' ? (
                  <div className="flex items-center gap-2 text-blue-400 hover:underline cursor-pointer">
                    <LinkIcon size={16} />
                    <span className="truncate text-sm font-medium">{clip.content}</span>
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-zinc-300 break-words line-clamp-6">
                    {deletingId === clip.id ? <span className="text-red-500 italic">正在删除...</span> : clip.content}
                  </p>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] text-zinc-600 uppercase tracking-widest">
                    {new Date(clip.created_at).toLocaleTimeString()}
                  </span>
                  {copiedId === clip.id && (
                    <span className="text-[10px] text-blue-500 font-medium animate-pulse">已复制</span>
                  )}
                </div>
              </div>

              {/* 操作按钮组 - 增加触控面积 */}
              <div className="flex items-center gap-2 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => copyToClipboard(clip.content, clip.id)}
                  className="p-4 bg-zinc-800/50 lg:bg-transparent rounded-xl text-zinc-300 hover:text-white transition-colors active:scale-90"
                >
                  {copiedId === clip.id ? <Check size={20} className="text-green-500" /> : <Clipboard size={20} />}
                </button>
                <button 
                  onClick={() => deleteClip(clip.id)}
                  className={`p-4 bg-red-950/20 lg:bg-transparent rounded-xl transition-colors active:scale-90 ${deletingId === clip.id ? 'text-red-500 animate-pulse' : 'text-red-400 hover:text-red-500'}`}
                >
                  <Trash2 size={20} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </main>

      {/* 移除浮动按钮 */}
    </div>
  );
}