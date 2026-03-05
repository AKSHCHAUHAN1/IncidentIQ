import { io } from 'socket.io-client';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const socket = io(BASE, {
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
});

socket.on('connect',    () => console.log('Socket connected'));
socket.on('disconnect', () => console.log('Socket disconnected'));