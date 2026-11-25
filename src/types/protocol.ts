export type AppRole = 'desktop' | 'mobile';

export type ConnectionStage =
  | 'disconnected'
  | 'ws_connecting'
  | 'waiting_for_peer'
  | 'signaling'
  | 'webrtc_connecting'
  | 'connected'
  | 'failed';

export type CameraFacing = 'environment' | 'user';
export type VideoResolutionKey = '480p' | '720p' | '1080p';
export type VideoFps = 15 | 24 | 30;
export type DocumentFilter = 'original' | 'document' | 'grayscale';

export interface VideoConfig {
  facingMode: CameraFacing;
  resolution: VideoResolutionKey;
  fps: VideoFps;
  deviceId?: string;
}

export const RESOLUTION_MAP: Record<VideoResolutionKey, { width: number; height: number; label: string }> = {
  '480p': { width: 640, height: 480, label: '640 × 480 (SD)' },
  '720p': { width: 1280, height: 720, label: '1280 × 720 (HD)' },
  '1080p': { width: 1920, height: 1080, label: '1920 × 1080 (Full HD)' },
};

export interface PairingSessionInfo {
  sessionId: string;
  token: string;
  expiresAt: number;
}

export interface StreamDiagnostics {
  width: number;
  height: number;
  fps: number | null;
  candidateType: string | null;
  bitrateKbps: number | null;
}

export interface CapturedDocument {
  id: string;
  name: string;
  createdAt: number;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  blob: Blob;
  savedToDisk?: boolean;
  savedPathLabel?: string;
}

export interface CropRect {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  width: number; // normalized 0..1
  height: number; // normalized 0..1
}

export interface TurnSettings {
  enabled: boolean;
  urls: string;
  username: string;
  credential: string;
}

// DataChannel control & transfer protocol (strictly P2P over WebRTC DTLS)
export type DataChannelMessage =
  | { type: 'cmd_switch_camera'; facingMode?: CameraFacing }
  | { type: 'cmd_set_video_config'; config: Partial<VideoConfig> }
  | { type: 'cmd_start_stream' }
  | { type: 'cmd_stop_stream' }
  | { type: 'cmd_trigger_capture' }
  | {
      type: 'sender_status';
      streaming: boolean;
      config: VideoConfig;
      deviceLabel: string;
      torchSupported: boolean;
      torchEnabled: boolean;
      availableCameras: Array<{ deviceId: string; label: string }>;
    }
  | {
      type: 'doc_start';
      docId: string;
      name: string;
      mimeType: string;
      width: number;
      height: number;
      sizeBytes: number;
      totalChunks: number;
      createdAt: number;
    }
  | {
      type: 'doc_chunk';
      docId: string;
      index: number;
      data: string; // base64 chunk
    }
  | {
      type: 'doc_end';
      docId: string;
    }
  | {
      type: 'doc_ack';
      docId: string;
      status: 'received' | 'error';
      error?: string;
    };

export interface TransferProgress {
  docId: string;
  name: string;
  receivedChunks: number;
  totalChunks: number;
  direction: 'sending' | 'receiving';
}
