import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SOCKET_EVENT, SOCKET_JOIN } from '@classpulse/shared-types';
import { AuthService } from './auth';
import { SessionEvents } from './events';
import { SessionService } from './sessions';

export const allowedOrigins = () => (process.env.FRONTEND_ORIGIN ?? process.env.CORS_ORIGIN ?? 'http://localhost,http://localhost:8080,http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean);
@WebSocketGateway({ cors: { origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, !origin || allowedOrigins().includes(origin)), credentials: true }, maxHttpBufferSize: 16384 })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private unsubscribe?: () => void;
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService, private readonly events: SessionEvents) {}
  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== 'string') throw new Error();
        socket.data.teacherId = await this.auth.verify(token);
        socket.data.token = token;
        next();
      } catch { next(new Error('Unauthorized')); }
    });
  }
  handleConnection(client: Socket) {
    // Bound the socket's lifetime to its JWT expiry; reconnect performs authentication again.
    try {
      const payload = JSON.parse(Buffer.from(client.data.token.split('.')[1], 'base64url').toString());
      const expiry = setTimeout(() => client.disconnect(true), Math.max(0, payload.exp * 1000 - Date.now()));
      expiry.unref(); client.on('disconnect', () => clearTimeout(expiry));
    } catch { client.disconnect(true); }
  }
  onModuleInit() { this.unsubscribe = this.events.subscribe(async id => { this.server?.to(`session:${id}`).emit(SOCKET_EVENT, await this.sessions.snapshot(id)); }); }
  onModuleDestroy() { this.unsubscribe?.(); }
  @SubscribeMessage(SOCKET_JOIN)
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      if (!body || typeof body !== 'object' || !('sessionId' in body) || typeof body.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.sessionId)) return { success: false, message: 'Invalid sessionId' };
      await this.auth.verify(client.data.token);
      const snapshot = await this.sessions.get(client.data.teacherId, body.sessionId);
      for (const room of client.rooms) if (room.startsWith('session:')) await client.leave(room);
      await client.join(`session:${body.sessionId}`);
      // Fetch after joining so a mutation between initial authorization and join is recovered.
      client.emit(SOCKET_EVENT, await this.sessions.get(client.data.teacherId, snapshot.id));
      return { success: true };
    } catch { return { success: false, message: 'Session not found or unauthorized' }; }
  }
}
