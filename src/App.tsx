import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Clipboard, Trash2, Check, Search, ImagePlus, Download, X, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface Clip {
  id: number;
  content: string;
  created_at: string;
  expires_at: string;
  type?: 'text' | 'image';
  /** 仅前端使用：本地 objectURL 占位，上传完成后被服务端返回的行替换 */
  pending?: boolean;
  /**
   * 仅前端使用：稳定的列表 key。
   * 上传成功时 id 会从临时负数换成数据库 id，若直接用 id 当 key，
   * React 会把卡片当成新元素重建，图片闪一下再出来。
   */
  uid?: string;
}

/** 与服务端 MAX_IMAGE_BYTES 保持一致 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** 超过这个体积才压缩，小图直传保留原始质量 */
const COMPRESS_THRESHOLD = 900 * 1024;
/** 压缩后的长边上限 */
const MAX_EDGE = 2400;

/** 用 <img> 解码：兼容性比 createImageBitmap 好，且浏览器会自动套用照片的 EXIF 方向 */
function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

/**
 * 大图压到长边 2400 的 JPEG。
 * 手机直出照片动辄 4-6MB，压完通常 300-600KB，局域网里几乎瞬时。
 */
async function shrinkImage(file: File): Promise<Blob> {
  // GIF 可能带动画，重编码会丢帧，原样上传
  if (file.type === 'image/gif' || file.size <= COMPRESS_THRESHOLD) {
    return file;
  }

  try {
    const img = await loadImageElement(file);
    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    if (!naturalWidth || !naturalHeight) return file;

    const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    // 截图的透明区域在 JPEG 里会变成黑块，先铺白底
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', 0.86)
    );

    // 压完反而更大（原图本身已高度优化）就用原图
    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch {
    return file;
  }
}

