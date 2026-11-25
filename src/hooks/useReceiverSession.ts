import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CameraFacing,
  CapturedDocument,
  ConnectionStage,
  DataChannelMessage,
  PairingSessionInfo,
  StreamDiagnostics,
  TransferProgress,
  VideoConfig,
} from '../types/protocol';
import { base64ToUint8Array } from '../utils/documentExport';
import { buildRtcConfiguration, getSignalingWebSocketUrl } from '../utils/iceConfig';

interface IncomingDocBuffer {
  docId: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  totalChunks: number;
  createdAt: number;
  chunks: Array<string | undefined>;
  receivedCount: number;
}

interface SenderStatusState {
  streaming: boolean;
  config: VideoConfig;
  deviceLabel: string;
  torchSupported: boolean;
  torchEnabled: boolean;
  availableCameras: Array<{ deviceId: string; label: string }>;
}

const INITIAL_SENDER_STATUS: SenderStatusState = {
  streaming: false,
  config: { facingMode: 'environment', resolution: '720p', fps: 24 },
  deviceLabel: '',
  torchSupported: false,
  torchEnabled: false,
  availableCameras: [],
};

export function useReceiverSession(options: {
  enabled: boolean;
  onDocumentReceived: (doc: CapturedDocument) => void;
}) {
  const { enabled, onDocumentReceived } = options;
  const onDocRef = useRef(onDocumentReceived);
  onDocRef.current = onDocumentReceived;

  const [stage, setStage] = useState<ConnectionStage>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [session, setSession] = useState<PairingSessionInfo | null>(null);
  const [peerLabel, setPeerLabel] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [senderStatus, setSenderStatus] = useState<SenderStatusState>(INITIAL_SENDER_STATUS);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const [diagnostics, setDiagnostics] = useState<StreamDiagnostics>({
    width: 0,
    height: 0,
    fps: null,
    candidateType: null,
    bitrateKbps: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const incomingDocsRef = useRef<Map<string, IncomingDocBuffer>>(new Map());
  const prevBytesRef = useRef<{ bytes: number; ts: number } | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const sendCommand = useCallback((msg: DataChannelMessage): boolean => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(msg));
    return true;
  }, []);

  const cleanupPeerConnection = useCallback(() => {
    if (dcRef.current) {
      dcRef.current.onmessage = null;
      dcRef.current.onopen = null;
      dcRef.current.onclose = null;
      try {
        dcRef.current.close();
      } catch {
        // ignore
      }
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.ondatachannel = null;
      try {
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    pendingCandidatesRef.current = [];
    incomingDocsRef.current.clear();
    prevBytesRef.current = null;
    setRemoteStream(null);
    setTransfer(null);
    setSenderStatus(INITIAL_SENDER_STATUS);
    setDiagnostics({
      width: 0,
      height: 0,
      fps: null,
      candidateType: null,
      bitrateKbps: null,
    });
  }, []);

  const handleDataChannelMessage = useCallback((rawData: string) => {
    let msg: DataChannelMessage;
    try {
      msg = JSON.parse(rawData) as DataChannelMessage;
    } catch {
      return;
    }

    if (msg.type === 'sender_status') {
      setSenderStatus({
        streaming: msg.streaming,
        config: msg.config,
        deviceLabel: msg.deviceLabel,
        torchSupported: msg.torchSupported,
        torchEnabled: msg.torchEnabled,
        availableCameras: msg.availableCameras,
      });
      if (msg.deviceLabel) {
        setPeerLabel(msg.deviceLabel);
      }
      return;
    }

    if (msg.type === 'doc_start') {
      incomingDocsRef.current.set(msg.docId, {
        docId: msg.docId,
        name: msg.name,
        mimeType: msg.mimeType || 'image/jpeg',
        width: msg.width,
        height: msg.height,
        sizeBytes: msg.sizeBytes,
        totalChunks: msg.totalChunks,
        createdAt: msg.createdAt || Date.now(),
        chunks: new Array<string | undefined>(msg.totalChunks),
        receivedCount: 0,
      });
      setTransfer({
        docId: msg.docId,
        name: msg.name,
        receivedChunks: 0,
        totalChunks: msg.totalChunks,
        direction: 'receiving',
      });
      return;
    }

    if (msg.type === 'doc_chunk') {
      const buf = incomingDocsRef.current.get(msg.docId);
      if (!buf) return;
      if (msg.index >= 0 && msg.index < buf.totalChunks && buf.chunks[msg.index] === undefined) {
        buf.chunks[msg.index] = msg.data;
        buf.receivedCount += 1;
        setTransfer({
          docId: buf.docId,
          name: buf.name,
          receivedChunks: buf.receivedCount,
          totalChunks: buf.totalChunks,
          direction: 'receiving',
        });
      }
      return;
    }

    if (msg.type === 'doc_end') {
      const buf = incomingDocsRef.current.get(msg.docId);
      if (!buf) return;
      incomingDocsRef.current.delete(msg.docId);
      setTransfer(null);

      if (buf.receivedCount !== buf.totalChunks || buf.chunks.some((c) => c === undefined)) {
        sendCommand({
          type: 'doc_ack',
          docId: buf.docId,
          status: 'error',
          error: 'Incomplete transfer chunks received.',
        });
        return;
      }

      try {
        const parts = buf.chunks.map((c) => base64ToUint8Array(c as string));
        const blobParts: BlobPart[] = parts.map(
          (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
        );
        const blob = new Blob(blobParts, { type: buf.mimeType });
        const doc: CapturedDocument = {
          id: buf.docId,
          name: buf.name,
          createdAt: buf.createdAt,
          mimeType: buf.mimeType,
          width: buf.width,
          height: buf.height,
          sizeBytes: blob.size,
          blob,
        };
        sendCommand({ type: 'doc_ack', docId: buf.docId, status: 'received' });
        onDocRef.current(doc);
      } catch {
        sendCommand({
          type: 'doc_ack',
          docId: buf.docId,
          status: 'error',
          error: 'Failed to decode transferred document.',
        });
      }
    }
  }, [sendCommand]);

  const ensurePeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection(buildRtcConfiguration());
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({
          type: 'signal',
          signalType: 'ice-candidate',
          data: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      setRemoteStream(stream);
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      dcRef.current = channel;
      channel.onopen = () => {
        if (
          pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed' ||
          pc.connectionState === 'connected'
        ) {
          setStage('connected');
          setErrorMessage(null);
        }
      };
      channel.onclose = () => {
        if (pcRef.current === pc) {
          setStage((prev) => (prev === 'connected' ? 'waiting_for_peer' : prev));
        }
      };
      channel.onmessage = (msgEvt) => {
        if (typeof msgEvt.data === 'string') {
          handleDataChannelMessage(msgEvt.data);
        }
      };
    };

    const syncConnectionState = () => {
      const ice = pc.iceConnectionState;
      const conn = pc.connectionState;
      if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
        if (dcRef.current?.readyState === 'open') {
          setStage('connected');
          setErrorMessage(null);
        } else {
          setStage('webrtc_connecting');
        }
      } else if (ice === 'checking' || conn === 'connecting') {
        setStage('webrtc_connecting');
      } else if (ice === 'failed' || conn === 'failed') {
        setStage('failed');
        setErrorMessage(
          'Direct WebRTC peer connection failed across networks. Try re-pairing or configure a TURN server in Network Settings.'
        );
      } else if (ice === 'disconnected' || conn === 'disconnected') {
        setStage('webrtc_connecting');
      } else if (ice === 'closed' || conn === 'closed') {
        setStage('waiting_for_peer');
      }
    };

    pc.oniceconnectionstatechange = syncConnectionState;
    pc.onconnectionstatechange = syncConnectionState;

    return pc;
  }, [handleDataChannelMessage, sendWs]);

  const requestNewSession = useCallback(() => {
    cleanupPeerConnection();
    setPeerLabel(null);
    setErrorMessage(null);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setStage('ws_connecting');
      sendWs({ type: 'create_session' });
    }
  }, [cleanupPeerConnection, sendWs]);

  const unpair = useCallback(() => {
    sendWs({ type: 'unpair' });
    cleanupPeerConnection();
    setPeerLabel(null);
    setSession(null);
    setErrorMessage(null);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      sendWs({ type: 'create_session' });
    }
  }, [cleanupPeerConnection, sendWs]);

  // WebSocket lifecycle
  useEffect(() => {
    if (!enabled) {
      cleanupPeerConnection();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStage('disconnected');
      setSession(null);
      return;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStage('ws_connecting');
      setErrorMessage(null);

      const ws = new WebSocket(getSignalingWebSocketUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        ws.send(JSON.stringify({ type: 'create_session' }));
      };

      ws.onmessage = async (event) => {
        if (disposed) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === 'session_created') {
          setSession({
            sessionId: String(msg.sessionId),
            token: String(msg.token),
            expiresAt: Number(msg.expiresAt),
          });
          setStage('waiting_for_peer');
          setErrorMessage(null);
          return;
        }

        if (msg.type === 'peer_joined') {
          setPeerLabel(String(msg.deviceLabel || 'Android Device'));
          setStage('signaling');
          setErrorMessage(null);
          cleanupPeerConnection();
          ensurePeerConnection();
          return;
        }

        if (msg.type === 'peer_left') {
          cleanupPeerConnection();
          setPeerLabel(null);
          setStage('waiting_for_peer');
          if (msg.reason === 'unpaired') {
            ws.send(JSON.stringify({ type: 'create_session' }));
          }
          return;
        }

        if (msg.type === 'session_expired') {
          cleanupPeerConnection();
          setPeerLabel(null);
          setSession(null);
          ws.send(JSON.stringify({ type: 'create_session' }));
          return;
        }

        if (msg.type === 'error') {
          setErrorMessage(String(msg.message || 'Signaling error occurred.'));
          return;
        }

        if (msg.type === 'signal') {
          const pc = ensurePeerConnection();
          const signalType = msg.signalType;
          const data = msg.data;

          try {
            if (signalType === 'offer' && data) {
              setStage('webrtc_connecting');
              await pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
              for (const cand of pendingCandidatesRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              }
              pendingCandidatesRef.current = [];
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              sendWs({
                type: 'signal',
                signalType: 'answer',
                data: pc.localDescription?.toJSON(),
              });
            } else if (signalType === 'ice-candidate' && data) {
              const candidateInit = data as RTCIceCandidateInit;
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
              } else {
                pendingCandidatesRef.current.push(candidateInit);
              }
            }
          } catch (err) {
            setStage('failed');
            setErrorMessage(
              err instanceof Error ? `WebRTC handshake error: ${err.message}` : 'WebRTC handshake error.'
            );
          }
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        cleanupPeerConnection();
        setPeerLabel(null);
        setSession(null);
        setStage('disconnected');
        reconnectTimerRef.current = window.setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        if (disposed) return;
        setErrorMessage('Signaling server connection interrupted. Reconnecting...');
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      cleanupPeerConnection();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [cleanupPeerConnection, enabled, ensurePeerConnection, sendWs]);

  // Real WebRTC stats polling (only when connected — never fabricated)
  useEffect(() => {
    if (stage !== 'connected') return;

    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let width = 0;
        let height = 0;
        let fps: number | null = null;
        let bitrateKbps: number | null = null;
        let candidateType: string | null = null;

        let selectedPairId: string | null = null;
        const localCandidates = new Map<string, string>();

        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (typeof report.frameWidth === 'number') width = report.frameWidth;
            if (typeof report.frameHeight === 'number') height = report.frameHeight;
            if (typeof report.framesPerSecond === 'number') {
              fps = Math.round(report.framesPerSecond);
            }
            if (typeof report.bytesReceived === 'number') {
              const now = report.timestamp || performance.now();
              if (prevBytesRef.current && now > prevBytesRef.current.ts) {
                const deltaBytes = report.bytesReceived - prevBytesRef.current.bytes;
                const deltaSec = (now - prevBytesRef.current.ts) / 1000;
                if (deltaBytes >= 0 && deltaSec > 0) {
                  bitrateKbps = Math.round((deltaBytes * 8) / deltaSec / 1000);
                }
              }
              prevBytesRef.current = { bytes: report.bytesReceived, ts: now };
            }
          } else if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPairId = report.selectedCandidatePairId;
          } else if (report.type === 'local-candidate' && report.candidateType) {
            localCandidates.set(report.id, report.candidateType);
          }
        });

        stats.forEach((report) => {
          if (
            report.type === 'candidate-pair' &&
            (report.id === selectedPairId || report.selected || report.nominated) &&
            report.state === 'succeeded'
          ) {
            const ct = localCandidates.get(report.localCandidateId);
            if (ct) candidateType = ct;
          }
        });

        setDiagnostics({ width, height, fps, candidateType, bitrateKbps });
      } catch {
        // ignore transient stats error
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [stage]);

  // Remote camera control helpers
  const switchCamera = useCallback(
    (facingMode?: CameraFacing) => sendCommand({ type: 'cmd_switch_camera', facingMode }),
    [sendCommand]
  );

  const updateVideoConfig = useCallback(
    (config: Partial<VideoConfig>) => sendCommand({ type: 'cmd_set_video_config', config }),
    [sendCommand]
  );

  const startRemoteStream = useCallback(() => sendCommand({ type: 'cmd_start_stream' }), [sendCommand]);
  const stopRemoteStream = useCallback(() => sendCommand({ type: 'cmd_stop_stream' }), [sendCommand]);
  const triggerRemoteCapture = useCallback(() => sendCommand({ type: 'cmd_trigger_capture' }), [sendCommand]);

  return {
    stage,
    errorMessage,
    session,
    peerLabel,
    remoteStream,
    senderStatus,
    transfer,
    diagnostics,
    requestNewSession,
    unpair,
    switchCamera,
    updateVideoConfig,
    startRemoteStream,
    stopRemoteStream,
    triggerRemoteCapture,
  };
}
