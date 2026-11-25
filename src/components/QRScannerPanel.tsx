import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, KeyRound, QrCode, X } from 'lucide-react';

interface BarcodeDetectorInstance {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
}

export function parsePairingPayload(raw: string): { sessionId: string; token: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Format 1: Full URL with ?session=...&token=...
  try {
    const url = new URL(trimmed);
    const session = url.searchParams.get('session');
    const token = url.searchParams.get('token');
    if (session && token) {
      return { sessionId: session.trim().toUpperCase(), token: token.trim() };
    }
  } catch {
    // Not a URL, check structured formats
  }

  // Format 2: JSON { sessionId, token }
  try {
    const parsed = JSON.parse(trimmed) as { sessionId?: string; session?: string; token?: string };
    const sid = parsed.sessionId || parsed.session;
    if (sid && parsed.token) {
      return { sessionId: String(sid).trim().toUpperCase(), token: String(parsed.token).trim() };
    }
  } catch {
    // Not JSON
  }

  // Format 3: Pipe or colon separated SESSION|TOKEN
  const parts = trimmed.split('|');
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { sessionId: parts[0].trim().toUpperCase(), token: parts[1].trim() };
  }

  return null;
}

interface QRScannerPanelProps {
  onScanned: (sessionId: string, token: string) => void;
  disabled?: boolean;
}

export const QRScannerPanel: React.FC<QRScannerPanelProps> = ({ onScanned, disabled = false }) => {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualSessionId, setManualSessionId] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [manualLink, setManualLink] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorInstance | null>(null);

  const stopScanner = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, [stopScanner]);

  const startScanner = useCallback(async () => {
    setScanError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setScanError('Camera access is not available in this browser. Use Manual Pairing below.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      setScanning(true);

      // Initialize native BarcodeDetector if available (Android Chrome)
      const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (BD && !detectorRef.current) {
        try {
          detectorRef.current = new BD({ formats: ['qr_code'] });
        } catch {
          detectorRef.current = null;
        }
      }

      requestAnimationFrame(() => {
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        void video.play();

        let lastScanTs = 0;

        const scanFrame = async (ts: number) => {
          if (!streamRef.current) return;
          if (video.readyState >= 2 && ts - lastScanTs >= 180) {
            lastScanTs = ts;
            let rawValue: string | null = null;

            if (detectorRef.current) {
              try {
                const results = await detectorRef.current.detect(video);
                if (results.length > 0 && results[0].rawValue) {
                  rawValue = results[0].rawValue;
                }
              } catch {
                // fallback to jsQR below
              }
            }

            if (!rawValue) {
              const canvas = canvasRef.current;
              if (canvas && video.videoWidth > 0 && video.videoHeight > 0) {
                const targetW = Math.min(640, video.videoWidth);
                const scale = targetW / video.videoWidth;
                const targetH = Math.round(video.videoHeight * scale);
                canvas.width = targetW;
                canvas.height = targetH;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                  ctx.drawImage(video, 0, 0, targetW, targetH);
                  const imageData = ctx.getImageData(0, 0, targetW, targetH);
                  const decoded = jsQR(imageData.data, targetW, targetH, {
                    inversionAttempts: 'dontInvert',
                  });
                  if (decoded?.data) {
                    rawValue = decoded.data;
                  }
                }
              }
            }

            if (rawValue) {
              const parsed = parsePairingPayload(rawValue);
              if (parsed) {
                stopScanner();
                onScanned(parsed.sessionId, parsed.token);
                return;
              } else {
                setScanError('QR code detected, but it is not a valid ZEN CAM pairing code.');
              }
            }
          }

          rafRef.current = requestAnimationFrame(scanFrame);
        };

        rafRef.current = requestAnimationFrame(scanFrame);
      });
    } catch (err) {
      stopScanner();
      const message =
        err instanceof Error
          ? err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access or use Manual Pairing.'
            : `Could not open scanner camera: ${err.message}`
          : 'Could not open camera.';
      setScanError(message);
    }
  }, [onScanned, stopScanner]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setScanError(null);

    if (manualLink.trim()) {
      const parsed = parsePairingPayload(manualLink);
      if (parsed) {
        onScanned(parsed.sessionId, parsed.token);
        return;
      }
      setScanError('The pasted pairing link is invalid.');
      return;
    }

    if (!manualSessionId.trim() || !manualToken.trim()) {
      setScanError('Enter both Session ID and Security Token, or paste the full pairing link.');
      return;
    }

    onScanned(manualSessionId.trim().toUpperCase(), manualToken.trim());
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111827]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Scan Windows QR Code
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Point your rear camera at the QR code shown on your Windows 10 receiver.
            </p>
          </div>
          {scanning && (
            <button
              type="button"
              onClick={stopScanner}
              aria-label="Stop QR scanner"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {scanning ? (
          <div className="mt-4">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md border border-slate-300 bg-black dark:border-slate-700">
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                className="h-full w-full object-cover"
              />
              {/* Clean static alignment frame */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-48 w-48 border-2 border-blue-500" />
              </div>
            </div>
            <canvas ref={canvasRef} className="hidden" />
            <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
              Hold steady with the QR code centered inside the blue frame.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-2.5">
            <button
              type="button"
              disabled={disabled}
              onClick={startScanner}
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-md bg-blue-700 px-4 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <Camera className="h-4 w-4" />
              <span>Open Camera QR Scanner</span>
            </button>

            <button
              type="button"
              onClick={() => setManualMode((v) => !v)}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <KeyRound className="h-4 w-4" />
              <span>{manualMode ? 'Hide Manual Entry' : 'Enter Pairing Code Manually'}</span>
            </button>
          </div>
        )}

        {scanError && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
          >
            {scanError}
          </div>
        )}
      </div>

      {manualMode && (
        <form
          onSubmit={handleManualSubmit}
          className="rounded-lg border border-slate-200 bg-white p-4 space-y-3 dark:border-slate-800 dark:bg-[#111827]"
        >
          <div className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Manual Pairing Details
            </h3>
          </div>

          <div>
            <label
              htmlFor="manual-link"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Pairing Link (from Windows Copy Link button)
            </label>
            <input
              id="manual-link"
              type="text"
              value={manualLink}
              onChange={(e) => setManualLink(e.target.value)}
              placeholder="https://.../?mode=mobile&session=...&token=..."
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
            />
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            <span>or enter session and token</span>
            <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="manual-session-id"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Session Code
              </label>
              <input
                id="manual-session-id"
                type="text"
                value={manualSessionId}
                onChange={(e) => setManualSessionId(e.target.value.toUpperCase())}
                placeholder="ABCD-1234"
                className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="manual-token"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Security Token
              </label>
              <input
                id="manual-token"
                type="text"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="Paste token from Windows"
                className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={disabled}
            className="min-h-[44px] w-full rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            Connect to Windows Receiver
          </button>
        </form>
      )}
    </div>
  );
};
