import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Camera,
  Check,
  Copy,
  Crop,
  Download,
  FileText,
  FolderOpen,
  Info,
  Maximize2,
  Minimize2,
  Moon,
  Play,
  QrCode,
  RefreshCw,
  Settings2,
  Smartphone,
  Square,
  Sun,
  SwitchCamera,
  Trash2,
  Unlink,
} from 'lucide-react';
import { useReceiverSession } from '../hooks/useReceiverSession';
import type { ThemeMode } from '../hooks/useTheme';
import {
  RESOLUTION_MAP,
  type CapturedDocument,
  type ConnectionStage,
  type TurnSettings,
  type VideoFps,
  type VideoResolutionKey,
} from '../types/protocol';
import {
  formatBytes,
  generatePdfFromDocuments,
  isFileSystemAccessSupported,
  pickZenCamDirectory,
  sanitizeFilename,
  triggerBrowserDownload,
  verifyDirectoryPermission,
  writeBlobToDirectory,
} from '../utils/documentExport';
import { formatCandidateType, loadTurnSettings, saveTurnSettings } from '../utils/iceConfig';
import {
  clearDirectoryHandle,
  clearLocalDocuments,
  deleteLocalDocument,
  loadDirectoryHandle,
  loadLocalDocuments,
  saveDirectoryHandle,
  saveLocalDocument,
} from '../utils/localQueueDb';
import { DocumentEditorModal } from './DocumentEditorModal';
import { PWAInstallButton } from './PWAInstallButton';
import { VirtualCameraGuide } from './VirtualCameraGuide';

type DesktopTab = 'pair' | 'camera' | 'documents' | 'limits';

interface DesktopReceiverProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onSwitchToMobile: () => void;
}

function stageLabel(stage: ConnectionStage): { text: string; tone: string } {
  switch (stage) {
    case 'connected':
      return { text: 'Connected (WebRTC P2P)', tone: 'text-emerald-700 dark:text-emerald-400' };
    case 'webrtc_connecting':
      return { text: 'Establishing WebRTC link...', tone: 'text-amber-700 dark:text-amber-400' };
    case 'signaling':
      return { text: 'Authenticating paired phone...', tone: 'text-amber-700 dark:text-amber-400' };
    case 'waiting_for_peer':
      return { text: 'Waiting for QR scan', tone: 'text-slate-600 dark:text-slate-400' };
    case 'ws_connecting':
      return { text: 'Connecting to signaling server...', tone: 'text-slate-600 dark:text-slate-400' };
    case 'failed':
      return { text: 'Connection failed', tone: 'text-red-700 dark:text-red-400' };
    default:
      return { text: 'Disconnected', tone: 'text-red-700 dark:text-red-400' };
  }
}

const DocumentThumbnail: React.FC<{ blob: Blob; alt: string }> = ({ blob, alt }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const objUrl = URL.createObjectURL(blob);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [blob]);

  if (!url) {
    return <div className="h-full w-full bg-slate-100 dark:bg-slate-800" />;
  }
  return <img src={url} alt={alt} className="h-full w-full object-contain bg-slate-50 dark:bg-[#0B0F17]" />;
};

