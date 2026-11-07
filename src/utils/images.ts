export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(heic|heif|hif|png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name);
}

export function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解码图片')); };
    img.src = url;
  });
}

function canvasToBlob(img: HTMLImageElement, width: number, height: number, type: string, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('浏览器无法处理图片'));
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败')), type, quality));
}

async function decodeHeic(file: File): Promise<Blob> {
  // 按需加载本地 worker；解码不会阻塞留言输入，也不会上传到第三方。
  const worker = new Worker(new URL('../workers/heic.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('HEIC 转换超时，请导出为 JPG 后重试')), 90_000);
    function finish(error?: Error, blob?: Blob) {
      window.clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else if (blob) resolve(blob);
    }
    worker.onmessage = (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
      if (event.data.blob) finish(undefined, event.data.blob);
      else finish(new Error(event.data.error || 'HEIC 转换失败'));
    };
    worker.onerror = () => finish(new Error('无法加载 HEIC 转换器，请刷新页面重试'));
    worker.postMessage(file);
  });
}

export async function prepareImage(file: File): Promise<{ payload: Blob; converted: boolean }> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) throw new Error('不支持 SVG');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('待转换照片超过 32MB，请先导出较小的图片');
  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  // 识别真实文件头，兼容手机返回空 MIME 或 application/octet-stream。
  let type = '';
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) type = 'image/png';
  else if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) type = 'image/jpeg';
  else if (new TextDecoder().decode(header.slice(0, 6)).match(/^GIF8[79]a$/)) type = 'image/gif';
  else if (new TextDecoder().decode(header.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(header.slice(8, 12)) === 'WEBP') type = 'image/webp';
  if (type) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('图片超过 8MB，请先压缩');
    return { payload: file.slice(0, file.size, type), converted: false };
  }
  const heic = /\.(heic|heif|hif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type)
    || /hei[cfx]|hev[cx]|mif1|msf1/.test(new TextDecoder().decode(header.slice(8)));
  let payload: Blob;
  if (heic) {
    // 浏览器原生支持时优先使用；否则由 libheif 解码静态主图。
    const img = await loadImageElement(file).catch(() => null);
    payload = img ? await canvasToBlob(img, img.naturalWidth, img.naturalHeight, 'image/jpeg', 0.92) : await decodeHeic(file);
  } else {
    const img = await loadImageElement(file).catch(() => null);
    if (!img) throw new Error('这个格式无法处理，请换成 JPG / PNG；Live Photo 请选静态照片，暂不支持 MOV 视频');
    payload = await canvasToBlob(img, img.naturalWidth, img.naturalHeight, 'image/jpeg', 0.92);
  }
  if (payload.size > MAX_UPLOAD_BYTES) throw new Error('转换后的照片超过 8MB，请导出较小的 JPG 后重试');
  return { payload, converted: true };
}

export async function makeThumbnail(file: Blob): Promise<Blob | null> {
  const img = await loadImageElement(file);
  const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1) return null;
  return canvasToBlob(img, Math.max(1, Math.round(img.naturalWidth * scale)), Math.max(1, Math.round(img.naturalHeight * scale)), 'image/webp', 0.72);
}
