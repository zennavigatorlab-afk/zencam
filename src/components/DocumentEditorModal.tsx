import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crop, RotateCcw, RotateCw, X } from 'lucide-react';
import type { CapturedDocument, CropRect, DocumentFilter } from '../types/protocol';
import { formatBytes, processDocumentImage, sanitizeFilename } from '../utils/documentExport';

interface DocumentEditorModalProps {
  document: CapturedDocument;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (updated: CapturedDocument) => void | Promise<void>;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

const FULL_CROP: CropRect = { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };
const MIN_CROP_SIZE = 0.12;

export const DocumentEditorModal: React.FC<DocumentEditorModalProps> = ({
  document: doc,
  confirmLabel,
  onCancel,
  onConfirm,
}) => {
  const [name, setName] = useState(doc.name);
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [filter, setFilter] = useState<DocumentFilter>('original');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [rotatedDimensions, setRotatedDimensions] = useState<{ w: number; h: number }>({
    w: doc.width || 1200,
    h: doc.height || 1600,
  });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    startCrop: CropRect;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    startCrop: FULL_CROP,
  });

  // Render rotated preview blob whenever rotation or filter changes so crop coordinates match 1:1
  useEffect(() => {
    let active = true;
    let objectUrl = '';

    (async () => {
      try {
        const rendered = await processDocumentImage(doc.blob, {
          rotationDeg: rotation,
          crop: { x: 0, y: 0, width: 1, height: 1 },
          filter,
          quality: 0.9,
        });
        if (!active) return;
        objectUrl = URL.createObjectURL(rendered.blob);
        setPreviewUrl(objectUrl);
        setRotatedDimensions({ w: rendered.width, h: rendered.height });
      } catch {
        if (!active) return;
        objectUrl = URL.createObjectURL(doc.blob);
        setPreviewUrl(objectUrl);
      }
    })();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.blob, filter, rotation]);

  const applyAspectPreset = (preset: 'full' | 'a4p' | 'a4l' | 'id') => {
    if (preset === 'full') {
      setCrop({ x: 0, y: 0, width: 1, height: 1 });
      return;
    }

    const imgRatio = rotatedDimensions.w / Math.max(1, rotatedDimensions.h);
    const targetRatio = preset === 'a4p' ? 210 / 297 : preset === 'a4l' ? 297 / 210 : 85.6 / 54;

    let w = 0.88;
    let h = (w * imgRatio) / targetRatio;
    if (h > 0.88) {
      h = 0.88;
      w = (h * targetRatio) / imgRatio;
    }
    w = Math.min(1, Math.max(MIN_CROP_SIZE, w));
    h = Math.min(1, Math.max(MIN_CROP_SIZE, h));

    setCrop({
      x: (1 - w) / 2,
      y: (1 - h) / 2,
      width: w,
      height: h,
    });
  };

  const startDrag = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStateRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...crop },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const state = dragStateRef.current;
    if (!state.mode || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dx = (e.clientX - state.startX) / rect.width;
    const dy = (e.clientY - state.startY) / rect.height;
    const s = state.startCrop;

    if (state.mode === 'move') {
      const nx = Math.max(0, Math.min(1 - s.width, s.x + dx));
      const ny = Math.max(0, Math.min(1 - s.height, s.y + dy));
      setCrop({ ...s, x: nx, y: ny });
      return;
    }

    let left = s.x;
    let top = s.y;
    let right = s.x + s.width;
    let bottom = s.y + s.height;

    if (state.mode === 'nw' || state.mode === 'sw') {
      left = Math.max(0, Math.min(right - MIN_CROP_SIZE, s.x + dx));
    }
    if (state.mode === 'ne' || state.mode === 'se') {
      right = Math.min(1, Math.max(left + MIN_CROP_SIZE, s.x + s.width + dx));
    }
    if (state.mode === 'nw' || state.mode === 'ne') {
      top = Math.max(0, Math.min(bottom - MIN_CROP_SIZE, s.y + dy));
    }
    if (state.mode === 'sw' || state.mode === 'se') {
      bottom = Math.min(1, Math.max(top + MIN_CROP_SIZE, s.y + s.height + dy));
    }

    setCrop({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    });
  };

  const endDrag = () => {
    dragStateRef.current.mode = null;
  };

  const cropPixelEstimate = useMemo(() => {
    return {
      w: Math.round(rotatedDimensions.w * crop.width),
      h: Math.round(rotatedDimensions.h * crop.height),
    };
  }, [crop.height, crop.width, rotatedDimensions.h, rotatedDimensions.w]);

  const handleConfirm = async () => {
    setProcessing(true);
    setError(null);
    try {
      const processed = await processDocumentImage(doc.blob, {
        rotationDeg: rotation,
        crop,
        filter,
        quality: 0.92,
      });

      const updated: CapturedDocument = {
        ...doc,
        name: sanitizeFilename(name),
        mimeType: 'image/jpeg',
        width: processed.width,
        height: processed.height,
        sizeBytes: processed.blob.size,
        blob: processed.blob,
      };
      await onConfirm(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process document.');
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-[#0B0F17] md:bg-black/70 md:items-center md:justify-center md:p-6">
      <div className="flex h-full w-full flex-col bg-white dark:bg-[#111827] md:h-auto md:max-h-[92vh] md:max-w-4xl md:rounded-lg md:border md:border-slate-200 md:dark:border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <Crop className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              Preview, Crop &amp; Rotate Document
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel document editing"
            className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Workspace */}
        <div className="flex flex-1 flex-col overflow-y-auto md:flex-row">
          {/* Interactive Crop Canvas */}
          <div className="flex flex-1 items-center justify-center bg-slate-100 p-4 dark:bg-[#0B0F17] min-h-[280px]">
            {previewUrl && (
              <div
                ref={stageRef}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className="relative inline-block max-h-[54vh] max-w-full select-none touch-none border border-slate-300 dark:border-slate-700"
              >
                <img
                  src={previewUrl}
                  alt="Captured document preview"
                  draggable={false}
                  className="block max-h-[54vh] max-w-full object-contain pointer-events-none"
                />

                {/* Shaded outer mask (4 flat bars, zero gradients) */}
                <div
                  className="pointer-events-none absolute left-0 right-0 top-0 bg-black/55"
                  style={{ height: `${crop.y * 100}%` }}
                />
                <div
                  className="pointer-events-none absolute left-0 right-0 bottom-0 bg-black/55"
                  style={{ height: `${(1 - crop.y - crop.height) * 100}%` }}
                />
                <div
                  className="pointer-events-none absolute left-0 bg-black/55"
                  style={{
                    top: `${crop.y * 100}%`,
                    height: `${crop.height * 100}%`,
                    width: `${crop.x * 100}%`,
                  }}
                />
                <div
                  className="pointer-events-none absolute right-0 bg-black/55"
                  style={{
                    top: `${crop.y * 100}%`,
                    height: `${crop.height * 100}%`,
                    width: `${(1 - crop.x - crop.width) * 100}%`,
                  }}
                />

                {/* Active crop rectangle */}
                <div
                  onPointerDown={(e) => startDrag('move', e)}
                  className="absolute cursor-move border-2 border-blue-500"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                >
                  {/* Subtle rule-of-thirds document alignment grid */}
                  <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/40" />
                  <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/40" />
                  <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/40" />
                  <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/40" />

                  {/* Touch-friendly corner handles */}
                  <button
                    type="button"
                    aria-label="Resize top-left corner"
                    onPointerDown={(e) => startDrag('nw', e)}
                    className="absolute -left-3 -top-3 h-7 w-7 cursor-nwse-resize rounded-sm border-2 border-white bg-blue-600"
                  />
                  <button
                    type="button"
                    aria-label="Resize top-right corner"
                    onPointerDown={(e) => startDrag('ne', e)}
                    className="absolute -right-3 -top-3 h-7 w-7 cursor-nesw-resize rounded-sm border-2 border-white bg-blue-600"
                  />
                  <button
                    type="button"
                    aria-label="Resize bottom-left corner"
                    onPointerDown={(e) => startDrag('sw', e)}
                    className="absolute -bottom-3 -left-3 h-7 w-7 cursor-nesw-resize rounded-sm border-2 border-white bg-blue-600"
                  />
                  <button
                    type="button"
                    aria-label="Resize bottom-right corner"
                    onPointerDown={(e) => startDrag('se', e)}
                    className="absolute -bottom-3 -right-3 h-7 w-7 cursor-nwse-resize rounded-sm border-2 border-white bg-blue-600"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right / Bottom Controls */}
          <div className="w-full shrink-0 border-t border-slate-200 p-4 space-y-4 md:w-72 md:border-l md:border-t-0 dark:border-slate-800">
            <div>
              <label
                htmlFor="doc-name-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Document Filename
              </label>
              <input
                id="doc-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
              />
              <p className="mt-1 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                Output: {cropPixelEstimate.w} × {cropPixelEstimate.h} px · Source {formatBytes(doc.sizeBytes)}
              </p>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Rotate ({rotation}°)
              </span>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRotation((r) => (r + 270) % 360);
                    setCrop(FULL_CROP);
                  }}
                  className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Left 90°</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRotation((r) => (r + 90) % 360);
                    setCrop(FULL_CROP);
                  }}
                  className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span>Right 90°</span>
                </button>
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Crop Preset
              </span>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => applyAspectPreset('full')}
                  className="min-h-[38px] rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Full Frame
                </button>
                <button
                  type="button"
                  onClick={() => applyAspectPreset('a4p')}
                  className="min-h-[38px] rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  A4 Portrait
                </button>
                <button
                  type="button"
                  onClick={() => applyAspectPreset('a4l')}
                  className="min-h-[38px] rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  A4 Landscape
                </button>
                <button
                  type="button"
                  onClick={() => applyAspectPreset('id')}
                  className="min-h-[38px] rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  ID Card
                </button>
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Scan Tone (Local Processing)
              </span>
              <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-md border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-[#0B0F17]">
                {(
                  [
                    { id: 'original', label: 'Color' },
                    { id: 'document', label: 'Crisp Doc' },
                    { id: 'grayscale', label: 'Grayscale' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    className={`min-h-[34px] rounded text-xs font-medium transition-colors ${
                      filter === item.id
                        ? 'bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <button
            type="button"
            onClick={onCancel}
            disabled={processing}
            className="min-h-[42px] rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={processing}
            className="inline-flex min-h-[42px] items-center gap-2 rounded-md bg-blue-700 px-5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            <Check className="h-4 w-4" />
            <span>{processing ? 'Processing...' : confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
