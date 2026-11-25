import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Crop,
  Download,
  FileText,
  Flashlight,
  Monitor,
  Moon,
  Play,
  QrCode,
  Send,
  Settings2,
  Square,
  Sun,
  SwitchCamera,
  Trash2,
  Unlink,
} from 'lucide-react';
import { useMobileSender } from '../hooks/useMobileSender';
import type { ThemeMode } from '../hooks/useTheme';
import {
  RESOLUTION_MAP,
  type CapturedDocument,
  type ConnectionStage,
  type TurnSettings,
  type VideoFps,
  type VideoResolutionKey,
} from '../types/protocol';
import { formatBytes, sanitizeFilename, triggerBrowserDownload } from '../utils/documentExport';
import { formatCandidateType, loadTurnSettings, saveTurnSettings } from '../utils/iceConfig';
import { DocumentEditorModal } from './DocumentEditorModal';
import { PWAInstallButton } from './PWAInstallButton';
import { QRScannerPanel } from './QRScannerPanel';

type MobileTab = 'pair' | 'camera' | 'documents';

interface MobileSenderProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onSwitchToDesktop: () => void;
  initialPairing: { sessionId: string; token: string } | null;
}

function mobileStageMeta(stage: ConnectionStage): { text: string; tone: string } {
  switch (stage) {
    case 'connected':
      return { text: 'Paired (P2P)', tone: 'text-emerald-700 dark:text-emerald-400' };
    case 'webrtc_connecting':
      return { text: 'Connecting...', tone: 'text-amber-700 dark:text-amber-400' };
    case 'signaling':
      return { text: 'Authenticating...', tone: 'text-amber-700 dark:text-amber-400' };
    case 'ws_connecting':
      return { text: 'Linking...', tone: 'text-slate-600 dark:text-slate-400' };
    case 'failed':
      return { text: 'Pair Failed', tone: 'text-red-700 dark:text-red-400' };
    default:
      return { text: 'Not Paired', tone: 'text-slate-500 dark:text-slate-400' };
  }
}

const MobileThumb: React.FC<{ blob: Blob; alt: string }> = ({ blob, alt }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) return <div className="h-full w-full bg-slate-100 dark:bg-slate-800" />;
  return <img src={url} alt={alt} className="h-full w-full object-cover" />;
};

