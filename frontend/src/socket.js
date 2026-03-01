import { io } from 'socket.io-client';
import { ensureAuth } from './lib/api';

const SOCKET_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const socket = io(SOCKET_URL, {
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
});

// Grab a token immediately on app load
ensureAuth().catch(console.error);

socket.on('connect',    () => console.log('WS connected'));
socket.on('disconnect', () => console.log('WS disconnected'));