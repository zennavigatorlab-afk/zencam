import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RESOLUTION_MAP,
  type CameraFacing,
  type CapturedDocument,
  type ConnectionStage,
  type DataChannelMessage,
  type TransferProgress,
  type VideoConfig,
} from '../types/protocol';
import { arrayBufferToBase64, defaultDocumentName } from '../utils/documentExport';
import { buildRtcConfiguration, getSignalingWebSocketUrl } from '../utils/iceConfig';

const CHUNK_BYTE_SIZE = 12 * 1024; // 12KB raw -> ~16KB base64 (safe for all WebRTC SCTP limits)
const HIGH_WATER_MARK = 512 * 1024;

interface ImageCaptureCtor {
  new (track: MediaStreamTrack): {
    takePhoto: () => Promise<Blob>;
  };
}

function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  const androidMatch = ua.match(/Android\s[\d.]+;\s([^;)]+)/i);
  if (androidMatch && androidMatch[1]) {
    return androidMatch[1].replace(/Build\/.*$/i, '').trim() || 'Android Phone';
  }
  if (/iPhone/i.test(ua)) return 'iPhone Camera';
  if (/iPad/i.test(ua)) return 'iPad Camera';
  return 'Mobile Browser Camera';
}

export function useMobileSender(options: {
  enabled: boolean;
  onRemoteCaptureReady?: (doc: CapturedDocument) => void;
}) {
  const { enabled, onRemoteCaptureReady } = options;
  const onRemoteCaptureRef = useRef(onRemoteCaptureReady);
  onRemoteCaptureRef.current = onRemoteCaptureReady;

  const [stage, setStage] = useState<ConnectionStage>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pairedSessionId, setPairedSessionId] = useState<string | null>(null);
  const [candidateType, setCandidateType] = useState<string | null>(null);

  const [videoConfig, setVideoConfig] = useState<VideoConfig>({
    facingMode: 'environment',
    resolution: '720p',
    fps: 24,
  });
  const [streaming, setStreaming] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [availableCameras, setAvailableCameras] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const videoConfigRef = useRef<VideoConfig>(videoConfig);
  const streamingRef = useRef<boolean>(streaming);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const ackWaitersRef = useRef<Map<string, (res: { ok: boolean; error?: string }) => void>>(new Map());
  const deviceLabelRef = useRef<string>(detectDeviceLabel());
  const camerasRef = useRef<Array<{ deviceId: string; label: string }>>([]);
  const torchSupportedRef = useRef(false);
  const torchEnabledRef = useRef(false);

  videoConfigRef.current = videoConfig;
  streamingRef.current = streaming;
  camerasRef.current = availableCameras;
  torchSupportedRef.current = torchSupported;
  torchEnabledRef.current = torchEnabled;

  const pushSenderStatus = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    const msg: DataChannelMessage = {
      type: 'sender_status',
      streaming: streamingRef.current,
      config: videoConfigRef.current,
      deviceLabel: deviceLabelRef.current,
      torchSupported: torchSupportedRef.current,
      torchEnabled: torchEnabledRef.current,
      availableCameras: camerasRef.current,
    };
    dc.send(JSON.stringify(msg));
  }, []);

  const refreshCameraList = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${idx + 1}`,
        }));
      setAvailableCameras(cams);
      camerasRef.current = cams;
    } catch {
      // ignore
    }
  }, []);

  const stopCameraStream = useCallback(async () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setStreaming(false);
    streamingRef.current = false;
    setTorchSupported(false);
    setTorchEnabled(false);
    torchSupportedRef.current = false;
    torchEnabledRef.current = false;

    if (videoSenderRef.current) {
      try {
        await videoSenderRef.current.replaceTrack(null);
      } catch {
        // ignore if closed
      }
    }
    pushSenderStatus();
  }, [pushSenderStatus]);

  const startCameraStream = useCallback(
    async (overrideConfig?: Partial<VideoConfig>): Promise<MediaStream | null> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera API is unavailable in this browser. Open ZEN CAM over HTTPS on Android Chrome.');
        return null;
      }

      const nextCfg: VideoConfig = { ...videoConfigRef.current, ...overrideConfig };
      setVideoConfig(nextCfg);
      videoConfigRef.current = nextCfg;
      setCameraError(null);

      // Stop prior tracks before opening a new lens (required by many Android devices)
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      const res = RESOLUTION_MAP[nextCfg.resolution];
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: res.width },
        height: { ideal: res.height },
        frameRate: { ideal: nextCfg.fps, max: nextCfg.fps },
      };

      if (nextCfg.deviceId) {
        videoConstraints.deviceId = { exact: nextCfg.deviceId };
      } else {
        videoConstraints.facingMode = { ideal: nextCfg.facingMode };
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        localStreamRef.current = stream;
        setLocalStream(stream);
        setStreaming(true);
        streamingRef.current = true;

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          // Detect torch capability on Android rear camera
          const caps = (videoTrack.getCapabilities?.() ?? {}) as { torch?: boolean };
          const hasTorch = Boolean(caps.torch);
          setTorchSupported(hasTorch);
          setTorchEnabled(false);
          torchSupportedRef.current = hasTorch;
          torchEnabledRef.current = false;

          if (videoSenderRef.current) {
            await videoSenderRef.current.replaceTrack(videoTrack);
          }
        }

        await refreshCameraList();
        pushSenderStatus();
        return stream;
      } catch (err) {
        setStreaming(false);
        streamingRef.current = false;
        const msg =
          err instanceof Error
            ? err.name === 'NotAllowedError'
              ? 'Camera permission denied. Allow camera access in browser settings.'
              : `Could not start camera: ${err.message}`
            : 'Could not start camera.';
        setCameraError(msg);
        pushSenderStatus();
        return null;
      }
    },
    [pushSenderStatus, refreshCameraList]
  );

  const switchCameraFacing = useCallback(
    async (targetFacing?: CameraFacing) => {
      const nextFacing: CameraFacing =
        targetFacing || (videoConfigRef.current.facingMode === 'environment' ? 'user' : 'environment');
      if (streamingRef.current) {
        await startCameraStream({ facingMode: nextFacing, deviceId: undefined });
      } else {
        const updated: VideoConfig = { ...videoConfigRef.current, facingMode: nextFacing, deviceId: undefined };
        setVideoConfig(updated);
        videoConfigRef.current = updated;
        pushSenderStatus();
      }
    },
    [pushSenderStatus, startCameraStream]
  );

  const updateVideoSettings = useCallback(
    async (partial: Partial<VideoConfig>) => {
      if (streamingRef.current) {
        await startCameraStream(partial);
      } else {
        const updated: VideoConfig = { ...videoConfigRef.current, ...partial };
        setVideoConfig(updated);
        videoConfigRef.current = updated;
        pushSenderStatus();
      }
    },
    [pushSenderStatus, startCameraStream]
  );

  const toggleTorch = useCallback(async () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupportedRef.current) return;
    const next = !torchEnabledRef.current;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchEnabled(next);
      torchEnabledRef.current = next;
      pushSenderStatus();
    } catch {
      // Torch constraint rejected by device
    }
  }, [pushSenderStatus]);

  const captureDocumentFrame = useCallback(async (): Promise<CapturedDocument | null> => {
    let tempOpened = false;
    let stream = localStreamRef.current;

    if (!stream || stream.getVideoTracks().every((t) => t.readyState !== 'live')) {
      stream = await startCameraStream({ facingMode: videoConfigRef.current.facingMode });
      tempOpened = true;
      if (!stream) return null;
      await new Promise((r) => setTimeout(r, 350));
    }

    const track = stream.getVideoTracks()[0];
    if (!track) return null;

    let blob: Blob | null = null;
    let width = 0;
    let height = 0;

    // Prefer native ImageCapture API for full-sensor document sharpness on Android Chrome
    const ImageCaptureApi = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    if (ImageCaptureApi) {
      try {
        const ic = new ImageCaptureApi(track);
        blob = await ic.takePhoto();
      } catch {
        blob = null;
      }
    }

    if (!blob) {
      const videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      await videoEl.play();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      width = videoEl.videoWidth || 1280;
      height = videoEl.videoHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(videoEl, 0, 0, width, height);
      videoEl.srcObject = null;

      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.94)
      );
    } else {
      const url = URL.createObjectURL(blob);
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve({ w: 0, h: 0 });
        };
        img.src = url;
      });
      width = dims.w;
      height = dims.h;
    }

    if (tempOpened) {
      // Keep camera active only if user was already streaming; otherwise leave stopped to save battery
      await stopCameraStream();
    }

    if (!blob) return null;

    const doc: CapturedDocument = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: defaultDocumentName(),
      createdAt: Date.now(),
      mimeType: blob.type || 'image/jpeg',
      width,
      height,
      sizeBytes: blob.size,
      blob,
    };

    return doc;
  }, [startCameraStream, stopCameraStream]);

  const sendDocumentToWindows = useCallback(async (doc: CapturedDocument): Promise<{ ok: boolean; error?: string }> => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') {
      return { ok: false, error: 'Not connected to Windows receiver. Pair via QR first.' };
    }

    const buffer = await doc.blob.arrayBuffer();
    const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / CHUNK_BYTE_SIZE));

    setTransfer({
      docId: doc.id,
      name: doc.name,
      receivedChunks: 0,
      totalChunks,
      direction: 'sending',
    });

    const waitForDrain = () =>
      new Promise<void>((resolve, reject) => {
        if (dc.readyState !== 'open') {
          reject(new Error('Connection closed during transfer.'));
          return;
        }
        if (dc.bufferedAmount <= HIGH_WATER_MARK) {
          resolve();
          return;
        }
        dc.bufferedAmountLowThreshold = HIGH_WATER_MARK / 2;
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', onLow);
      });

    try {
      const startMsg: DataChannelMessage = {
        type: 'doc_start',
        docId: doc.id,
        name: doc.name,
        mimeType: doc.mimeType,
        width: doc.width,
        height: doc.height,
        sizeBytes: buffer.byteLength,
        totalChunks,
        createdAt: doc.createdAt,
      };
      dc.send(JSON.stringify(startMsg));

      for (let i = 0; i < totalChunks; i++) {
        await waitForDrain();
        const slice = buffer.slice(i * CHUNK_BYTE_SIZE, (i + 1) * CHUNK_BYTE_SIZE);
        const chunkMsg: DataChannelMessage = {
          type: 'doc_chunk',
          docId: doc.id,
          index: i,
          data: arrayBufferToBase64(slice),
        };
        dc.send(JSON.stringify(chunkMsg));
        setTransfer({
          docId: doc.id,
          name: doc.name,
          receivedChunks: i + 1,
          totalChunks,
          direction: 'sending',
        });
      }

      const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timeout = window.setTimeout(() => {
          ackWaitersRef.current.delete(doc.id);
          resolve({ ok: false, error: 'Timed out waiting for Windows receiver confirmation.' });
        }, 15_000);
        ackWaitersRef.current.set(doc.id, (result) => {
          clearTimeout(timeout);
          resolve(result);
        });
      });

      dc.send(JSON.stringify({ type: 'doc_end', docId: doc.id } satisfies DataChannelMessage));
      const result = await ackPromise;
      setTransfer(null);
      return result;
    } catch (err) {
      setTransfer(null);
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Document transfer failed.',
      };
    }
  }, []);

  const cleanupConnection = useCallback(() => {
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
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onconnectionstatechange = null;
      try {
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    videoSenderRef.current = null;
    pendingCandidatesRef.current = [];
    setCandidateType(null);
    setTransfer(null);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
  }, []);

  const handleIncomingCommand = useCallback(
    async (raw: string) => {
      let msg: DataChannelMessage;
      try {
        msg = JSON.parse(raw) as DataChannelMessage;
      } catch {
        return;
      }

      if (msg.type === 'doc_ack') {
        const waiter = ackWaitersRef.current.get(msg.docId);
        if (waiter) {
          ackWaitersRef.current.delete(msg.docId);
          waiter({ ok: msg.status === 'received', error: msg.error });
        }
        return;
      }

      if (msg.type === 'cmd_start_stream') {
        await startCameraStream();
      } else if (msg.type === 'cmd_stop_stream') {
        await stopCameraStream();
      } else if (msg.type === 'cmd_switch_camera') {
        await switchCameraFacing(msg.facingMode);
      } else if (msg.type === 'cmd_set_video_config') {
        await updateVideoSettings(msg.config);
      } else if (msg.type === 'cmd_trigger_capture') {
        const captured = await captureDocumentFrame();
        if (captured) {
          onRemoteCaptureRef.current?.(captured);
          await sendDocumentToWindows(captured);
        }
      }
    },
    [
      captureDocumentFrame,
      sendDocumentToWindows,
      startCameraStream,
      stopCameraStream,
      switchCameraFacing,
      updateVideoSettings,
    ]
  );

  const pairWithSession = useCallback(
    (sessionId: string, token: string) => {
      const cleanId = sessionId.trim().toUpperCase();
      const cleanToken = token.trim();
      if (!cleanId || !cleanToken) {
        setStage('failed');
        setErrorMessage('Invalid QR code: missing session ID or security token.');
        return;
      }

      cleanupConnection();
      setStage('ws_connecting');
      setErrorMessage(null);
      setPairedSessionId(cleanId);

      const ws = new WebSocket(getSignalingWebSocketUrl());
      wsRef.current = ws;

      const sendWs = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      };

      ws.onopen = () => {
        setStage('signaling');
        sendWs({
          type: 'join_session',
          sessionId: cleanId,
          token: cleanToken,
          deviceLabel: deviceLabelRef.current,
        });
      };

      ws.onmessage = async (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === 'error') {
          setStage('failed');
          setErrorMessage(String(msg.message || 'Pairing rejected by server.'));
          cleanupConnection();
          return;
        }

        if (msg.type === 'peer_left' || msg.type === 'session_expired') {
          setStage('disconnected');
          setPairedSessionId(null);
          setErrorMessage('Windows receiver disconnected or ended the session.');
          cleanupConnection();
          return;
        }

        if (msg.type === 'session_joined') {
          setStage('webrtc_connecting');
          const pc = new RTCPeerConnection(buildRtcConfiguration());
          pcRef.current = pc;

          // Pre-create sendonly video transceiver so starting/stopping/switching camera works via replaceTrack without renegotiation
          const currentTrack = localStreamRef.current?.getVideoTracks()[0] || null;
          const transceiver = pc.addTransceiver(currentTrack || 'video', {
            direction: 'sendonly',
            streams: localStreamRef.current ? [localStreamRef.current] : [],
          });
          videoSenderRef.current = transceiver.sender;

          const dc = pc.createDataChannel('zencam-data', { ordered: true });
          dcRef.current = dc;

          dc.onopen = () => {
            if (
              pc.iceConnectionState === 'connected' ||
              pc.iceConnectionState === 'completed' ||
              pc.connectionState === 'connected'
            ) {
              setStage('connected');
              setErrorMessage(null);
            }
            pushSenderStatus();
          };

          dc.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
              void handleIncomingCommand(ev.data);
            }
          };

          dc.onclose = () => {
            if (pcRef.current === pc) {
              setStage('disconnected');
            }
          };

          pc.onicecandidate = (iceEvt) => {
            if (iceEvt.candidate) {
              sendWs({
                type: 'signal',
                signalType: 'ice-candidate',
                data: iceEvt.candidate.toJSON(),
              });
            }
          };

          const syncState = () => {
            const ice = pc.iceConnectionState;
            const conn = pc.connectionState;
            if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
              if (dc.readyState === 'open') {
                setStage('connected');
                setErrorMessage(null);
                pushSenderStatus();
              } else {
                setStage('webrtc_connecting');
              }
            } else if (ice === 'checking' || conn === 'connecting') {
              setStage('webrtc_connecting');
            } else if (ice === 'failed' || conn === 'failed') {
              setStage('failed');
              setErrorMessage(
                'WebRTC direct connection failed. Your mobile carrier or firewall may require a TURN server.'
              );
            } else if (ice === 'disconnected' || conn === 'disconnected') {
              setStage('webrtc_connecting');
            }
          };

          pc.oniceconnectionstatechange = syncState;
          pc.onconnectionstatechange = syncState;

          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendWs({
              type: 'signal',
              signalType: 'offer',
              data: pc.localDescription?.toJSON(),
            });
          } catch (err) {
            setStage('failed');
            setErrorMessage(err instanceof Error ? err.message : 'Failed to create WebRTC offer.');
          }
          return;
        }

        if (msg.type === 'signal' && pcRef.current) {
          const pc = pcRef.current;
          try {
            if (msg.signalType === 'answer' && msg.data) {
              await pc.setRemoteDescription(
                new RTCSessionDescription(msg.data as RTCSessionDescriptionInit)
              );
              for (const cand of pendingCandidatesRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              }
              pendingCandidatesRef.current = [];
            } else if (msg.signalType === 'ice-candidate' && msg.data) {
              const cand = msg.data as RTCIceCandidateInit;
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } else {
                pendingCandidatesRef.current.push(cand);
              }
            }
          } catch (err) {
            setStage('failed');
            setErrorMessage(err instanceof Error ? err.message : 'WebRTC signaling failed.');
          }
        }
      };

      ws.onerror = () => {
        setStage('failed');
        setErrorMessage('Could not reach the signaling server.');
      };

      ws.onclose = () => {
        setStage((prev) => (prev === 'failed' ? 'failed' : 'disconnected'));
      };
    },
    [cleanupConnection, handleIncomingCommand, pushSenderStatus]
  );

  const unpair = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unpair' }));
    }
    cleanupConnection();
    setPairedSessionId(null);
    setStage('disconnected');
    setErrorMessage(null);
  }, [cleanupConnection]);

  // Poll real ICE candidate type when connected
  useEffect(() => {
    if (stage !== 'connected') return;
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        const locals = new Map<string, string>();
        let selectedPairId: string | null = null;
        stats.forEach((r) => {
          if (r.type === 'local-candidate' && r.candidateType) locals.set(r.id, r.candidateType);
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            selectedPairId = r.selectedCandidatePairId;
          }
        });
        stats.forEach((r) => {
          if (
            r.type === 'candidate-pair' &&
            (r.id === selectedPairId || r.selected || r.nominated) &&
            r.state === 'succeeded'
          ) {
            const ct = locals.get(r.localCandidateId);
            if (ct) setCandidateType(ct);
          }
        });
      } catch {
        // ignore
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [stage]);

  // Cleanup on disable/unmount
  useEffect(() => {
    if (!enabled) {
      void stopCameraStream();
      cleanupConnection();
      setStage('disconnected');
      setPairedSessionId(null);
    }
    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      cleanupConnection();
    };
  }, [cleanupConnection, enabled, stopCameraStream]);

  return {
    stage,
    errorMessage,
    pairedSessionId,
    candidateType,
    videoConfig,
    streaming,
    localStream,
    cameraError,
    availableCameras,
    torchSupported,
    torchEnabled,
    transfer,
    pairWithSession,
    unpair,
    startCameraStream,
    stopCameraStream,
    switchCameraFacing,
    updateVideoSettings,
    toggleTorch,
    captureDocumentFrame,
    sendDocumentToWindows,
  };
}