export const MobileSender: React.FC<MobileSenderProps> = ({
  theme,
  onToggleTheme,
  onSwitchToDesktop,
  initialPairing,
}) => {
  const [activeTab, setActiveTab] = useState<MobileTab>(initialPairing ? 'pair' : 'pair');
  const [capturedDocs, setCapturedDocs] = useState<
    Array<CapturedDocument & { sentToWindows?: boolean }>
  >([]);
  const [editingDoc, setEditingDoc] = useState<CapturedDocument | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    null
  );
  const [capturing, setCapturing] = useState(false);
  const [showTurnConfig, setShowTurnConfig] = useState(false);
  const [turnForm, setTurnForm] = useState<TurnSettings>(() => loadTurnSettings());

  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const autoPairedRef = useRef(false);

  const sender = useMobileSender({
    enabled: true,
    onRemoteCaptureReady: (doc) => {
      setCapturedDocs((prev) => [{ ...doc, sentToWindows: true }, ...prev]);
      setStatusMessage({ kind: 'info', text: `Windows triggered capture: "${doc.name}"` });
    },
  });

  // Auto-pair if launched via scanned QR URL
  useEffect(() => {
    if (initialPairing && !autoPairedRef.current) {
      autoPairedRef.current = true;
      sender.pairWithSession(initialPairing.sessionId, initialPairing.token);
    }
  }, [initialPairing, sender]);

  // Switch to Camera tab once real WebRTC pairing completes
  const prevStageRef = useRef<ConnectionStage>(sender.stage);
  useEffect(() => {
    if (prevStageRef.current !== 'connected' && sender.stage === 'connected' && activeTab === 'pair') {
      setActiveTab('camera');
    }
    prevStageRef.current = sender.stage;
  }, [activeTab, sender.stage]);

  // Attach local camera stream to preview <video>
  useEffect(() => {
    const video = videoPreviewRef.current;
    if (!video) return;
    if (sender.localStream) {
      video.srcObject = sender.localStream;
      void video.play().catch(() => {
        // muted playsInline handles mobile autoplay
      });
    } else {
      video.srcObject = null;
    }
  }, [sender.localStream, activeTab]);

  const handleCaptureDocument = async () => {
    setCapturing(true);
    setStatusMessage(null);
    const doc = await sender.captureDocumentFrame();
    setCapturing(false);
    if (!doc) {
      setStatusMessage({
        kind: 'error',
        text: 'Could not capture document frame. Ensure camera permission is granted.',
      });
      return;
    }
    setEditingDoc(doc);
  };

  const handleEditorConfirm = async (updated: CapturedDocument) => {
    setEditingDoc(null);
    setCapturedDocs((prev) => {
      const exists = prev.some((d) => d.id === updated.id);
      if (exists) {
        return prev.map((d) => (d.id === updated.id ? { ...updated, sentToWindows: false } : d));
      }
      return [{ ...updated, sentToWindows: false }, ...prev];
    });

    if (sender.stage === 'connected') {
      setStatusMessage({ kind: 'info', text: `Transferring "${updated.name}" to Windows...` });
      const res = await sender.sendDocumentToWindows(updated);
      if (res.ok) {
        setCapturedDocs((prev) =>
          prev.map((d) => (d.id === updated.id ? { ...d, sentToWindows: true } : d))
        );
        setStatusMessage({
          kind: 'info',
          text: `Sent "${updated.name}" directly to Windows receiver.`,
        });
      } else {
        setStatusMessage({
          kind: 'error',
          text: res.error || 'Transfer failed. Saved in Documents tab to retry.',
        });
        setActiveTab('documents');
      }
    } else {
      setStatusMessage({
        kind: 'info',
        text: `Saved "${updated.name}" in phone queue. Pair with Windows to transfer.`,
      });
      setActiveTab('documents');
    }
  };

  const handleSendQueuedDoc = async (doc: CapturedDocument) => {
    setStatusMessage(null);
    const res = await sender.sendDocumentToWindows(doc);
    if (res.ok) {
      setCapturedDocs((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, sentToWindows: true } : d))
      );
      setStatusMessage({ kind: 'info', text: `Sent "${doc.name}" to Windows.` });
    } else {
      setStatusMessage({ kind: 'error', text: res.error || 'Transfer failed.' });
    }
  };

  const handleSaveTurn = (e: React.FormEvent) => {
    e.preventDefault();
    saveTurnSettings(turnForm);
    setShowTurnConfig(false);
    setStatusMessage({ kind: 'info', text: 'TURN network settings saved locally.' });
  };

  const stageInfo = mobileStageMeta(sender.stage);
  const isConnected = sender.stage === 'connected';

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      {/* Compact Sticky Top Bar (52px) */}
      <header className="sticky top-0 z-30 flex h-[52px] items-center justify-between gap-2 border-b border-slate-200 bg-white px-3.5 dark:border-slate-800 dark:bg-[#0B0F17]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-bold tracking-tight whitespace-nowrap">ZEN CAM</span>
          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
            ·
          </span>
          <span className={`text-xs font-medium truncate ${stageInfo.tone}`}>{stageInfo.text}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-[#111827] dark:text-slate-200"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {/* Main Content Area (padded for bottom thumb bar) */}
      <main className="mx-auto w-full max-w-2xl flex-1 p-3.5 pb-20 space-y-3.5">
        {/* Real status/error/transfer banners */}
        {sender.errorMessage && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
          >
            {sender.errorMessage}
          </div>
        )}

        {sender.cameraError && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
          >
            {sender.cameraError}
          </div>
        )}

        {statusMessage && (
          <div
            className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
              statusMessage.kind === 'error'
                ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
                : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-[#111827] dark:text-slate-300'
            }`}
          >
            <span>{statusMessage.text}</span>
            <button
              type="button"
              onClick={() => setStatusMessage(null)}
              className="font-medium underline shrink-0"
            >
              Close
            </button>
          </div>
        )}

        {sender.transfer && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-1.5 dark:border-slate-800 dark:bg-[#111827]">
            <div className="flex items-center justify-between text-xs">
              <span className="truncate font-medium">Sending {sender.transfer.name}</span>
              <span className="font-mono tabular-nums">
                {Math.round(
                  (sender.transfer.receivedChunks / Math.max(1, sender.transfer.totalChunks)) * 100
                )}
                %
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-800">
              <div
                className="h-full bg-blue-700 dark:bg-blue-500"
                style={{
                  width: `${Math.round(
                    (sender.transfer.receivedChunks / Math.max(1, sender.transfer.totalChunks)) *
                      100
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* TAB 1: PAIR */}
        {activeTab === 'pair' && (
          <div className="space-y-4">
            {isConnected ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 space-y-3 dark:border-emerald-900/60 dark:bg-emerald-950/20">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-300">
                      Connected to Windows Receiver
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-emerald-800 dark:text-emerald-400">
                      Session {sender.pairedSessionId}
                      {sender.candidateType ? ` · ${formatCandidateType(sender.candidateType)}` : ''}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('camera')}
                    className="min-h-[44px] rounded-md bg-blue-700 px-3 text-xs font-medium text-white hover:bg-blue-800 dark:bg-blue-600"
                  >
                    Open Camera
                  </button>
                  <button
                    type="button"
                    onClick={sender.unpair}
                    className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    <span>Disconnect</span>
                  </button>
                </div>
              </div>
            ) : (
              <QRScannerPanel
                disabled={sender.stage === 'ws_connecting' || sender.stage === 'webrtc_connecting'}
                onScanned={(sessionId, token) => sender.pairWithSession(sessionId, token)}
              />
            )}

            {/* Optional TURN Settings & Role Switch */}
            <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3 dark:border-slate-800 dark:bg-[#111827]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Network &amp; Mode Options
                </span>
                <button
                  type="button"
                  onClick={() => setShowTurnConfig((v) => !v)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>TURN Server</span>
                </button>
              </div>

              {showTurnConfig && (
                <form
                  onSubmit={handleSaveTurn}
                  className="space-y-2.5 border-t border-slate-200 pt-3 dark:border-slate-800"
                >
                  <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={turnForm.enabled}
                      onChange={(e) => setTurnForm({ ...turnForm, enabled: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <span>Use custom TURN server</span>
                  </label>
                  <input
                    type="text"
                    value={turnForm.urls}
                    onChange={(e) => setTurnForm({ ...turnForm, urls: e.target.value })}
                    placeholder="turn:server.example.com:3478"
                    className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-xs dark:border-slate-700 dark:bg-[#0B0F17]"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={turnForm.username}
                      onChange={(e) => setTurnForm({ ...turnForm, username: e.target.value })}
                      placeholder="Username"
                      className="h-10 rounded-md border border-slate-300 bg-white px-3 font-mono text-xs dark:border-slate-700 dark:bg-[#0B0F17]"
                    />
                    <input
                      type="password"
                      value={turnForm.credential}
                      onChange={(e) => setTurnForm({ ...turnForm, credential: e.target.value })}
                      placeholder="Credential"
                      className="h-10 rounded-md border border-slate-300 bg-white px-3 font-mono text-xs dark:border-slate-700 dark:bg-[#0B0F17]"
                    />
                  </div>
                  <button
                    type="submit"
                    className="min-h-[44px] w-full rounded-md bg-blue-700 text-xs font-medium text-white"
                  >
                    Save TURN Settings
                  </button>
                </form>
              )}

              <button
                type="button"
                onClick={onSwitchToDesktop}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-300"
              >
                <Monitor className="h-4 w-4" />
                <span>Switch to Windows Receiver Dashboard</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 2: LIVE CAMERA & CAPTURE */}
        {activeTab === 'camera' && (
          <div className="space-y-3.5">
            {/* Viewfinder */}
            <div className="relative aspect-[3/4] max-h-[54vh] w-full overflow-hidden rounded-lg border border-slate-200 bg-black dark:border-slate-800">
              {sender.localStream ? (
                <video
                  ref={videoPreviewRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center text-slate-300">
                  <Camera className="h-8 w-8 text-slate-500" />
                  <p className="mt-2 text-sm font-medium">Camera Stopped</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Tap Start Stream to preview and stream live video to Windows, or tap Capture
                    Document directly.
                  </p>
                </div>
              )}

              {sender.streaming && (
                <div className="absolute left-3 top-3 rounded bg-black/75 px-2 py-1 font-mono text-[11px] text-white">
                  {sender.videoConfig.facingMode === 'environment' ? 'REAR' : 'FRONT'} ·{' '}
                  {sender.videoConfig.resolution} · {sender.videoConfig.fps}fps
                </div>
              )}
            </div>

            {/* Primary Thumb Controls */}
            <div className="grid grid-cols-2 gap-2.5">
              {sender.streaming ? (
                <button
                  type="button"
                  onClick={() => void sender.stopCameraStream()}
                  className="flex min-h-[48px] items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-medium text-white active:bg-red-700"
                >
                  <Square className="h-4 w-4" />
                  <span>Stop Stream</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void sender.startCameraStream()}
                  className="flex min-h-[48px] items-center justify-center gap-2 rounded-md bg-blue-700 px-4 text-sm font-medium text-white active:bg-blue-800 dark:bg-blue-600"
                >
                  <Play className="h-4 w-4" />
                  <span>Start Stream</span>
                </button>
              )}

              <button
                type="button"
                disabled={capturing}
                onClick={handleCaptureDocument}
                className="flex min-h-[48px] items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
              >
                <Camera className="h-4 w-4" />
                <span>{capturing ? 'Capturing...' : 'Capture Scan'}</span>
              </button>
            </div>

            {/* Camera Hardware Controls */}
            <div className="rounded-lg border border-slate-200 bg-white p-3.5 space-y-3 dark:border-slate-800 dark:bg-[#111827]">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void sender.switchCameraFacing()}
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  <SwitchCamera className="h-4 w-4" />
                  <span>
                    Switch to {sender.videoConfig.facingMode === 'environment' ? 'Front' : 'Rear'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={!sender.torchSupported}
                  onClick={() => void sender.toggleTorch()}
                  className={`flex min-h-[44px] items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium disabled:opacity-40 ${
                    sender.torchEnabled
                      ? 'border-amber-600 bg-amber-600 text-white'
                      : 'border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                  }`}
                >
                  <Flashlight className="h-4 w-4" />
                  <span>{sender.torchEnabled ? 'Flash On' : 'Flash Off'}</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Resolution
                  </label>
                  <select
                    value={sender.videoConfig.resolution}
                    onChange={(e) =>
                      void sender.updateVideoSettings({
                        resolution: e.target.value as VideoResolutionKey,
                      })
                    }
                    className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  >
                    {(Object.keys(RESOLUTION_MAP) as VideoResolutionKey[]).map((key) => (
                      <option key={key} value={key}>
                        {RESOLUTION_MAP[key].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Frame Rate
                  </label>
                  <select
                    value={sender.videoConfig.fps}
                    onChange={(e) =>
                      void sender.updateVideoSettings({
                        fps: Number(e.target.value) as VideoFps,
                      })
                    }
                    className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-2.5 font-mono text-xs font-medium text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  >
                    <option value={15}>15 FPS</option>
                    <option value={24}>24 FPS</option>
                    <option value={30}>30 FPS</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CAPTURED DOCUMENTS ON PHONE */}
        {activeTab === 'documents' && (
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Captured Documents ({capturedDocs.length})
              </h2>
              <button
                type="button"
                disabled={capturing}
                onClick={handleCaptureDocument}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-blue-700 px-3 text-xs font-medium text-white dark:bg-blue-600"
              >
                <Camera className="h-3.5 w-3.5" />
                <span>New Scan</span>
              </button>
            </div>

            {capturedDocs.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-[#111827]">
                <FileText className="mx-auto h-7 w-7 text-slate-400" />
                <p className="mt-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                  No Scans Captured Yet
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Capture a document from the Camera tab to crop, rotate, and send it directly to
                  Windows.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {capturedDocs.map((doc) => (
                  <div
                    key={doc.id}
                    className="rounded-lg border border-slate-200 bg-white p-3 space-y-3 dark:border-slate-800 dark:bg-[#111827]"
                  >
                    <div className="flex gap-3">
                      <div className="h-20 w-20 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100 dark:border-slate-800">
                        <MobileThumb blob={doc.blob} alt={doc.name} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {doc.name}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                          {doc.width}×{doc.height} · {formatBytes(doc.sizeBytes)}
                        </div>
                        <div
                          className={`mt-1 text-[11px] font-medium ${
                            doc.sentToWindows
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {doc.sentToWindows ? 'Transferred to Windows' : 'Waiting to transfer'}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        disabled={!isConnected || Boolean(sender.transfer)}
                        onClick={() => void handleSendQueuedDoc(doc)}
                        className="inline-flex min-h-[42px] items-center justify-center gap-1 rounded-md bg-blue-700 px-2 text-xs font-medium text-white disabled:opacity-40 dark:bg-blue-600"
                      >
                        <Send className="h-3.5 w-3.5" />
                        <span>Send PC</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingDoc(doc)}
                        className="inline-flex min-h-[42px] items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      >
                        <Crop className="h-3.5 w-3.5" />
                        <span>Edit</span>
                      </button>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          aria-label="Save local copy"
                          onClick={() =>
                            triggerBrowserDownload(doc.blob, `${sanitizeFilename(doc.name)}.jpg`)
                          }
                          className="flex min-h-[42px] items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete scan"
                          onClick={() =>
                            setCapturedDocs((prev) => prev.filter((d) => d.id !== doc.id))
                          }
                          className="flex min-h-[42px] items-center justify-center rounded-md border border-slate-300 bg-white text-red-700 dark:border-slate-700 dark:bg-slate-900 dark:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Fixed Bottom Thumb Navigation Bar (56px, total fixed chrome 108px < 15% mobile height) */}
      <nav
        aria-label="Android camera navigation"
        className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white pb-safe dark:border-slate-800 dark:bg-[#111827]"
      >
        <div className="mx-auto grid h-14 max-w-2xl grid-cols-3">
          {(
            [
              { id: 'pair', label: 'Pair', icon: QrCode },
              { id: 'camera', label: 'Camera', icon: Camera },
              {
                id: 'documents',
                label: capturedDocs.length > 0 ? `Scans (${capturedDocs.length})` : 'Scans',
                icon: FileText,
              },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                  active
                    ? 'text-blue-700 dark:text-blue-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Document Crop / Rotate Editor Modal */}
      {editingDoc && (
        <DocumentEditorModal
          document={editingDoc}
          confirmLabel={isConnected ? 'Send to Windows' : 'Save to Queue'}
          onCancel={() => setEditingDoc(null)}
          onConfirm={handleEditorConfirm}
        />
      )}
    </div>
  );
};