export const DesktopReceiver: React.FC<DesktopReceiverProps> = ({
  theme,
  onToggleTheme,
  onSwitchToMobile,
}) => {
  const [activeTab, setActiveTab] = useState<DesktopTab>('pair');
  const [documents, setDocuments] = useState<CapturedDocument[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [editingDoc, setEditingDoc] = useState<CapturedDocument | null>(null);
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [dirLabel, setDirLabel] = useState<string>('');
  const [dirNeedsGrant, setDirNeedsGrant] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [cleanFeedMode, setCleanFeedMode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showTurnPanel, setShowTurnPanel] = useState(false);
  const [turnForm, setTurnForm] = useState<TurnSettings>(() => loadTurnSettings());
  const [nowTs, setNowTs] = useState(() => Date.now());

  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const autoSaveRef = useRef<boolean>(autoSave);

  dirHandleRef.current = dirHandle;
  autoSaveRef.current = autoSave;

  const fsSupported = useMemo(() => isFileSystemAccessSupported(), []);

  // Load persisted local queue & folder handle from IndexedDB (local PC only)
  useEffect(() => {
    void (async () => {
      const savedDocs = await loadLocalDocuments();
      setDocuments(savedDocs);

      if (fsSupported) {
        const storedHandle = await loadDirectoryHandle();
        if (storedHandle) {
          setDirHandle(storedHandle);
          setDirLabel(storedHandle.name === 'ZEN CAM' ? 'Documents/ZEN CAM' : `${storedHandle.name}/ZEN CAM`);
          const granted = await verifyDirectoryPermission(storedHandle, false);
          setDirNeedsGrant(!granted);
        }
      }
    })();
  }, [fsSupported]);

  const handleDocumentReceived = useCallback(async (doc: CapturedDocument) => {
    let finalDoc = doc;

    if (autoSaveRef.current && dirHandleRef.current) {
      try {
        const hasPerm = await verifyDirectoryPermission(dirHandleRef.current, false);
        if (hasPerm) {
          const filename = `${sanitizeFilename(doc.name)}.jpg`;
          await writeBlobToDirectory(dirHandleRef.current, filename, doc.blob);
          finalDoc = {
            ...doc,
            savedToDisk: true,
            savedPathLabel: `Documents/ZEN CAM/${filename}`,
          };
          setNotice({ kind: 'info', text: `Saved incoming scan to Documents/ZEN CAM/${filename}` });
        }
      } catch {
        setNotice({
          kind: 'error',
          text: 'Scan received into Document Desk, but auto-save needs folder write permission re-confirmed.',
        });
      }
    } else {
      setNotice({ kind: 'info', text: `Received document "${doc.name}" directly from Android.` });
    }

    await saveLocalDocument(finalDoc);
    setDocuments((prev) => [finalDoc, ...prev.filter((d) => d.id !== finalDoc.id)]);
  }, []);

  const receiver = useReceiverSession({
    enabled: true,
    onDocumentReceived: handleDocumentReceived,
  });

  // Automatically switch to Live Camera when a real WebRTC connection establishes
  const prevStageRef = useRef<ConnectionStage>(receiver.stage);
  useEffect(() => {
    if (prevStageRef.current !== 'connected' && receiver.stage === 'connected' && activeTab === 'pair') {
      setActiveTab('camera');
    }
    prevStageRef.current = receiver.stage;
  }, [activeTab, receiver.stage]);

  // Attach remote MediaStream to <video>
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (receiver.remoteStream && receiver.senderStatus.streaming) {
      video.srcObject = receiver.remoteStream;
      void video.play().catch(() => {
        // Autoplay policy handled via muted attribute
      });
    } else {
      video.srcObject = null;
    }
  }, [receiver.remoteStream, receiver.senderStatus.streaming, activeTab, cleanFeedMode]);

  // Escape exits Clean Feed Mode
  useEffect(() => {
    if (!cleanFeedMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCleanFeedMode(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cleanFeedMode]);

  // Update QR expiry countdown once per second while waiting
  useEffect(() => {
    if (!receiver.session || receiver.stage === 'connected') return;
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [receiver.session, receiver.stage]);

  const pairingUrl = useMemo(() => {
    if (!receiver.session) return '';
    const url = new URL(window.location.origin + '/');
    url.searchParams.set('mode', 'mobile');
    url.searchParams.set('session', receiver.session.sessionId);
    url.searchParams.set('token', receiver.session.token);
    return url.toString();
  }, [receiver.session]);

  // Render crisp high-contrast QR code onto canvas
  useEffect(() => {
    if (!pairingUrl || !qrCanvasRef.current || activeTab !== 'pair') return;
    void QRCode.toCanvas(qrCanvasRef.current, pairingUrl, {
      width: 248,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    });
  }, [pairingUrl, activeTab]);

  const remainingExpiry = useMemo(() => {
    if (!receiver.session) return null;
    const secs = Math.max(0, Math.floor((receiver.session.expiresAt - nowTs) / 1000));
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }, [nowTs, receiver.session]);

  const handleCopyPairingLink = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setNotice({ kind: 'error', text: 'Could not copy link automatically. Copy from the field instead.' });
    }
  };

  const handleLinkFolder = async () => {
    setNotice(null);
    try {
      const { handle, label } = await pickZenCamDirectory();
      await saveDirectoryHandle(handle);
      setDirHandle(handle);
      setDirLabel(label);
      setDirNeedsGrant(false);
      setNotice({ kind: 'info', text: `Linked local folder: ${label}` });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to link Documents/ZEN CAM folder.',
      });
    }
  };

  const handleReconfirmFolderPermission = async () => {
    if (!dirHandle) return;
    const granted = await verifyDirectoryPermission(dirHandle, true);
    setDirNeedsGrant(!granted);
    if (granted) {
      setNotice({ kind: 'info', text: `Write permission confirmed for ${dirLabel}.` });
    }
  };

  const handleUnlinkFolder = async () => {
    await clearDirectoryHandle();
    setDirHandle(null);
    setDirLabel('');
    setDirNeedsGrant(false);
  };

  const saveBlobLocally = async (blob: Blob, filename: string, docId?: string) => {
    setNotice(null);
    if (dirHandle) {
      try {
        await writeBlobToDirectory(dirHandle, filename, blob);
        setDirNeedsGrant(false);
        const pathLabel = `${dirLabel || 'Documents/ZEN CAM'}/${filename}`;
        setNotice({ kind: 'info', text: `Saved ${filename} to ${dirLabel || 'Documents/ZEN CAM'}.` });
        if (docId) {
          setDocuments((prev) =>
            prev.map((d) =>
              d.id === docId ? { ...d, savedToDisk: true, savedPathLabel: pathLabel } : d
            )
          );
          const target = documents.find((d) => d.id === docId);
          if (target) {
            await saveLocalDocument({ ...target, savedToDisk: true, savedPathLabel: pathLabel });
          }
        }
        return;
      } catch (err) {
        setNotice({
          kind: 'error',
          text:
            err instanceof Error
              ? `${err.message} Falling back to browser download.`
              : 'Folder write failed. Falling back to browser download.',
        });
      }
    }

    triggerBrowserDownload(blob, filename);
    setNotice({
      kind: 'info',
      text: `Downloaded ${filename}. Link your Documents folder to write directly to Documents/ZEN CAM.`,
    });
  };

  const handleSaveJpg = async (doc: CapturedDocument) => {
    const filename = `${sanitizeFilename(doc.name)}.jpg`;
    await saveBlobLocally(doc.blob, filename, doc.id);
  };

  const handleSaveSinglePdf = async (doc: CapturedDocument) => {
    try {
      const pdfBlob = await generatePdfFromDocuments([doc]);
      const filename = `${sanitizeFilename(doc.name)}.pdf`;
      await saveBlobLocally(pdfBlob, filename, doc.id);
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'PDF generation failed.',
      });
    }
  };

  const handleSaveCombinedPdf = async () => {
    const selected = documents.filter((d) => selectedDocIds.has(d.id));
    if (selected.length === 0) return;
    // Preserve chronological order (oldest first = page 1)
    const ordered = [...selected].sort((a, b) => a.createdAt - b.createdAt);
    try {
      const pdfBlob = await generatePdfFromDocuments(ordered);
      const baseName = sanitizeFilename(ordered[0].name);
      const filename = `${baseName}_${ordered.length}pages.pdf`;
      await saveBlobLocally(pdfBlob, filename);
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Combined PDF generation failed.',
      });
    }
  };

  const handleDeleteDoc = async (id: string) => {
    await deleteLocalDocument(id);
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleClearQueue = async () => {
    await clearLocalDocuments();
    setDocuments([]);
    setSelectedDocIds(new Set());
  };

  const handleSaveEditedDoc = async (updated: CapturedDocument) => {
    await saveLocalDocument(updated);
    setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    setEditingDoc(null);
    setNotice({ kind: 'info', text: `Updated "${updated.name}" locally.` });
  };

  const handleSaveTurnSettings = (e: React.FormEvent) => {
    e.preventDefault();
    saveTurnSettings(turnForm);
    setShowTurnPanel(false);
    setNotice({
      kind: 'info',
      text: 'ICE / TURN network settings saved locally. Regenerate QR if re-pairing.',
    });
  };

  const statusMeta = stageLabel(receiver.stage);
  const isConnected = receiver.stage === 'connected';

  // Clean Feed Mode for OBS Studio Virtual Camera Window Capture
  if (cleanFeedMode) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
        {receiver.remoteStream && receiver.senderStatus.streaming ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="text-center text-sm text-slate-300">
            Waiting for live video stream from Android phone...
          </div>
        )}
        <button
          type="button"
          onClick={() => setCleanFeedMode(false)}
          className="fixed right-4 top-4 inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/90 px-3 text-xs font-medium text-white opacity-30 hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <Minimize2 className="h-3.5 w-3.5" />
          <span>Exit Clean Feed (Esc)</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-white text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      {/* Left Sidebar (Desktop 240px) */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-[#111827] lg:flex">
        <div className="flex h-14 items-center border-b border-slate-200 px-5 dark:border-slate-800">
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            ZEN CAM
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="Windows receiver navigation">
          {(
            [
              { id: 'pair', label: 'Pair Device', icon: QrCode },
              { id: 'camera', label: 'Live Camera', icon: Camera },
              { id: 'documents', label: 'Document Desk', icon: FileText, count: documents.length },
              { id: 'limits', label: 'Virtual Camera & Limits', icon: Info },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex h-10 w-full items-center justify-between rounded-md px-3 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-white text-blue-700 border border-slate-200 dark:bg-[#0B0F17] dark:text-blue-400 dark:border-slate-800'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {'count' in item && item.count > 0 && (
                  <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3 space-y-2 dark:border-slate-800">
          <div className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">
            Windows 10 Receiver
          </div>
          <button
            type="button"
            onClick={onSwitchToMobile}
            className="flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-300 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Smartphone className="h-3.5 w-3.5 shrink-0" />
            <span>Open Android Camera UI</span>
          </button>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar */}
        <header className="flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 lg:px-6 dark:border-slate-800 dark:bg-[#0B0F17]">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 lg:hidden whitespace-nowrap">
              ZEN CAM
            </span>
            <div className="flex items-center gap-2 text-xs min-w-0">
              <span className={`font-medium whitespace-nowrap ${statusMeta.tone}`}>
                {statusMeta.text}
              </span>
              {receiver.peerLabel && (
                <>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                    ·
                  </span>
                  <span className="truncate text-slate-600 dark:text-slate-400">
                    {receiver.peerLabel}
                  </span>
                </>
              )}
              {isConnected && receiver.diagnostics.candidateType && (
                <>
                  <span className="hidden sm:inline text-slate-300 dark:text-slate-700" aria-hidden="true">
                    ·
                  </span>
                  <span className="hidden sm:inline text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatCandidateType(receiver.diagnostics.candidateType)}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isConnected && (
              <button
                type="button"
                onClick={receiver.unpair}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <Unlink className="h-3.5 w-3.5" />
                <span>Unpair</span>
              </button>
            )}
            <PWAInstallButton />
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        {/* Compact tablet/small-desktop navigation bar */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-4 py-2 lg:hidden dark:border-slate-800 dark:bg-[#111827]">
          {(
            [
              { id: 'pair', label: 'Pair' },
              { id: 'camera', label: 'Live Camera' },
              { id: 'documents', label: `Documents (${documents.length})` },
              { id: 'limits', label: 'Virtual Cam Guide' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`h-9 rounded-md px-3 text-xs font-medium whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-white text-blue-700 border border-slate-200 dark:bg-[#0B0F17] dark:text-blue-400 dark:border-slate-800'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Error / Info Banner */}
        {(receiver.errorMessage || notice || receiver.transfer) && (
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 lg:px-6 dark:border-slate-800 dark:bg-[#111827] space-y-1.5">
            {receiver.errorMessage && (
              <div className="text-xs font-medium text-red-700 dark:text-red-400">
                {receiver.errorMessage}
              </div>
            )}
            {notice && (
              <div className="flex items-center justify-between gap-4 text-xs">
                <span
                  className={
                    notice.kind === 'error'
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-slate-700 dark:text-slate-300'
                  }
                >
                  {notice.text}
                </span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                >
                  Dismiss
                </button>
              </div>
            )}
            {receiver.transfer && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300">
                  <span>Receiving document: {receiver.transfer.name}</span>
                  <span className="font-mono tabular-nums">
                    {Math.round(
                      (receiver.transfer.receivedChunks / Math.max(1, receiver.transfer.totalChunks)) * 100
                    )}
                    %
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-800">
                  <div
                    className="h-full bg-blue-700 dark:bg-blue-500"
                    style={{
                      width: `${Math.round(
                        (receiver.transfer.receivedChunks / Math.max(1, receiver.transfer.totalChunks)) *
                          100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-4 lg:p-6">
          {/* TAB 1: PAIR DEVICE */}
          {activeTab === 'pair' && (
            <div className="mx-auto max-w-4xl space-y-6">
              <div>
                <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  Pair Android Phone via QR Code
                </h1>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Scan this QR code with your Android camera or inside the installed ZEN CAM PWA.
                  Both devices can use separate networks (for example, Windows broadband + Android
                  4G/5G).
                </p>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-12 items-start">
                {/* QR Panel */}
                <div className="md:col-span-5 rounded-lg border border-slate-200 bg-white p-5 flex flex-col items-center dark:border-slate-800 dark:bg-[#111827]">
                  <div className="flex h-[264px] w-[264px] items-center justify-center rounded-md border border-slate-200 bg-white p-2">
                    {receiver.session ? (
                      <canvas ref={qrCanvasRef} className="block h-[248px] w-[248px]" />
                    ) : (
                      <div className="text-center text-xs text-slate-500 px-4">
                        {receiver.stage === 'ws_connecting'
                          ? 'Generating secure session...'
                          : 'Waiting for signaling server...'}
                      </div>
                    )}
                  </div>

                  {receiver.session && (
                    <div className="mt-4 w-full space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-500 dark:text-slate-400">Session Code</span>
                        <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                          {receiver.session.sessionId}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-500 dark:text-slate-400">Code Expires In</span>
                        <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {isConnected ? 'Active session' : remainingExpiry ?? '--:--'}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 flex w-full gap-2">
                    <button
                      type="button"
                      onClick={receiver.requestNewSession}
                      className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Regenerate QR</span>
                    </button>
                    <button
                      type="button"
                      disabled={!pairingUrl}
                      onClick={handleCopyPairingLink}
                      className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedLink ? 'Copied' : 'Copy Link'}</span>
                    </button>
                  </div>
                </div>

                {/* Pairing Instructions & Network Configuration */}
                <div className="md:col-span-7 space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4 dark:border-slate-800 dark:bg-[#111827]">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      How Pairing Works
                    </h2>
                    <ol className="space-y-2.5 text-sm text-slate-600 dark:text-slate-300 list-decimal pl-5">
                      <li>
                        Open your Android camera app (or the installed ZEN CAM PWA) and scan the QR
                        code on the left.
                      </li>
                      <li>
                        The signaling server validates the one-time 256-bit security token and
                        exchanges WebRTC session descriptions.
                      </li>
                      <li>
                        Connection status switches to <strong>Connected (WebRTC P2P)</strong> only
                        after the encrypted peer-to-peer link and DataChannel are genuinely open.
                      </li>
                    </ol>

                    {receiver.session && (
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-[#0B0F17]">
                        <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                          Manual Security Token (if QR camera cannot focus)
                        </div>
                        <div className="mt-1 break-all font-mono text-[11px] text-slate-600 dark:text-slate-400 select-all">
                          {receiver.session.token}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          Cross-Network WebRTC / Optional TURN Relay
                        </h2>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          Direct STUN traversal is enabled by default. Configure a custom TURN
                          server only if your ISP/carrier blocks direct P2P.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowTurnPanel((v) => !v)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        <span>{showTurnPanel ? 'Close' : 'Configure'}</span>
                      </button>
                    </div>

                    {showTurnPanel && (
                      <form onSubmit={handleSaveTurnSettings} className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
                        <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                          <input
                            type="checkbox"
                            checked={turnForm.enabled}
                            onChange={(e) => setTurnForm({ ...turnForm, enabled: e.target.checked })}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          <span>Enable custom TURN server for strict NAT networks</span>
                        </label>
                        <div>
                          <label className="block text-xs text-slate-600 dark:text-slate-400">
                            TURN URL(s) (comma-separated, e.g. turn:turn.example.com:3478)
                          </label>
                          <input
                            type="text"
                            value={turnForm.urls}
                            onChange={(e) => setTurnForm({ ...turnForm, urls: e.target.value })}
                            placeholder="turn:your-turn-server:3478"
                            className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                          />
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <label className="block text-xs text-slate-600 dark:text-slate-400">
                              Username
                            </label>
                            <input
                              type="text"
                              value={turnForm.username}
                              onChange={(e) => setTurnForm({ ...turnForm, username: e.target.value })}
                              className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-600 dark:text-slate-400">
                              Credential
                            </label>
                            <input
                              type="password"
                              value={turnForm.credential}
                              onChange={(e) =>
                                setTurnForm({ ...turnForm, credential: e.target.value })
                              }
                              className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                            />
                          </div>
                        </div>
                        <button
                          type="submit"
                          className="h-9 rounded-md bg-blue-700 px-4 text-xs font-medium text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                        >
                          Save Network Settings
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: LIVE CAMERA */}
          {activeTab === 'camera' && (
            <div className="mx-auto max-w-6xl space-y-4">
              {/* Top Camera Control Strip */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111827]">
                <div className="flex flex-wrap items-center gap-2">
                  {receiver.senderStatus.streaming ? (
                    <button
                      type="button"
                      disabled={!isConnected}
                      onClick={receiver.stopRemoteStream}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-red-600 px-3.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      <Square className="h-3.5 w-3.5" />
                      <span>Stop Stream</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!isConnected}
                      onClick={receiver.startRemoteStream}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-700 px-3.5 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span>Start Stream</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!isConnected}
                    onClick={() => receiver.switchCamera()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <SwitchCamera className="h-3.5 w-3.5" />
                    <span>
                      Camera:{' '}
                      {receiver.senderStatus.config.facingMode === 'environment' ? 'Rear' : 'Front'}
                    </span>
                  </button>

                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                    <span className="sr-only">Resolution</span>
                    <select
                      disabled={!isConnected}
                      value={receiver.senderStatus.config.resolution}
                      onChange={(e) =>
                        receiver.updateVideoConfig({
                          resolution: e.target.value as VideoResolutionKey,
                        })
                      }
                      className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-800 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      {(Object.keys(RESOLUTION_MAP) as VideoResolutionKey[]).map((key) => (
                        <option key={key} value={key}>
                          {RESOLUTION_MAP[key].label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                    <span className="sr-only">Frame rate</span>
                    <select
                      disabled={!isConnected}
                      value={receiver.senderStatus.config.fps}
                      onChange={(e) =>
                        receiver.updateVideoConfig({
                          fps: Number(e.target.value) as VideoFps,
                        })
                      }
                      className="h-9 rounded-md border border-slate-300 bg-white px-2.5 font-mono text-xs font-medium text-slate-800 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <option value={15}>15 FPS</option>
                      <option value={24}>24 FPS</option>
                      <option value={30}>30 FPS</option>
                    </select>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!isConnected}
                    onClick={receiver.triggerRemoteCapture}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    <span>Capture Scan</span>
                  </button>

                  <button
                    type="button"
                    disabled={!isConnected || !receiver.senderStatus.streaming}
                    onClick={() => setCleanFeedMode(true)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                    title="Full-window clean video feed for OBS Studio Virtual Camera capture"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    <span>Clean Feed (OBS)</span>
                  </button>
                </div>
              </div>

              {/* Dominant Video Viewport */}
              <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-950 dark:border-slate-800">
                {isConnected && receiver.remoteStream && receiver.senderStatus.streaming ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center">
                    <Camera className="h-8 w-8 text-slate-500" />
                    {!isConnected ? (
                      <>
                        <h3 className="mt-3 text-sm font-semibold text-slate-100">
                          No Android Camera Connected
                        </h3>
                        <p className="mt-1 max-w-md text-xs text-slate-400">
                          Pair your Android phone using the QR code before starting the live camera
                          stream.
                        </p>
                        <button
                          type="button"
                          onClick={() => setActiveTab('pair')}
                          className="mt-4 h-9 rounded-md bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-500"
                        >
                          Show Pairing QR Code
                        </button>
                      </>
                    ) : (
                      <>
                        <h3 className="mt-3 text-sm font-semibold text-slate-100">
                          Phone Paired — Video Stream Stopped
                        </h3>
                        <p className="mt-1 max-w-md text-xs text-slate-400">
                          Click Start Stream above (or on your Android phone) to begin live WebRTC
                          video transmission.
                        </p>
                        <button
                          type="button"
                          onClick={receiver.startRemoteStream}
                          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-500"
                        >
                          <Play className="h-3.5 w-3.5" />
                          <span>Start Remote Camera</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Real measured stream parameters (strictly live WebRTC stats, zero fake data) */}
              {isConnected && receiver.senderStatus.streaming && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
                    <span>
                      Resolution:{' '}
                      {receiver.diagnostics.width > 0
                        ? `${receiver.diagnostics.width}×${receiver.diagnostics.height}`
                        : 'Measuring...'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Measured FPS:{' '}
                      {receiver.diagnostics.fps !== null ? `${receiver.diagnostics.fps}` : '--'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Bitrate:{' '}
                      {receiver.diagnostics.bitrateKbps !== null
                        ? `${receiver.diagnostics.bitrateKbps} kbps`
                        : '--'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('limits')}
                    className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                  >
                    Need this feed in Zoom or e-Sevai? View Virtual Camera Guide
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: DOCUMENT DESK */}
          {activeTab === 'documents' && (
            <div className="mx-auto max-w-6xl space-y-5">
              {/* Local Documents/ZEN CAM Folder Configuration */}
              <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111827]">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-4 w-4 text-blue-700 dark:text-blue-400 shrink-0" />
                      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Local Save Folder: {dirHandle ? dirLabel : 'Documents/ZEN CAM (Not Linked)'}
                      </h2>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Customer documents stay strictly on your Windows 10 PC and are never uploaded
                      to any external cloud.
                      {!fsSupported &&
                        ' Your current browser does not support direct folder linking — JPG and PDF files will download via your browser Downloads folder.'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {fsSupported && dirHandle && dirNeedsGrant && (
                      <button
                        type="button"
                        onClick={handleReconfirmFolderPermission}
                        className="h-9 rounded-md bg-amber-600 px-3 text-xs font-medium text-white hover:bg-amber-700 whitespace-nowrap"
                      >
                        Grant Write Access
                      </button>
                    )}

                    {fsSupported && (
                      <button
                        type="button"
                        onClick={handleLinkFolder}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-700 px-3.5 text-xs font-medium text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        <span>{dirHandle ? 'Change Folder' : 'Link Documents/ZEN CAM'}</span>
                      </button>
                    )}

                    {dirHandle && (
                      <button
                        type="button"
                        onClick={handleUnlinkFolder}
                        className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                      >
                        Unlink
                      </button>
                    )}
                  </div>
                </div>

                {dirHandle && (
                  <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={autoSave}
                        onChange={(e) => setAutoSave(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      <span>
                        Automatically save incoming Android scans as JPG directly into{' '}
                        <span className="font-mono">{dirLabel}</span>
                      </span>
                    </label>
                  </div>
                )}
              </div>

              {/* Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Received Documents ({documents.length})
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {selectedDocIds.size > 0 && (
                    <button
                      type="button"
                      onClick={handleSaveCombinedPdf}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 whitespace-nowrap"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>Save Combined PDF ({selectedDocIds.size} pages)</span>
                    </button>
                  )}

                  {isConnected && (
                    <button
                      type="button"
                      onClick={receiver.triggerRemoteCapture}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Camera className="h-3.5 w-3.5" />
                      <span>Remote Capture</span>
                    </button>
                  )}

                  {documents.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearQueue}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-slate-700 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/40 whitespace-nowrap"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Clear Desk</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Document List / Empty State */}
              {documents.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center dark:border-slate-800 dark:bg-[#111827]">
                  <FileText className="mx-auto h-8 w-8 text-slate-400" />
                  <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    No Documents Received Yet
                  </h3>
                  <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
                    Capture a document on your paired Android phone, crop or rotate it if needed,
                    and tap Send to Windows. It will appear here immediately for JPG or PDF saving.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {documents.map((doc) => {
                    const isSelected = selectedDocIds.has(doc.id);
                    return (
                      <div
                        key={doc.id}
                        className={`flex flex-col overflow-hidden rounded-lg border bg-white dark:bg-[#111827] ${
                          isSelected
                            ? 'border-blue-600 dark:border-blue-500'
                            : 'border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        <div className="relative aspect-[4/3] w-full border-b border-slate-200 dark:border-slate-800">
                          <DocumentThumbnail blob={doc.blob} alt={doc.name} />
                          <label className="absolute left-2.5 top-2.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                setSelectedDocIds((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(doc.id);
                                  else next.delete(doc.id);
                                  return next;
                                });
                              }}
                              aria-label={`Select ${doc.name} for combined PDF`}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                          </label>
                        </div>

                        <div className="flex flex-1 flex-col p-3.5 space-y-3">
                          <div>
                            <div className="truncate font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                              {doc.name}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              <span>
                                {doc.width}×{doc.height}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{formatBytes(doc.sizeBytes)}</span>
                              <span aria-hidden="true">·</span>
                              <span>{new Date(doc.createdAt).toLocaleTimeString()}</span>
                            </div>
                            {doc.savedToDisk && (
                              <div className="mt-1 truncate text-[11px] text-emerald-700 dark:text-emerald-400">
                                Saved: {doc.savedPathLabel || 'Documents/ZEN CAM'}
                              </div>
                            )}
                          </div>

                          <div className="mt-auto grid grid-cols-2 gap-1.5 pt-1">
                            <button
                              type="button"
                              onClick={() => handleSaveJpg(doc)}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded border border-slate-300 bg-white px-2 text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>Save JPG</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveSinglePdf(doc)}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded bg-blue-700 px-2 text-xs font-medium text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              <span>Save PDF</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingDoc(doc)}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              <Crop className="h-3.5 w-3.5" />
                              <span>Crop / Rotate</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteDoc(doc.id)}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded border border-slate-300 bg-white px-2 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-slate-700 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>Remove</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: VIRTUAL CAMERA & BROWSER LIMITATIONS */}
          {activeTab === 'limits' && (
            <VirtualCameraGuide
              canOpenCleanFeed={isConnected && receiver.senderStatus.streaming}
              onOpenCleanFeed={() => {
                setActiveTab('camera');
                setCleanFeedMode(true);
              }}
            />
          )}
        </main>
      </div>

      {/* Document Crop/Rotate Editor */}
      {editingDoc && (
        <DocumentEditorModal
          document={editingDoc}
          confirmLabel="Apply Changes"
          onCancel={() => setEditingDoc(null)}
          onConfirm={handleSaveEditedDoc}
        />
      )}
    </div>
  );
};
