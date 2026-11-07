import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Clipboard, Trash2, Check, Search, ImagePlus, Download, X, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import type { Clip } from './types';
import { useClips } from './hooks/useClips';
import { isImageFile } from './utils/images';
import { ClipDiscussion } from './components/ClipDiscussion';

export default function CloudClipboard() {
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<Clip | null>(null);
  /** 大图是否已经解码完成，用来决定要不要显示「正在加载原图」 */
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(1);
  const { clips, uploadingCount, addText, uploadFiles: queueFiles, deleteClip, setStatus } = useClips(setToast);

  const copyTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [preview]);

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

  /**
   * 列表显示的地址，优先顺序：
   * 缩略图（几十 KB）→ 本地 blob（刚上传，零延迟）→ 原图（老记录没有缩略图）
   */
  const displayUrl = (clip: Clip) => {
    if (clip.thumb) return `/api/media/${clip.thumb}`;
    if (clip.localUrl) return clip.localUrl;
    return mediaUrl(clip);
  };

  const uploadFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter(isImageFile);
    if (!images.length) {
      setToast('请选择图片；Live Photo 请选静态照片，暂不支持 MOV 视频');
      return;
    }
    if (images.length !== files.length) setToast('已跳过非图片文件，Live Photo 仅保存静态照片');
    queueFiles(images, retentionDays);
  }, [queueFiles, retentionDays]);

  // 直接 Ctrl+V 粘贴截图
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files || []);
      const images = files.filter(isImageFile);
      if (images.length === 0) return;

      event.preventDefault();
      uploadFiles(images);
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFiles]);

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

  const addClip = async (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !input.trim()) return;
    const content = input.trim();
    setInput('');
    if (!await addText(content, retentionDays)) setInput(current => current || content);
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
        accept="image/*,.heic,.heif,.hif"
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

          <div className="max-w-xl mx-auto mt-3 flex items-center justify-between gap-2 text-xs text-zinc-500">
            <span>新素材保留时间</span>
            <select aria-label="新素材保留时间" value={retentionDays} onChange={event => setRetentionDays(Number(event.target.value))} className="bg-[#141414] border border-white/10 rounded-lg px-2 py-1 text-zinc-300">
              <option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option>
            </select>
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
                            aria-label="删除素材"
                            disabled={clip.pending}
                            onClick={() => void deleteClip(clip)}
                            className="p-2 bg-red-500/5 border border-red-500/10 rounded-xl text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-30 disabled:cursor-wait"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {clip.type === 'image' ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (clip.pending) return;
                            setPreviewLoaded(false);
                            setPreviewError(false);
                            setPreview(clip);
                          }}
                          className="relative block w-full rounded-xl overflow-hidden cursor-zoom-in"
                        >
                          <img
                            src={displayUrl(clip)}
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
                      <ClipDiscussion clip={clip} onStatus={setStatus} />
                      <p className="text-[10px] text-zinc-600">保留至 {new Date(clip.expires_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
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
            <div className="relative flex items-center justify-center max-w-full max-h-full">
              {/* 原图几 MB，慢链路上要等很久；先用缩略图放大铺底，
                  至少让人立刻看到图长什么样，而不是一片黑 */}
              {preview.thumb && !previewLoaded && (
                <img
                  src={`/api/media/${preview.thumb}`}
                  alt=""
                  className="absolute max-w-full max-h-full object-contain rounded-2xl blur-2xl scale-105 opacity-50"
                />
              )}
              <motion.img
                src={mediaUrl(preview)}
                alt=""
                onLoad={() => setPreviewLoaded(true)}
                onError={() => { setPreviewLoaded(true); setPreviewError(true); }}
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.94, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                className="relative max-w-full max-h-full object-contain rounded-2xl shadow-2xl"
              />
              {!previewLoaded && (
                <div className="absolute flex flex-col items-center gap-2 text-zinc-400 pointer-events-none">
                  <Loader2 size={22} className="animate-spin" />
                  <span className="text-[11px] font-light tracking-wide">正在加载原图</span>
                </div>
              )}
              {previewError && <p role="alert" className="absolute text-sm text-zinc-300">原图加载失败，素材可能已过期，请关闭后重试</p>}
            </div>
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