export default function CloudClipboard() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<Clip | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const copyTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchClips = useCallback(async () => {
    try {
      const response = await fetch('/api/clips');
      if (!response.ok) throw new Error('Fetch failed');
      const data: Clip[] = await response.json();
      const rows = data.map(row => ({ ...row, uid: `srv-${row.id}` }));
      // 正在上传的本地占位要保住，否则一次切页面刷新就把它冲掉了
      setClips(prev => [...prev.filter(c => c.pending), ...rows]);
    } catch (error) {
      console.error('Error fetching clips:', error);
    }
  }, []);

  useEffect(() => {
    fetchClips();
  }, [fetchClips]);

  // 切回这个页面时刷新一次，跨设备同步不用手动刷
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchClips();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchClips]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const mediaUrl = (clip: Clip) =>
    clip.content.startsWith('blob:') ? clip.content : `/api/media/${clip.content}`;

  const uploadImage = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setToast('只能上传图片');
        return;
      }
      if (file.type === 'image/svg+xml') {
        setToast('不支持 SVG（出于安全考虑）');
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setToast('图片超过 8MB，请先压缩');
        return;
      }

      const tempId = -Date.now() - Math.floor(Math.random() * 1000);
      const localUrl = URL.createObjectURL(file);
      const uid = `tmp-${tempId}`;

      const placeholder: Clip = {
        id: tempId,
        content: localUrl,
        type: 'image',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        pending: true,
        uid,
      };

      setClips(prev => [placeholder, ...prev].slice(0, 100));
      setUploadingCount(n => n + 1);

      try {
        const blob = await shrinkImage(file);

        const response = await fetch('/api/clips', {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'image/jpeg' },
          body: blob,
        });

        if (!response.ok) {
          const info = await response.json().catch(() => ({}));
          throw new Error(info.error || `上传失败 (${response.status})`);
        }

        const saved: Clip = await response.json();
        setClips(prev => prev.map(c => (c.id === tempId ? { ...saved, uid } : c)));
      } catch (error) {
        setClips(prev => prev.filter(c => c.id !== tempId));
        setToast(error instanceof Error ? error.message : '上传失败');
      } finally {
        setUploadingCount(n => Math.max(0, n - 1));
        // 等 React 把 img 的 src 换成新地址后再释放本地 URL
        window.setTimeout(() => URL.revokeObjectURL(localUrl), 1500);
      }
    },
    []
  );

  const uploadFiles = useCallback(
    (files: FileList | File[]) => {
      const images = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (images.length === 0) {
        setToast('没有可上传的图片');
        return;
      }
      images.forEach(file => uploadImage(file));
    },
    [uploadImage]
  );

  // 直接 Ctrl+V 粘贴截图
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files || []);
      const images = files.filter(f => f.type.startsWith('image/'));
      if (images.length === 0) return;

      event.preventDefault();
      images.forEach(file => uploadImage(file));
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadImage]);

  // 拖拽上传
  useEffect(() => {
    let depth = 0;

    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types || []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    };

    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [uploadFiles]);

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
      uid: `tmp-${tempId}`,
    };

    setClips(prev => [newClip, ...prev].slice(0, 100));

    try {
      const response = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      });
      if (!response.ok) throw new Error('Insert failed');
      const savedClip = await response.json();
      setClips(prev =>
        prev.map(c => (c.id === tempId ? { ...savedClip, uid: `tmp-${tempId}` } : c))
      );
    } catch (error) {
      console.error('Error adding clip:', error);
      fetchClips();
    }
  };

  const deleteClip = async (id: number) => {
    const snapshot = clips;
    setClips(prev => prev.filter(c => c.id !== id));
    // 还在上传的占位卡片 id 是负数，服务端还没有这一行
    if (id <= 0) return;
    try {
      const response = await fetch(`/api/clips/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Delete failed');
    } catch (error) {
      console.error('Error deleting clip:', error);
      setClips(snapshot);
      setToast('删除失败，已恢复');
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
      setToast('复制失败，请长按选择');
    }
  };

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

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={e => {
          if (e.target.files?.length) uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* 拖拽提示层 */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] pointer-events-none flex items-center justify-center bg-[#050505]/80 backdrop-blur-sm"
          >
            <div className="px-10 py-8 rounded-3xl border-2 border-dashed border-indigo-500/50 bg-indigo-500/5 text-center">
              <ImagePlus className="mx-auto mb-3 text-indigo-400" size={32} />
              <p className="text-sm text-zinc-300 font-light">松开即可上传</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative z-10">
        <div className="sticky top-0 z-50 pt-8 pb-4 px-6 bg-[#050505]/40 backdrop-blur-2xl border-b border-white/[0.03]">
          <div className="max-w-xl mx-auto relative group">
            <input
              type="text"
              placeholder="粘贴文字回车同步，或直接粘贴截图..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={addClip}
              className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 pl-12 pr-14 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/40 transition-all shadow-[0_0_30px_rgba(0,0,0,0.5)]"
            />
            <Search
              className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-indigo-400 transition-colors"
              size={18}
            />
            <button
              type="button"
              aria-label="上传图片"
              onClick={() => fileInputRef.current?.click()}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-xl text-zinc-500 hover:text-indigo-300 hover:bg-white/[0.06] transition-all"
            >
              {uploadingCount > 0 ? (
                <Loader2 size={18} className="animate-spin text-indigo-400" />
              ) : (
                <ImagePlus size={18} />
              )}
            </button>
          </div>

          <AnimatePresence>
            {uploadingCount > 0 && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="max-w-xl mx-auto mt-2 text-[11px] font-mono text-indigo-400/80 tracking-wide"
              >
                正在上传 {uploadingCount} 张图片...
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <main className="max-w-xl mx-auto px-6 py-8">
          <div className="space-y-4">
            <AnimatePresence mode="popLayout" initial={false}>
              {clips.map((clip) => (
                <motion.div
                  key={clip.uid ?? clip.id}
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
                          {clip.type === 'image' && (
                            <span className="text-[10px] font-mono text-indigo-400/60 tracking-widest uppercase">
                              img
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {clip.type === 'image' ? (
                            <a
                              href={mediaUrl(clip)}
                              download={clip.pending ? undefined : clip.content}
                              aria-label="下载原图"
                              className="p-2 bg-white/[0.02] border border-white/5 rounded-xl text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-all"
                            >
                              <Download size={14} />
                            </a>
                          ) : (
                            <button
                              type="button"
                              aria-label="复制"
                              onClick={() => copyToClipboard(clip.content, clip.id)}
                              className="p-2 bg-white/[0.02] border border-white/5 rounded-xl text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-all"
                            >
                              {copiedId === clip.id ? (
                                <Check size={14} className="text-green-500" />
                              ) : (
                                <Clipboard size={14} />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => deleteClip(clip.id)}
                            className="p-2 bg-red-500/5 border border-red-500/10 rounded-xl text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {clip.type === 'image' ? (
                        <button
                          type="button"
                          onClick={() => !clip.pending && setPreview(clip)}
                          className="relative block w-full rounded-xl overflow-hidden cursor-zoom-in"
                        >
                          <img
                            src={mediaUrl(clip)}
                            alt=""
                            loading="lazy"
                            className="block mx-auto max-w-full max-h-[420px] w-auto h-auto opacity-0 transition-opacity duration-500"
                            onLoad={e => {
                              e.currentTarget.style.opacity = '1';
                            }}
                            onError={e => {
                              // 文件被外部删掉时别留一块空白，至少让用户看到发生了什么
                              const el = e.currentTarget;
                              el.style.opacity = '1';
                              el.style.minHeight = '72px';
                              el.alt = '图片加载失败';
                            }}
                          />
                          {clip.pending && (
                            <div className="absolute inset-0 flex items-center justify-center bg-[#050505]/60 backdrop-blur-[2px]">
                              <Loader2 size={22} className="animate-spin text-indigo-400" />
                            </div>
                          )}
                        </button>
                      ) : (
                        <div className="min-w-0 pr-4 text-sm leading-relaxed text-zinc-300 font-light selection:bg-indigo-500/50 break-words whitespace-pre-wrap">
                          {clip.content}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {clips.length === 0 && (
              <div className="pt-16 text-center text-zinc-600 text-sm font-light">
                <p>还没有内容</p>
                <p className="mt-2 text-xs text-zinc-700">
                  粘贴文字回车，或 Ctrl+V 直接粘截图
                </p>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* 大图预览 */}
      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPreview(null)}
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-6 cursor-zoom-out"
          >
            <motion.img
              src={mediaUrl(preview)}
              alt=""
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 26 }}
              className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl"
            />
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setPreview(null)}
              className="absolute top-6 right-6 p-2.5 rounded-full bg-white/10 text-zinc-200 hover:bg-white/20 transition-all"
            >
              <X size={18} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 轻提示 */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[110] px-5 py-3 rounded-2xl bg-white/[0.08] border border-white/10 backdrop-blur-xl text-sm text-zinc-200 shadow-2xl"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
