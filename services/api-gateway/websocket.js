import { Server } from "socket.io";

let io;

export function initWebSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: "*" } });
  io.on("connection", (socket) => {
    console.log("WS client connected:", socket.id);
    socket.on("disconnect", () => console.log("WS disconnected:", socket.id));
  });
  console.log("WebSocket server ready");
  return io;
}

export function emitPrediction(data)      { io?.emit("prediction", data); }
export function emitApprovalNeeded(data)  { io?.emit("approval_needed", data); }
export function emitRemediationDone(data) { io?.emit("remediation_done", data); }