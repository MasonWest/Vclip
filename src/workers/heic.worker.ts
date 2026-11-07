import { heicTo } from 'heic-to/next';

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const bitmap = await heicTo({ blob: event.data, type: 'bitmap' });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法建立画布');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      self.postMessage({ blob });
    } finally {
      bitmap.close();
    }
  } catch {
    self.postMessage({ error: 'HEIC 静态照片转换失败，请在相册中导出 JPG 后重试' });
  }
};
