import type { TurnSettings } from '../types/protocol';

const TURN_STORAGE_KEY = 'zencam_turn_settings_v1';

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export function loadTurnSettings(): TurnSettings {
  try {
    const raw = localStorage.getItem(TURN_STORAGE_KEY);
    if (!raw) {
      return { enabled: false, urls: '', username: '', credential: '' };
    }
    const parsed = JSON.parse(raw) as Partial<TurnSettings>;
    return {
      enabled: Boolean(parsed.enabled),
      urls: typeof parsed.urls === 'string' ? parsed.urls : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      credential: typeof parsed.credential === 'string' ? parsed.credential : '',
    };
  } catch {
    return { enabled: false, urls: '', username: '', credential: '' };
  }
}

export function saveTurnSettings(settings: TurnSettings): void {
  localStorage.setItem(TURN_STORAGE_KEY, JSON.stringify(settings));
}

export function buildRtcConfiguration(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [...DEFAULT_STUN_SERVERS];
  const turn = loadTurnSettings();

  if (turn.enabled && turn.urls.trim()) {
    const urls = turn.urls
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.startsWith('turn:') || u.startsWith('turns:') || u.startsWith('stun:'));

    if (urls.length > 0) {
      const server: RTCIceServer = { urls };
      if (turn.username.trim()) server.username = turn.username.trim();
      if (turn.credential) server.credential = turn.credential;
      iceServers.push(server);
    }
  }

  return {
    iceServers,
    iceCandidatePoolSize: 4,
  };
}

export function getSignalingWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function formatCandidateType(type: string | null): string {
  switch (type) {
    case 'host':
      return 'Direct local network (LAN)';
    case 'srflx':
      return 'Direct peer-to-peer (NAT / Mobile)';
    case 'prflx':
      return 'Direct peer-to-peer (Reflexive)';
    case 'relay':
      return 'Relayed via TURN server';
    default:
      return 'Negotiating route';
  }
}
