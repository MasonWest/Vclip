import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip } from '../types';
import { makeThumbnail, prepareImage } from '../utils/images';

export function useClips(notify: (message: string) => void) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const mutations = useRef({ version: 0, count: 0 });
  const requestSerial = useRef(0);
  const tempId = useRef(0);
  const deleting = useRef(new Set<number>());
  const uploadQueue = useRef(Promise.resolve());
  const localUrls = useRef(new Set<string>());

  const beginMutation = useCallback(() => {
    mutations.current.version++;
    mutations.current.count++;
    return () => {
      mutations.current.version++;
      mutations.current.count--;
    };
  }, []);

  const fetchClips = useCallback(async () => {
    if (mutations.current.count) return;
    const version = mutations.current.version;
    const serial = ++requestSerial.current;
    try {
      const response = await fetch('/api/clips');
      if (!response.ok) throw new Error(`读取失败 (${response.status})`);
      const rows: Clip[] = await response.json();
      if (serial !== requestSerial.current || version !== mutations.current.version || mutations.current.count) return;
      setClips(prev => {
        const existing = new Map(prev.map(clip => [clip.id, clip]));
        return rows.map(row => {
          const local = existing.get(row.id);
          return { ...row, uid: local?.uid || `srv-${row.id}`, localUrl: local?.localUrl };
        });
      });
    } catch (error) {
      console.error('读取剪贴板失败:', error);
    }
  }, []);

  useEffect(() => {
    void fetchClips();
    const refresh = () => { if (document.visibilityState === 'visible') void fetchClips(); };
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer); };
  }, [fetchClips]);

  useEffect(() => {
    const urls = localUrls.current;
    return () => { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);

  const addText = useCallback(async (content: string, days: number) => {
    const finish = beginMutation();
    const id = --tempId.current;
    const uid = `tmp-${Date.now()}-${-id}`;
    const expires_at = new Date(Date.now() + days * 86400_000 - 1000).toISOString();
    setClips(prev => [{ id, uid, content, type: 'text' as const, pending: true, created_at: new Date().toISOString(), expires_at }, ...prev].slice(0, 100));
    try {
      const response = await fetch('/api/clips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, retention_days: days }) });
      if (!response.ok) throw new Error('发送失败');
      const saved: Clip = await response.json();
      setClips(prev => prev.map(clip => clip.uid === uid ? { ...saved, uid } : clip));
      return true;
    } catch {
      setClips(prev => prev.filter(clip => clip.uid !== uid));
      notify('发送失败，文字已保留，请重试');
      return false;
    } finally { finish(); }
  }, [beginMutation, notify]);

  const uploadImage = useCallback(async (file: File, days: number) => {
    const finish = beginMutation();
    const id = --tempId.current;
    const uid = `tmp-${Date.now()}-${-id}`;
    const sourceUrl = URL.createObjectURL(file);
    let localUrl = sourceUrl;
    localUrls.current.add(sourceUrl);
    const expires_at = new Date(Date.now() + days * 86400_000 - 1000).toISOString();
    setClips(prev => [{ id, uid, content: sourceUrl, localUrl, type: 'image' as const, pending: true, created_at: new Date().toISOString(), expires_at }, ...prev].slice(0, 100));
    setUploadingCount(n => n + 1);
    try {
      const { payload, converted } = await prepareImage(file);
      if (converted) {
        localUrl = URL.createObjectURL(payload);
        localUrls.current.add(localUrl);
        URL.revokeObjectURL(sourceUrl);
        localUrls.current.delete(sourceUrl);
        setClips(prev => prev.map(clip => clip.uid === uid ? { ...clip, content: localUrl, localUrl } : clip));
      }
      const response = await fetch(`/api/clips?retention_days=${days}`, {
        method: 'POST', headers: { 'Content-Type': payload.type }, body: payload,
      });
      if (!response.ok) {
        const info = await response.json().catch(() => ({}));
        throw new Error(info.error || `上传失败 (${response.status})`);
      }
      const saved: Clip = await response.json();
      setClips(prev => prev.map(clip => clip.uid === uid ? { ...saved, uid, localUrl } : clip));
      if (converted) notify('已转换为静态 JPG 并上传');
      // 缩略图失败不能撤销已经成功保存的素材。
      try {
        const thumb = await makeThumbnail(payload);
        if (thumb) {
          const response = await fetch(`/api/clips/${saved.id}/thumb`, { method: 'POST', headers: { 'Content-Type': thumb.type }, body: thumb });
          if (response.ok) {
            const info = await response.json();
            setClips(prev => prev.map(clip => clip.id === saved.id ? { ...clip, thumb: info.thumb } : clip));
          }
        }
      } catch (error) { console.warn('缩略图生成失败，保留原图:', error); }
    } catch (error) {
      setClips(prev => prev.filter(clip => clip.uid !== uid));
      notify(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploadingCount(n => n - 1);
      finish();
      window.setTimeout(() => {
        URL.revokeObjectURL(localUrl);
        localUrls.current.delete(localUrl);
        setClips(prev => prev.map(clip => clip.uid === uid ? { ...clip, localUrl: undefined } : clip));
      }, 60_000);
    }
  }, [beginMutation, notify]);

  const uploadFiles = useCallback((files: File[], days: number) => {
    // 大照片串行解码，避免手机批量选图时同时占用多份 RGBA 内存。
    for (const file of files) uploadQueue.current = uploadQueue.current.then(() => uploadImage(file, days));
  }, [uploadImage]);

  const deleteClip = useCallback(async (clip: Clip) => {
    if (clip.pending || clip.id <= 0 || deleting.current.has(clip.id)) return;
    deleting.current.add(clip.id);
    const finish = beginMutation();
    setClips(prev => prev.filter(row => row.id !== clip.id));
    try {
      const response = await fetch(`/api/clips/${clip.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('删除失败');
    } catch {
      setClips(prev => prev.some(row => row.id === clip.id) ? prev : [...prev, clip].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      notify('删除失败，已恢复这条素材');
    } finally { deleting.current.delete(clip.id); finish(); }
  }, [beginMutation, notify]);

  const setStatus = useCallback(async (id: number, status: 'pending' | 'done') => {
    const finish = beginMutation();
    try {
      const response = await fetch(`/api/clips/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!response.ok) throw new Error('更新状态失败');
      const saved: { status: 'pending' | 'done' } = await response.json();
      setClips(prev => prev.map(clip => clip.id === id ? { ...clip, status: saved.status } : clip));
    } catch { notify('更新状态失败，请重试'); }
    finally { finish(); }
  }, [beginMutation, notify]);

  return { clips, uploadingCount, addText, uploadFiles, deleteClip, setStatus };
}
