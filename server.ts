import crypto from 'crypto';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 15 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_SESSIONS_PER_IP_PER_MIN = 30;
const SESSION_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type PeerRole = 'receiver' | 'sender';

interface SessionRoom {
  id: string;
  tokenHash: Buffer;
  createdAt: number;
  expiresAt: number;
  receiver: WebSocket | null;
  sender: WebSocket | null;
  senderLabel: string | null;
}

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
  sessionId?: string;
  role?: PeerRole;
  clientIp?: string;
}

const sessions = new Map<string, SessionRoom>();
const ipRateBuckets = new Map<string, { count: number; resetAt: number }>();

function generateSessionId(): string {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += SESSION_ID_ALPHABET[bytes[i] % SESSION_ID_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function hashToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}

function verifyToken(expectedHash: Buffer, candidateToken: string): boolean {
  if (typeof candidateToken !== 'string' || candidateToken.length < 16 || candidateToken.length > 128) {
    return false;
  }
  const candidateHash = hashToken(candidateToken);
  if (candidateHash.length !== expectedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipRateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    ipRateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= MAX_SESSIONS_PER_IP_PER_MIN) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function safeSend(ws: WebSocket | null | undefined, payload: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sanitizeLabel(input: unknown): string {
  if (typeof input !== 'string') return 'Android Device';
  const cleaned = input.replace(/[^\w\s().-]/g, '').trim().slice(0, 48);
  return cleaned || 'Android Device';
}

function detachSocketFromSession(ws: TrackedSocket, reason: string): void {
  const { sessionId, role } = ws;
  if (!sessionId || !role) return;

  ws.sessionId = undefined;
  ws.role = undefined;

  const room = sessions.get(sessionId);
  if (!room) return;

  if (role === 'receiver' && room.receiver === ws) {
    room.receiver = null;
    safeSend(room.sender, { type: 'peer_left', role: 'receiver', reason });
    if (room.sender) {
      (room.sender as TrackedSocket).sessionId = undefined;
      (room.sender as TrackedSocket).role = undefined;
    }
    sessions.delete(sessionId);
  } else if (role === 'sender' && room.sender === ws) {
    room.sender = null;
    room.senderLabel = null;
    safeSend(room.receiver, { type: 'peer_left', role: 'sender', reason });
    // Keep receiver session alive if receiver is still waiting, unless explicitly unpaired
    if (reason === 'unpaired') {
      if (room.receiver) {
        (room.receiver as TrackedSocket).sessionId = undefined;
        (room.receiver as TrackedSocket).role = undefined;
      }
      sessions.delete(sessionId);
    }
  }
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'zen-cam-signaling',
      activeRooms: sessions.size,
      timestamp: Date.now(),
    });
  });

  const server = http.createServer(app);

  // Signaling WebSocket server — strictly ephemeral SDP/ICE relay, zero document storage.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 64 * 1024,
  });

  wss.on('connection', (socket: WebSocket, req) => {
    const ws = socket as TrackedSocket;
    ws.isAlive = true;
    const forwarded = req.headers['x-forwarded-for'];
    ws.clientIp =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req.socket.remoteAddress || 'unknown';

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    safeSend(ws, { type: 'server_ready', timestamp: Date.now() });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return;
        }
        msg = parsed as Record<string, unknown>;
      } catch {
        safeSend(ws, { type: 'error', code: 'MALFORMED_JSON', message: 'Invalid signaling message.' });
        return;
      }

      const type = msg.type;
      if (typeof type !== 'string') return;

      if (type === 'ping') {
        safeSend(ws, { type: 'pong', timestamp: Date.now() });
        return;
      }

      if (type === 'create_session') {
        if (!checkRateLimit(ws.clientIp || 'unknown')) {
          safeSend(ws, {
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many pairing requests. Wait a minute and try again.',
          });
          return;
        }

        // Clean up any prior session bound to this socket
        detachSocketFromSession(ws, 'replaced');

        let sessionId = generateSessionId();
        while (sessions.has(sessionId)) {
          sessionId = generateSessionId();
        }
        const token = crypto.randomBytes(24).toString('base64url');
        const now = Date.now();
        const expiresAt = now + SESSION_TTL_MS;

        sessions.set(sessionId, {
          id: sessionId,
          tokenHash: hashToken(token),
          createdAt: now,
          expiresAt,
          receiver: ws,
          sender: null,
          senderLabel: null,
        });

        ws.sessionId = sessionId;
        ws.role = 'receiver';

        safeSend(ws, {
          type: 'session_created',
          sessionId,
          token,
          expiresAt,
        });
        return;
      }

      if (type === 'join_session') {
        const sessionId =
          typeof msg.sessionId === 'string' ? msg.sessionId.trim().toUpperCase() : '';
        const token = typeof msg.token === 'string' ? msg.token.trim() : '';
        const deviceLabel = sanitizeLabel(msg.deviceLabel);

        const room = sessions.get(sessionId);
        if (!room || !room.receiver || room.receiver.readyState !== WebSocket.OPEN) {
          safeSend(ws, {
            type: 'error',
            code: 'SESSION_NOT_FOUND',
            message: 'Pairing session not found or Windows receiver is offline.',
          });
          return;
        }

        if (Date.now() > room.expiresAt && !room.sender) {
          sessions.delete(sessionId);
          safeSend(ws, {
            type: 'error',
            code: 'SESSION_EXPIRED',
            message: 'QR code expired. Generate a fresh QR code on Windows.',
          });
          return;
        }

        if (!verifyToken(room.tokenHash, token)) {
          safeSend(ws, {
            type: 'error',
            code: 'INVALID_TOKEN',
            message: 'Security token mismatch. Scan the latest QR code from Windows.',
          });
          return;
        }

        if (room.sender && room.sender !== ws && room.sender.readyState === WebSocket.OPEN) {
          safeSend(ws, {
            type: 'error',
            code: 'ROOM_OCCUPIED',
            message: 'Another camera device is already paired with this Windows session.',
          });
          return;
        }

        detachSocketFromSession(ws, 'rejoined');

        room.sender = ws;
        room.senderLabel = deviceLabel;
        room.expiresAt = Date.now() + SESSION_TTL_MS;
        ws.sessionId = sessionId;
        ws.role = 'sender';

        safeSend(ws, {
          type: 'session_joined',
          sessionId,
          receiverConnected: true,
        });

        safeSend(room.receiver, {
          type: 'peer_joined',
          sessionId,
          role: 'sender',
          deviceLabel,
        });
        return;
      }

      if (type === 'signal') {
        if (!ws.sessionId || !ws.role) {
          safeSend(ws, {
            type: 'error',
            code: 'NOT_PAIRED',
            message: 'Cannot relay WebRTC signaling without an authenticated session.',
          });
          return;
        }

        const room = sessions.get(ws.sessionId);
        if (!room) {
          safeSend(ws, {
            type: 'error',
            code: 'SESSION_CLOSED',
            message: 'Pairing session is no longer active.',
          });
          return;
        }

        const signalType = msg.signalType;
        if (
          signalType !== 'offer' &&
          signalType !== 'answer' &&
          signalType !== 'ice-candidate' &&
          signalType !== 'renegotiate'
        ) {
          return;
        }

        const target = ws.role === 'receiver' ? room.sender : room.receiver;
        if (!target || target.readyState !== WebSocket.OPEN) {
          safeSend(ws, {
            type: 'error',
            code: 'PEER_OFFLINE',
            message: 'Paired peer is currently offline.',
          });
          return;
        }

        room.expiresAt = Date.now() + SESSION_TTL_MS;
        safeSend(target, {
          type: 'signal',
          from: ws.role,
          signalType,
          data: msg.data,
        });
        return;
      }

      if (type === 'unpair') {
        detachSocketFromSession(ws, 'unpaired');
        safeSend(ws, { type: 'unpaired' });
      }
    });

    ws.on('close', () => {
      detachSocketFromSession(ws, 'disconnected');
    });

    ws.on('error', () => {
      detachSocketFromSession(ws, 'socket_error');
    });
  });

  // Periodic heartbeat & expired-room cleanup
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const tracked = client as TrackedSocket;
      if (tracked.isAlive === false) {
        detachSocketFromSession(tracked, 'timeout');
        tracked.terminate();
        continue;
      }
      tracked.isAlive = false;
      tracked.ping();
    }

    for (const [id, room] of sessions.entries()) {
      const receiverAlive = room.receiver && room.receiver.readyState === WebSocket.OPEN;
      const senderAlive = room.sender && room.sender.readyState === WebSocket.OPEN;
      if (!receiverAlive || (!senderAlive && now > room.expiresAt)) {
        safeSend(room.receiver, { type: 'session_expired', sessionId: id });
        safeSend(room.sender, { type: 'session_expired', sessionId: id });
        sessions.delete(id);
      }
    }

    for (const [ip, bucket] of ipRateBuckets.entries()) {
      if (now > bucket.resetAt) {
        ipRateBuckets.delete(ip);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  server.on('close', () => {
    clearInterval(cleanupTimer);
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ZEN CAM server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ZEN CAM server:', err);
  process.exit(1);
});
