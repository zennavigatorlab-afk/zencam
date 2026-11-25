import { jsPDF } from 'jspdf';
import type { CapturedDocument, CropRect, DocumentFilter } from '../types/protocol';

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }) => Promise<FileSystemDirectoryHandle>;
}

interface PermissionDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (cleaned) return cleaned;
  return defaultDocumentName();
}

export function defaultDocumentName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `ZENCAM_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function pickZenCamDirectory(): Promise<{
  handle: FileSystemDirectoryHandle;
  label: string;
}> {
  const win = window as DirectoryPickerWindow;
  if (!win.showDirectoryPicker) {
    throw new Error('This browser does not support direct folder access. Use Chrome or Edge on Windows 10.');
  }

  const picked = await win.showDirectoryPicker({
    id: 'zencam-documents',
    mode: 'readwrite',
    startIn: 'documents',
  });

  // If user selected Documents (or any parent folder not already named ZEN CAM),
  // automatically create/open the "ZEN CAM" subfolder inside it.
  if (picked.name.toUpperCase() === 'ZEN CAM') {
    return { handle: picked, label: `Documents/${picked.name}` };
  }

  const zenSubfolder = await picked.getDirectoryHandle('ZEN CAM', { create: true });
  return {
    handle: zenSubfolder,
    label: `${picked.name}/ZEN CAM`,
  };
}

export async function verifyDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  allowPrompt: boolean
): Promise<boolean> {
  const permHandle = handle as PermissionDirectoryHandle;
  if (!permHandle.queryPermission) return true;
  const current = await permHandle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return true;
  if (!allowPrompt || !permHandle.requestPermission) return false;
  const requested = await permHandle.requestPermission({ mode: 'readwrite' });
  return requested === 'granted';
}

export async function writeBlobToDirectory(
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob
): Promise<string> {
  const granted = await verifyDirectoryPermission(dirHandle, true);
  if (!granted) {
    throw new Error('Write permission to the selected folder was denied.');
  }
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return filename;
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image.'));
    };
    img.src = url;
  });
}

export async function processDocumentImage(
  sourceBlob: Blob,
  options: {
    rotationDeg: number; // 0, 90, 180, 270
    crop: CropRect;
    filter: DocumentFilter;
    quality?: number;
  }
): Promise<{ blob: Blob; width: number; height: number }> {
  const img = await loadImageFromBlob(sourceBlob);
  const rot = ((options.rotationDeg % 360) + 360) % 360;

  // Step 1: Draw rotated full image onto an intermediate canvas
  const rotCanvas = document.createElement('canvas');
  const swapped = rot === 90 || rot === 270;
  rotCanvas.width = swapped ? img.naturalHeight : img.naturalWidth;
  rotCanvas.height = swapped ? img.naturalWidth : img.naturalHeight;

  const rctx = rotCanvas.getContext('2d');
  if (!rctx) throw new Error('Canvas 2D context unavailable.');

  rctx.save();
  rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
  rctx.rotate((rot * Math.PI) / 180);
  rctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  rctx.restore();

  // Step 2: Crop from the rotated canvas
  const sx = Math.max(0, Math.round(options.crop.x * rotCanvas.width));
  const sy = Math.max(0, Math.round(options.crop.y * rotCanvas.height));
  const sw = Math.max(16, Math.min(rotCanvas.width - sx, Math.round(options.crop.width * rotCanvas.width)));
  const sh = Math.max(16, Math.min(rotCanvas.height - sy, Math.round(options.crop.height * rotCanvas.height)));

  const outCanvas = document.createElement('canvas');
  outCanvas.width = sw;
  outCanvas.height = sh;
  const octx = outCanvas.getContext('2d');
  if (!octx) throw new Error('Canvas 2D context unavailable.');

  octx.fillStyle = '#FFFFFF';
  octx.fillRect(0, 0, sw, sh);
  octx.drawImage(rotCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // Step 3: Optional document enhancement (pure local pixel math)
  if (options.filter === 'grayscale' || options.filter === 'document') {
    const imgData = octx.getImageData(0, 0, sw, sh);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (options.filter === 'grayscale') {
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
      } else {
        // High-contrast document legibility boost (crisp text, clean paper background)
        const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 140));
        data[i] = contrasted;
        data[i + 1] = contrasted;
        data[i + 2] = contrasted;
      }
    }
    octx.putImageData(imgData, 0, 0);
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to encode JPEG image.'));
      },
      'image/jpeg',
      options.quality ?? 0.92
    );
  });

  return { blob, width: sw, height: sh };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function generatePdfFromDocuments(docs: CapturedDocument[]): Promise<Blob> {
  if (docs.length === 0) {
    throw new Error('No documents selected for PDF generation.');
  }

  let pdf: jsPDF | null = null;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const dataUrl = await blobToDataUrl(doc.blob);
    const img = await loadImageFromBlob(doc.blob);
    const isLandscape = img.naturalWidth > img.naturalHeight;
    const orientation: 'l' | 'p' = isLandscape ? 'l' : 'p';

    if (!pdf) {
      pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
    } else {
      pdf.addPage('a4', orientation);
    }

    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;

    const imgRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = availW / availH;

    let drawW = availW;
    let drawH = availH;
    if (imgRatio > boxRatio) {
      drawH = availW / imgRatio;
    } else {
      drawW = availH * imgRatio;
    }

    const offsetX = (pageW - drawW) / 2;
    const offsetY = (pageH - drawH) / 2;

    pdf.addImage(dataUrl, 'JPEG', offsetX, offsetY, drawW, drawH, undefined, 'FAST');
  }

  if (!pdf) {
    throw new Error('Could not initialize PDF document.');
  }

  return pdf.output('blob');
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
